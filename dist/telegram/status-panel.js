import { serializePerKey } from "./serialize-per-key.js";
export class StatusPanel {
    panels = new Map();
    locks = new Map();
    serialize(chatId, fn) {
        return serializePerKey(this.locks, chatId, fn);
    }
    /** Create the card on demand (Status button / command) or update it in
     * place when one already exists (live event feed). */
    refresh(chatId, ops, text, createIfMissing = false) {
        return this.serialize(chatId, async () => {
            const panel = this.panels.get(chatId);
            if (panel === undefined && !createIfMissing)
                return;
            if (panel?.text === text)
                return;
            if (panel?.messageId !== undefined) {
                const edited = await ops.editText(chatId, panel.messageId, text).catch(() => false);
                if (edited) {
                    panel.text = text;
                    return;
                }
                // The edit failed (the card message was deleted by hand, the chat was
                // cleared, ...): the stored id is dead and must not be retried — drop
                // the entry so live refreshes stop hammering it until the user asks
                // for the panel again (audit RE-8; mirrors Ephemeral.replace's
                // edit-failure self-healing).
                this.panels.delete(chatId);
            }
            if (!createIfMissing)
                return;
            const id = await ops.sendText(chatId, text).catch(() => undefined);
            if (id === undefined)
                return;
            this.panels.set(chatId, { messageId: id, text });
        });
    }
    /** Drop all in-memory panels on plugin teardown (hot unplug / HMR). */
    reset() {
        this.panels.clear();
        this.locks.clear();
    }
}
//# sourceMappingURL=status-panel.js.map