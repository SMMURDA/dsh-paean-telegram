/**
 * The harness<->telegram coupling point:
 * inbound text -> per-chat agent inbox, session events -> that chat.
 *
 * Each Telegram chat owns one dsh agent binding. Inbound text from chat N
 * goes to chat N's agent, and session events are routed back to chat N by
 * looking up the agent id — chats never share turns or steal each other's
 * final replies. `chatStates` plus the `chatByAgent` reverse index are the
 * single source of truth; a `lastTouch` pointer derives the "most recently
 * touched" compatibility view for plugins and callers that only need one
 * active conversation.
 */
import type { Context } from "@deepseek-ai/cordis";
import { type TelegramConfig } from "../config.js";
import type { TelegramTransport } from "../telegram/transport.js";
/** User-facing rendering of one turn failure (issue #37): classify the tone
 * instead of forwarding the provider literal - a 429 is transient (the user
 * should wait), a 5xx is provider-side breakage, anything else stays verbatim.
 * Returns Telegram HTML. */
export declare function formatTurnFailure(failure: string): string;
export interface BridgeOptions {
    ctx: Context;
    transport: TelegramTransport;
    getConfig: () => TelegramConfig;
    onStateChange: () => void;
    /** Turn lifecycle for chat indicators: running=true on turn/start, false on turn/end. */
    onTurnRunning?: (chatId: number, running: boolean) => void;
    /** Called after a final assistant text message landed, so the host can add
     * feedback buttons without the bridge knowing any Telegram keyboard UI. */
    onAssistantDelivered?: (chatId: number, telegramMessageId: number, sessionId: string, assistantMessageId: string) => void;
    /** Durable-binding mirror (core/chat-bindings.ts): fired on every explicit
     * bindAgent so a remount can restore chat→session bindings that otherwise
     * died with the process ("none bound" / model tap auto-creating a session
     * after restarts). */
    onBind?: (chatId: number, agentId: string | undefined) => void;
    log: (message: string, error?: unknown) => void;
}
interface Inbound {
    chatId: number;
    text: string;
    /** Telegram message_id of the user message; final replies quote it. */
    messageId?: number;
    replied: boolean;
    noReply: boolean;
}
export declare class Bridge {
    private readonly ctx;
    private readonly transport;
    private readonly getConfig;
    private readonly onStateChange;
    private readonly onTurnRunning;
    private readonly onAssistantDelivered;
    private readonly onBind;
    private readonly log;
    private readonly disposers;
    private readonly chatStates;
    /** Reverse index: agent id -> owning chat. Maintained in lockstep with
     * `chatStates` by every mutation point (touch/bindAgent/detach); one agent
     * maps to at most one chat, so `chatIdForAgent` stays O(1) on the hot
     * session/event path. */
    private readonly chatByAgent;
    /** Dropped-event diagnostics: one line per unbound agent, plus every
     * turn/end so a missing final delivery is visible in the log. */
    private readonly droppedEvents;
    /** Most recently touched chat/agent — compatibility view, not the routing
     * source of truth. Session events are routed through `chatStates`.
     * `setCurrentAgent` without an active chat keeps just the agent half. */
    private lastTouch;
    private assistantConsumer;
    /** Active chat id for stream plugins (official session/event consumers). */
    activeChatValue(): number | undefined;
    constructor(options: BridgeOptions);
    /** Resolve the agent for a chat. A bound chat always wins; when that bound
     * agent is no longer live we return undefined so its chat can create a new
     * session instead of accidentally borrowing another chat's live agent.
     * Callers with no chat keep the legacy first-live-agent fallback. */
    private resolveAgent;
    private touch;
    private notifyStateChange;
    /** Bind (or clear) the agent owned by one Telegram chat. */
    bindAgent(chatId: number, agentId: string | undefined): void;
    /** Legacy single-binding setter; when a chat is active it updates that
     * chat's binding as well. */
    setCurrentAgent(agentId: string | undefined): void;
    currentAgentIdValue(): string | undefined;
    agentIdForChat(chatId: number): string | undefined;
    chatIdForAgent(agentId: string): number | undefined;
    private inboundFor;
    /** Pending inbound owned by the agent that is about to call `telegram_reply`.
     * Tool calls know their caller agent; routing through that id keeps chat A's
     * reply out of chat B even when B was the most recently touched chat. */
    inboundForAgent(agentId: string): Inbound | undefined;
    /** Route one inbound user text into that chat's agent inbox. */
    deliver(chatId: number, text: string, messageId?: number): {
        ok: boolean;
        text: string;
    };
    /** Deliver a media-group batch as ONE inbound turn (issue #9). */
    deliverImages(chatId: number, attachments: readonly {
        attachmentId: string;
        mediaType: string;
        bytes: number;
        width: number;
        height: number;
        name?: string;
    }[], caption?: string, messageId?: number): {
        ok: boolean;
        text: string;
    };
    /** Deliver one promoted image as the inbound turn (session.attachment path). */
    deliverImage(chatId: number, attachment: {
        attachmentId: string;
        mediaType: string;
        bytes: number;
        width: number;
        height: number;
        name?: string;
    }, caption?: string, messageId?: number): {
        ok: boolean;
        text: string;
    };
    /** Shared inbound-turn pipeline behind deliver()/deliverImage(): resolve
     * the chat's agent, bind the chat and install the inbound quote BEFORE the
     * agent can emit anything (a synchronous turn/start or assistant/message
     * must already know its chat and quote target), then enqueue the turn. */
    private deliverContent;
    /** Bot-API send options that quote the current inbound message when it
     * belongs to `chatId` (Telegram's native reply affordance). */
    private replyParametersFor;
    /** telegram_reply / telegram_send entry point. */
    sendOutbound(chatId: number, text: string, options?: {
        replyToInbound?: boolean;
        parseMode?: "HTML";
        disableNotification?: boolean;
    }): Promise<void>;
    /** Telegram message id of the pending inbound for a chat. */
    inboundMessageIdValue(chatId?: number): number | undefined;
    markNoReply(reason?: string, chatId?: number): {
        ok: boolean;
        text: string;
    };
    hasPendingInbound(chatId?: number): boolean;
    /** Live feed switch (`outbound.liveFeed`): when false, stream-renderer
     * plugins are ignored and the built-in immediate forwarding is restored
     * without unloading or re-registering the plugin. */
    private liveFeedEnabled;
    /** Stream-renderer plugin seam: when a consumer is registered the core
     * forwards assistant text blocks to it instead of the chat and defers the
     * inbound-answered bookkeeping to the consumer. No consumer = the built-in
     * immediate forwarding, byte-for-byte the pre-plugin behavior. */
    setAssistantConsumer(consumer: ((chatId: number, text: string, assistantMessageId?: string) => void) | undefined): void;
    /** Whether a live-feed renderer currently owns presentation (goal progress
     * cards must not duplicate the streaming feed's draft). */
    hasAssistantConsumer(): boolean;
    /** Renderer plugins call this after delivering the final answer for a chat. */
    markInboundReplied(chatId?: number): void;
    currentInbound(): Inbound | undefined;
    private logDroppedEvent;
    attach(): void;
    detach(): void;
}
export {};
