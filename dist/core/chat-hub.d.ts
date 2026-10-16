/**
 * Per-chat lifecycle hub for dsh-telegram (yellow-1 step 3).
 *
 * Single owner of every per-chat container that `teardownMount()` and
 * `ejectChat()` used to hand-enumerate — and twice leaked (review 2026-08-21
 * 🔴-8): the typing keepalive loops, the sticky turn flags and their rearm
 * budgets, the remembered menu page + card origin, the per-chat session-create
 * serialization chains, the per-chat pending prompt inputs (audit B-4r:
 * one `Map<chatId, PendingInput>` with a lazy 5-minute TTL), the
 * start-after-allow replay set, per-agent subagent counts and per-chat todo
 * snapshots. Teardown delegates to `disposeAll()` and per-chat ejection to
 * `disposeChat()`, so adding a container can no longer be forgotten at a
 * second call site.
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. Deliberately no cards/ or
 * media/ imports: already-extracted modules (core/events.ts) keep receiving
 * the containers they read as plain deps passed by index.ts, so no import
 * cycle can form. All plugin-root singletons (transport, live-feed seam,
 * ctx access) are assigned on apply and therefore arrive as late-bound dep
 * closures read at call time.
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { TodoView } from "../harness/adapters/todos.js";
import type { TelegramTransport } from "../telegram/transport.js";
/** Late-bound seams from the plugin root. Every field is read through its
 * closure only when a hub function runs, never at factory time. */
export interface ChatHubDeps {
    /** Live transport (typing keepalive needs it); undefined while unmounted. */
    getTransport(): TelegramTransport | undefined;
    /** Chat-scoped live-agent lookup backing the keepalive decision (#48). */
    currentAgent(chatId?: number): Agent | undefined;
    /** Live-feed seam (#48); a no-op until the `telegram` service mounts. */
    stopLiveFeed(chatId: number): void;
    /** Injectable clock for the pending-input TTL (tests); defaults to Date.now. */
    now?(): number;
    log(message: string, error?: unknown): void;
}
/** Keepalive decision (#48): a live agent's own status is authoritative —
 * the sticky `runningTurns` flag goes stale when a turn/end event is lost,
 * which used to re-arm the typing loop forever. The flag is only trusted
 * when no live agent can answer, and the rearm budget caps that stale path.
 * A genuinely running agent is never budget-killed: turns legitimately
 * outlast a few windows, so the budget must not fire before the agent check. */
export declare function typingKeepaliveActive(agentRunning: boolean | undefined, stickyRunning: boolean, rearmCount: number, rearmLimit?: number): boolean;
/** How long an armed free-text prompt stays valid (audit B-4r). Expiry is
 * lazy — checked on the next take/cancel for that chat — so an abandoned
 * flow can no longer hijack the chat's next ordinary message, and no timer
 * bookkeeping is needed. */
export declare const PENDING_INPUT_TTL_MS: number;
/** One armed free-text prompt. The owning chat is the `pendingInputs` Map
 * key (the former slots carried a redundant `chatId` field), so two chats
 * arming the same kind never clobber each other and arming a different kind
 * in one chat replaces that chat's previous input. */
export type PendingInput = {
    kind: "rename";
    expiresAt: number;
    sessionId: string;
} | {
    kind: "steer";
    expiresAt: number;
    sessionId: string;
} | {
    kind: "search";
    expiresAt: number;
} | {
    kind: "presetCopy";
    expiresAt: number;
    sourceId: string;
} | {
    kind: "mkdir";
    expiresAt: number;
    path: string;
}
/** Issue #50: awaiting the plugin-definition JSON reply. */
 | {
    kind: "pluginAdd";
    expiresAt: number;
} | {
    kind: "subagentPrompt";
    expiresAt: number;
    parentId: string;
    childId: string;
};
/** What an arming call site provides: the kind-specific payload without
 * `expiresAt`, which `armPending` stamps (`now() + PENDING_INPUT_TTL_MS`). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type PendingInputSpec = DistributiveOmit<PendingInput, "expiresAt">;
/** Build the per-chat lifecycle hub. Called once by index.ts; the returned
 * functions and containers close over the shared deps like the previous
 * module-scope closures did over index.ts singletons. Maps and Sets are
 * returned by reference so destructured call sites keep mutating the hub's
 * own state. */
export declare function createChatHub(deps: ChatHubDeps): {
    todoSnapshots: Map<number, TodoView[]>;
    statusSubagentCounts: Map<string, number>;
    sessionCreateChains: Map<number, Promise<unknown>>;
    menuPageIndex: Map<number, number>;
    cardOrigins: Map<number, "menu" | "bar">;
    pendingStartAfterAllow: Set<number>;
    /** Arm/consume/cancel the chat's pending free-text input (B-4r per-chat
     * store; `PENDING_INPUT_TTL_MS` expiry is evaluated lazily on take). */
    armPending(chatId: number, input: PendingInputSpec): void;
    takePending(chatId: number, kind?: PendingInput["kind"]): PendingInput | undefined;
    cancelPending(chatId: number): PendingInput["kind"] | undefined;
    typingKeepaliveActive: typeof typingKeepaliveActive;
    setTurnRunning(chatId: number, running: boolean): void;
    startTyping(chatId: number): void;
    stopTyping(chatId: number): void;
    abortChatLoops(chatId: number): void;
    disposeChat(chatId: number): void;
    disposeAll(): void;
};
export {};
