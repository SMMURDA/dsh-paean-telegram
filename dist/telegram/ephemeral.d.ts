/** Text above Telegram's hard payload cap never reaches the wire from the
 * edit lane: transport.editText fails fast `false` for overlong text, which
 * used to be indistinguishable from a DEAD message here — so every refresh
 * tick dropped the tracked bubble and re-sent the whole (multi-part) payload
 * again, an unbounded flood that could never converge into one editable
 * bubble (#TL-1). Renderers clamp their cards under this ceiling; this guard
 * is the last-resort backstop for any lane whose render still overflows. */
export declare const MAX_EDIT_TEXT_LENGTH = 4096;
export interface ChatOps {
    sendText(chatId: number, text: string, options?: Record<string, unknown>): Promise<number | undefined>;
    deleteMessage(chatId: number, messageId: number): Promise<void>;
    editText(chatId: number, messageId: number, text: string, options?: Record<string, unknown>): Promise<boolean>;
    /** Highest message id sent to the chat (transport hint). Telegram ids are
     * one per-chat monotonic sequence, so `hint - anchoredId` lower-bounds how
     * many messages now sit below the anchored card bubble. Optional: callers
     * without the hint keep the edit-in-place-only behavior. */
    outgoingHint?(chatId: number): number | undefined;
}
/** When the live conversation has pushed an anchored card this many outgoing
 * messages downstream, editing it "successfully" is invisible — the bubble
 * sits above the viewport while the user reads the bottom. Past this gap a
 * replace() re-anchors instead: the stale bubble is deleted and the card is
 * sent fresh at the bottom (#bar Models/Queue taps feeling dead). */
export declare const REANCHOR_MESSAGE_GAP = 15;
export declare class Ephemeral {
    private readonly ids;
    private readonly last;
    private readonly locks;
    remember(chatId: number, messageId: number | undefined): void;
    private serialize;
    /** Delete every tracked surface for a chat (best effort). */
    clear(chatId: number, ops: ChatOps): Promise<void>;
    /** Open a fresh surface: remove the previous one first. */
    open(chatId: number, ops: ChatOps): Promise<void>;
    /** Send a tracked surface message. */
    reply(chatId: number, ops: ChatOps, text: string, options?: Record<string, unknown>): Promise<number | undefined>;
    /** Update the current card in place (instant) when possible; otherwise
     * fall back to a fresh send. Navigation never deletes before sending.
     * There is deliberately NO text/markup no-op early return: `last` may
     * point at a message deleted outside this cache, and treating the tap as
     * a no-op left the button feeling completely dead. Every tap goes through
     * editText: alive + identical → Telegram's "message is not modified" is
     * swallowed as success (transport); deleted → edit fails → state clears
     * and the card is re-sent fresh.
     *
     * A THIRD dead-tap shape is the buried bubble: the tracked message still
     * exists, every edit succeeds — but N later messages pushed it above the
     * viewport, so the user watching the bottom sees nothing move. When the
     * transport hint reports that gap, skip the pointless edit, retract the
     * stale bubble and anchor a fresh one at the bottom instead.
     *
     * A FOURTH shape is the overlong payload (#TL-1): an edit `false` caused
     * purely by text above MAX_EDIT_TEXT_LENGTH means the message is fine —
     * the CONTENT is unsendable. Re-sending cannot help (the send lane would
     * split it into parts that never re-form one editable bubble) and doing
     * so on every auto-refresh tick floods the chat. So the update is skipped
     * entirely: the tracked id stays, the old bubble keeps showing its last
     * sub-limit render, and in-place edits resume the moment the payload
     * returns under the ceiling. Checked BEFORE the burial logic: a buried
     * overlong card must not re-anchor into a multi-part resend either. */
    replace(chatId: number, ops: ChatOps, text: string, options?: Record<string, unknown>): Promise<number | undefined>;
    /** Remove one tracked message. */
    drop(chatId: number, messageId: number, ops: ChatOps): Promise<void>;
    /** Drop all in-memory tracking on plugin teardown (hot unplug / HMR). */
    reset(): void;
}
