/**
 * Durable chat→session bindings.
 *
 * The Bridge keeps chat↔agent bindings in memory only, so every bot restart
 * silently unbound every chat: `/history` answered "none bound", and a
 * Models-card tap auto-CREATED a new session instead of switching the model
 * inside the chat's existing one ("无法在session里面换model" after restarts).
 * This module mirrors the bindings to `<configRoot>/.pi/telegram-bindings.json`
 * so a remount can re-bind every chat whose session is still live.
 *
 * Bounded by design: entries expire (30 days) and the file caps at 200 chats;
 * writes are tiny and happen only on explicit bind/unbind, never per event.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ChatBindingEntry {
  agentId: string;
  /** Epoch ms of the last bind — expiry + LRU pruning key. */
  at: number;
}

export type ChatBindings = Record<string, ChatBindingEntry>;

const MAX_ENTRIES = 200;
const ENTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function bindingsFilePath(configRoot: string): string {
  return join(configRoot, ".pi", "telegram-bindings.json");
}

/** Read saved bindings; missing/corrupt file reads as empty (never throws). */
export function readChatBindings(configRoot: string): ChatBindings {
  let raw: string;
  try {
    raw = readFileSync(bindingsFilePath(configRoot), "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: ChatBindings = {};
    for (const [key, value] of Object.entries(parsed)) {
      const chatId = Number(key);
      const agentId = (value as { agentId?: unknown; at?: unknown } | undefined)?.agentId;
      const at = (value as { at?: unknown } | undefined)?.at;
      if (!Number.isInteger(chatId) || typeof agentId !== "string" || agentId === "") continue;
      out[String(chatId)] = { agentId, at: typeof at === "number" && Number.isFinite(at) ? at : 0 };
    }
    return prune(out);
  } catch {
    return {};
  }
}

/** TTL- and size-bound view of a bindings map (oldest entries drop first). */
function prune(bindings: ChatBindings): ChatBindings {
  const cutoff = Date.now() - ENTRY_TTL_MS;
  const fresh = Object.entries(bindings).filter(([, entry]) => entry.at >= cutoff);
  fresh.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(fresh.slice(0, MAX_ENTRIES));
}

/** Persist one bind/unbind. Best-effort: a failed write must never break the
 * bind that caused it (bindings degrade to in-memory-only, as before). */
export function saveChatBinding(configRoot: string, chatId: number, agentId: string | undefined): void {
  try {
    const bindings = readChatBindings(configRoot);
    if (agentId === undefined) delete bindings[String(chatId)];
    else bindings[String(chatId)] = { agentId, at: Date.now() };
    const file = bindingsFilePath(configRoot);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(prune(bindings), null, 2)}\n`, "utf8");
    renameSync(tmp, file);
  } catch {
    /* best effort */
  }
}
