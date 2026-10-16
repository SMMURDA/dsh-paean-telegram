/**
 * Transient navigation surfaces (menus, pickers, cards) are tracked per chat
 * so navigation can update the live card IN PLACE via editMessageText —
 * page switches and reopenings render instantly with no delete+resend round
 * trip. Grammy errors are treated as final (the message is already gone),
 * network errors keep the id for a later sweep so no permanent ghost cards.
 */
import { GrammyError } from "grammy";
import { TELEGRAM_MAX_MESSAGE_LENGTH } from "../config.js";
import { serializePerKey } from "./serialize-per-key.js";
/** Text above Telegram's hard payload cap never reaches the wire from the
 * edit lane: transport.editText fails fast `false` for overlong text, which
 * used to be indistinguishable from a DEAD message here — so every refresh
 * tick dropped the tracked bubble and re-sent the whole (multi-part) payload
 * again, an unbounded flood that could never converge into one editable
 * bubble (#TL-1). Renderers clamp their cards under this ceiling; this guard
 * is the last-resort backstop for any lane whose render still overflows. */
export const MAX_EDIT_TEXT_LENGTH = TELEGRAM_MAX_MESSAGE_LENGTH;
/** When the live conversation has pushed an anchored card this many outgoing
 * messages downstream, editing it "successfully" is invisible — the bubble
 * sits above the viewport while the user reads the bottom. Past this gap a
 * replace() re-anchors instead: the stale bubble is deleted and the card is
 * sent fresh at the bottom (#bar Models/Queue taps feeling dead). */
export const REANCHOR_MESSAGE_GAP = 15;
export class Ephemeral {
    ids = new Map();
    last = new Map();
    locks = new Map();
    remember(chatId, messageId) {
        if (messageId === undefined)
            return;
        let set = this.ids.get(chatId);
        if (!set)
            this.ids.set(chatId, (set = new Set()));
        set.add(messageId);
        this.last.set(chatId, messageId);
    }
    serialize(chatId, fn) {
        return serializePerKey(this.locks, chatId, fn);
    }
    /** Delete every tracked surface for a chat (best effort). */
    clear(chatId, ops) {
        return this.serialize(chatId, async () => {
            const set = this.ids.get(chatId);
            if (!set || set.size === 0)
                return;
            const keep = new Set();
            await Promise.all([...set].map(async (id) => {
                try {
                    await ops.deleteMessage(chatId, id);
                }
                catch (err) {
                    if (!(err instanceof GrammyError))
                        keep.add(id);
                }
            }));
            const lastId = this.last.get(chatId);
            if (lastId !== undefined && !keep.has(lastId)) {
                this.last.delete(chatId);
            }
            if (keep.size > 0)
                this.ids.set(chatId, keep);
            else
                this.ids.delete(chatId);
        });
    }
    /** Open a fresh surface: remove the previous one first. */
    open(chatId, ops) {
        return this.clear(chatId, ops);
    }
    /** Send a tracked surface message. */
    reply(chatId, ops, text, options) {
        return this.serialize(chatId, async () => {
            try {
                const id = await ops.sendText(chatId, text, options);
                this.remember(chatId, id);
                return id;
            }
            catch {
                return undefined;
            }
        });
    }
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
    replace(chatId, ops, text, options) {
        return this.serialize(chatId, async () => {
            const current = this.last.get(chatId);
            if (current !== undefined) {
                if (text.length > MAX_EDIT_TEXT_LENGTH) {
                    return current;
                }
                const hint = ops.outgoingHint?.(chatId);
                const buried = hint !== undefined && hint - current > REANCHOR_MESSAGE_GAP;
                let edited = false;
                if (!buried) {
                    edited = await ops.editText(chatId, current, text, options).catch(() => false);
                }
                if (edited) {
                    return current;
                }
                this.last.delete(chatId);
                if (buried) {
                    // Retract the far-above bubble so no ghost card lingers in history;
                    // best effort exactly like clear()'s sweep.
                    try {
                        await ops.deleteMessage(chatId, current);
                    }
                    catch {
                        /* already gone */
                    }
                    const set = this.ids.get(chatId);
                    if (set !== undefined) {
                        set.delete(current);
                        if (set.size === 0)
                            this.ids.delete(chatId);
                    }
                }
            }
            const id = await ops.sendText(chatId, text, options);
            this.remember(chatId, id);
            return id;
        });
    }
    /** Remove one tracked message. */
    async drop(chatId, messageId, ops) {
        await this.serialize(chatId, async () => {
            try {
                await ops.deleteMessage(chatId, messageId);
            }
            catch {
                /* already gone */
            }
            const set = this.ids.get(chatId);
            if (set) {
                if (this.last.get(chatId) === messageId) {
                    this.last.delete(chatId);
                }
                set.delete(messageId);
                if (set.size === 0)
                    this.ids.delete(chatId);
            }
        });
    }
    /** Drop all in-memory tracking on plugin teardown (hot unplug / HMR). */
    reset() {
        this.ids.clear();
        this.last.clear();
        this.locks.clear();
    }
}
//# sourceMappingURL=ephemeral.js.map