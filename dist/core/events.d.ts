/**
 * Harness-event subscriptions for dsh-telegram.
 *
 * Forwards cordis session/host events into the bridge and the panel/card
 * refresh paths:
 *   - `session/event`: turn/end bar+card sync and incremental todo cards.
 *   - Web-forwarded (`FORWARDED_EVENT_NAMES`) and underlying host
 *     (`HOST_EVENT_NAMES`) events: refresh-only panel/card re-reads.
 *   - `session/disposed`: bounded per-session bookkeeping drops.
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. All plugin-root singletons
 * arrive through one deps object; the caller owns the disposer list.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Bridge } from "../harness/bridge.js";
import { type TodoView } from "../harness/adapters/todos.js";
/** Structural slice of the plugin-root state singleton this module reads. */
interface SessionEventsStateSlice {
    /** Chat↔agent bridge (agent→chat reverse lookups). Undefined while unmounted. */
    readonly bridge: Bridge | undefined;
}
export interface SessionEventsDeps {
    state: SessionEventsStateSlice;
    /** Latest durable todo snapshot per chat (todo/write is whole-list). */
    todoSnapshots: Map<number, TodoView[]>;
    /** Live subagent counts per agent id (dropped on session/disposed). */
    statusSubagentCounts: Map<string, number>;
    refreshActiveCards(): void;
    refreshAllPanels(): void;
    scheduleBarSync(chatId: number, delayMs?: number): void;
    notifyTodoChange(chatId: number, previous: readonly TodoView[], next: readonly TodoView[]): void;
}
/** Subscribe every harness-event forwarding listener. Returns the disposers
 * in registration order; index.ts pushes them into its teardown list so hot
 * unplug reverses exactly what this mounted. */
export declare function attachSessionEvents(ctx: Context, deps: SessionEventsDeps): (() => void)[];
export {};
