/**
 * One live status card per chat, updated in place via editMessageText so
 * frequent refreshes never spam the conversation. Identical content is
 * skipped entirely; a deleted message falls back to a fresh send.
 */
import { ChatOps } from "./ephemeral.js";
export interface PanelOps extends ChatOps {
    editText(chatId: number, messageId: number, text: string, options?: Record<string, unknown>): Promise<boolean>;
}
export declare class StatusPanel {
    private readonly panels;
    private readonly locks;
    private serialize;
    /** Create the card on demand (Status button / command) or update it in
     * place when one already exists (live event feed). */
    refresh(chatId: number, ops: PanelOps, text: string, createIfMissing?: boolean): Promise<void>;
    /** Drop all in-memory panels on plugin teardown (hot unplug / HMR). */
    reset(): void;
}
