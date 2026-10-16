/**
 * Telegram Bot API access, following the official docs:
 *
 * - getUpdates long polling with `allowed_updates` narrowed to `message` and
 *   `callback_query` so the bot never pays for update kinds it does not use;
 * - HTML parse mode with all user content escaped upstream;
 * - every outbound call flows through the per-chat serial + global rate-limit
 *   queue, so the dsh agent loop is never blocked by network I/O.
 */
import { Bot, type Api } from "grammy";
import { SendQueue } from "./queue.js";
export type UnsupportedMediaKind = "document" | "voice" | "video";
export interface TransportHandlers {
    onText: (chatId: number, text: string, messageId?: number) => void | Promise<void>;
    onPhoto: (chatId: number, fileId: string, caption: string, messageId?: number) => void | Promise<void>;
    /** Media-group batches arrive as several message updates with one
     * `media_group_id`; the router gets one ordered batch per group. */
    onPhotos?: (chatId: number, photos: readonly {
        fileId: string;
        caption: string;
        messageId?: number;
    }[], groupId?: string) => void | Promise<void>;
    onCallback: (chatId: number, data: string) => void | Promise<void>;
    /** Voice is transcribed (when configured), other documents are saved to
     * the session attachments directory. */
    onDocument?: (chatId: number, kind: UnsupportedMediaKind, fileId: string, name: string, mimeType: string, messageId?: number) => void | Promise<void>;
}
export interface TransportOptions {
    token: string;
    queue?: SendQueue;
    maxMessageLength?: number;
    log?: (message: string, error?: unknown) => void;
    /** Injectable backoff timer (tests observe/advance polling delays). */
    sleep?: (ms: number) => Promise<void>;
}
type SendOptions = NonNullable<Parameters<Api["sendMessage"]>[2]>;
type EditOptions = NonNullable<Parameters<Api["editMessageText"]>[3]>;
/** Bot API callback_query has no top-level `chat`; the chat lives on
 * `callback_query.message.chat`. Extracted so a unit test can lock this —
 * reading `callback.chat` silently dropped every inline tap (spinner stuck). */
