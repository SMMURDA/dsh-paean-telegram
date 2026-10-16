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
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
const MAX_ENTRIES = 200;
const ENTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export function bindingsFilePath(configRoot) {
    return join(configRoot, ".pi", "telegram-bindings.json");
}
/** Read saved bindings; missing/corrupt file reads as empty (never throws). */
export function readChatBindings(configRoot) {
    let raw;
    try {
        raw = readFileSync(bindingsFilePath(configRoot), "utf8");
    }
    catch {
        return {};
    }
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null)
            return {};
        const out = {};
        for (const [key, value] of Object.entries(parsed)) {
            const chatId = Number(key);
            const agentId = value?.agentId;
            const at = value?.at;
            if (!Number.isInteger(chatId) || typeof agentId !== "string" || agentId === "")
                continue;
            out[String(chatId)] = { agentId, at: typeof at === "number" && Number.isFinite(at) ? at : 0 };
        }
        return prune(out);
    }
    catch {
        return {};
    }
}
/** TTL- and size-bound view of a bindings map (oldest entries drop first). */
function prune(bindings) {
    const cutoff = Date.now() - ENTRY_TTL_MS;
    const fresh = Object.entries(bindings).filter(([, entry]) => entry.at >= cutoff);
    fresh.sort((a, b) => b[1].at - a[1].at);
    return Object.fromEntries(fresh.slice(0, MAX_ENTRIES));
}
/** Persist one bind/unbind. Best-effort: a failed write must never break the
 * bind that caused it (bindings degrade to in-memory-only, as before). */
export function saveChatBinding(configRoot, chatId, agentId) {
    try {
        const bindings = readChatBindings(configRoot);
        if (agentId === undefined)
            delete bindings[String(chatId)];
        else
            bindings[String(chatId)] = { agentId, at: Date.now() };
        const file = bindingsFilePath(configRoot);
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(prune(bindings), null, 2)}\n`, "utf8");
        renameSync(tmp, file);
    }
    catch {
        /* best effort */
    }
}
//# sourceMappingURL=chat-bindings.js.map