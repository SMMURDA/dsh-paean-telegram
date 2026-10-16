/**
 * Durable chat→session bindings.
 *
 * The Bridge keeps chat↔agent bindings in memory only, so every bot restart
 * silently unbound every chat: `/history` answered "none bound", and a
 * Models-card tap auto-CREATED a new session instead of switching the model
 * inside the chat's existing one ("cannot switch the model inside the session" after restarts).
 * This module mirrors the bindings to `<configRoot>/.pi/telegram-bindings.json`
 * so a remount can re-bind every chat whose session is still live.
 *
 * Bounded by design: entries expire (30 days) and the file caps at 200 chats;
 * writes are tiny and happen only on explicit bind/unbind, never per event.
 */
export interface ChatBindingEntry {
    agentId: string;
    /** Epoch ms of the last bind — expiry + LRU pruning key. */
    at: number;
}
export type ChatBindings = Record<string, ChatBindingEntry>;
export declare function bindingsFilePath(configRoot: string): string;
/** Read saved bindings; missing/corrupt file reads as empty (never throws). */
export declare function readChatBindings(configRoot: string): ChatBindings;
/** Persist one bind/unbind. Best-effort: a failed write must never break the
 * bind that caused it (bindings degrade to in-memory-only, as before). */
export declare function saveChatBinding(configRoot: string, chatId: number, agentId: string | undefined): void;