export declare function callbackUpdateChatId(callback: {
    chat?: {
        id?: number;
    };
    message?: {
        chat?: {
            id?: number;
        };
    };
}): number | undefined;
export declare class TelegramTransport {
    readonly bot: Bot;
    readonly api: Api;
    private readonly queue;
    private maxMessageLength;
    private readonly log;
    private readonly sleep;
    /** UI/control lane key: navigation cards, bar swaps and command acks must
     * never queue behind assistant streaming edits (issues #11/#12). */
    private static controlKey;
    private handlers;
    private me;
    private polling;
    private starting;
    /** Bumped on every stop so a start that was awaiting an old generation
     * can detect a stop that arrived while it was waiting. */
    private stopGeneration;
    private pollAbort;
    private pollLoop;
    /** Last confirmed update id; preserved across stop/start generations so a
     * hot restart never asks Telegram to redeliver an already-seen batch. */
    private pollOffset;
    /** Consecutive 409 "terminated by other getUpdates" failures. The loop
     * backs off instead of spamming and stops logging every single conflict. */
    private conflict409;
    /** Consecutive non-409 polling failures (502/timeout/network). Same
     * exponential backoff: the first failure logs, later ones stay quiet until
     * one successful poll resets the meter. */
    private pollingErrors;
    constructor(options: TransportOptions);
    setHandlers(handlers: TransportHandlers): void;
    /** Hot-update rate limits and payload length without restarting polling. */
    applyLimits(options: {
        maxPerWindow?: number;
        retry?: {
            attempts: number;
            baseDelayMs: number;
        };
        maxMessageLength?: number;
    }): void;
    /** Route one raw update through the registered handlers. Callbacks are
     * answered first so the Telegram client stops showing the spinner. */
    private handleUpdate;
    /** Route one photo batch (single or media group). Legacy single-photo
     * consumers keep working when no `onPhotos` handler is mounted. */
    private handlePhotos;
    /** Own getUpdates loop with per-call timeout and automatic reconnect:
     * grammY's bot.start() silently dies on one network error (no way to
     * observe it), which surfaced as the bot going mute. This loop never
     * stops unless stop() is called.
     *
     * start/stop are restart-safe: starting aborts and awaits any previous
     * generation first, so a hot re-apply can never have two in-flight
     * getUpdates requests on the same bot token (the 409 "terminated by other
     * getUpdates request" failure). */
    start(): Promise<void>;
    /** Stop the current polling generation and wait for its in-flight request
     * to settle so an immediate restart never overlaps getUpdates calls. */
    stop(): Promise<void>;
    /** Download one photo through the Bot API file endpoint. Both the metadata
     * call and the byte download are bounded: a hung connection must not wedge
     * the chat's inbound lane forever. */
    downloadFile(fileId: string): Promise<Uint8Array | undefined>;
    /** Shared body for the four binary-media senders below: identical queueing,
     * timeout and HTML-caption handling — only the Bot API method differs.
     * Called through the computed member access so grammY's Api keeps its
     * receiver (the methods read `this.raw`). */
    private sendMedia;
    /** Send a document (session-log ZIPs and other host artifacts). */
    sendDocument(chatId: number, buffer: Uint8Array, filename: string, caption?: string): Promise<number | undefined>;
    /** Send saved image bytes back to the chat (session.attachment read-back). */
    sendPhoto(chatId: number, buffer: Uint8Array, filename: string, caption?: string): Promise<number | undefined>;
    /** Send an OGG/OPUS voice note (agent outbound attachments, issue #25). */
    sendVoice(chatId: number, buffer: Uint8Array, filename: string, caption?: string): Promise<number | undefined>;
    /** Send an audio track (mp3/m4a/... — agent outbound attachments, #25). */
    sendAudio(chatId: number, buffer: Uint8Array, filename: string, caption?: string): Promise<number | undefined>;
    /** Remove/replace an inline keyboard in place (approval/question settles). */
    editReplyMarkup(chatId: number, messageId: number, markup: unknown): Promise<boolean>;
    /** Pending sends per chat + total — surfaced by the status card. */
    pending(): number;
    botInfo(): Promise<{
        id: number;
        username: string;
    } | undefined>;
    setCommands(commands: {
        command: string;
        description: string;
    }[]): Promise<void>;
    /** Telegram's native menu button (next to the input field) opens the bot
     * command list in supported clients — a second, official entry point that
     * does not depend on the persistent reply-keyboard bar. */
    setMenuButtonToCommands(chatId: number): Promise<void>;
    /** Set the bot-WIDE default menu button to the commands type. Unlike the
     * per-chat variant above, no chat_id means every chat (present and future)
     * inherits it unless a per-chat override exists — so a fresh mount fixes
     * the menu button everywhere without waiting for each chat's /start. */
    setDefaultMenuButtonToCommands(): Promise<void>;
    /** Send one split text payload through the requested per-chat lane, with
     * success/failure logged on every attempt so a dropped reply can never be
     * silent again (#11). */
    private sendTextLane;
    /** Highest message id this transport has SENT to the chat. Telegram ids are
     * one monotonic per-chat sequence shared by incoming and outgoing traffic,
     * so the distance between an anchored card bubble and this hint lower-bounds
     * how far downstream conversation has pushed it — the signal Ephemeral uses
     * to re-anchor a card that edits "successfully" somewhere far off-screen
     * (bar taps feeling dead while the card morphs above the viewport). */
    private readonly lastSentIds;
    private noteSent;
    lastOutgoingMessageId(chatId: number): number | undefined;
    sendText(chatId: number, text: string, options?: SendOptions): Promise<number | undefined>;
    /** UI messages ride their own control lane so cards/acks stay responsive
     * while assistant output streams (issues #11/#12, bar latency report). */
    sendTextControl(chatId: number, text: string, options?: SendOptions): Promise<number | undefined>;
    sendWithBar(chatId: number, text: string, options?: SendOptions): Promise<number | undefined>;
    private editTextLane;
    editText(chatId: number, messageId: number, text: string, options?: EditOptions): Promise<boolean>;
    editTextControl(chatId: number, messageId: number, text: string, options?: EditOptions): Promise<boolean>;
    private deleteMessageLane;
    deleteMessage(chatId: number, messageId: number): Promise<void>;
    deleteMessageControl(chatId: number, messageId: number): Promise<void>;
    sendChatAction(chatId: number, action: "typing"): Promise<void>;
    sendChatActionControl(chatId: number, action: "typing"): Promise<void>;
    private sendChatActionLane;
    /** Last-resort raw Bot API send for critical command acks: if the queued
     * grammY call exhausts retries, one direct HTTPS attempt still runs (#11). */
    sendTextFallback(chatId: number, text: string, options?: SendOptions): Promise<number | undefined>;
}
export {};
