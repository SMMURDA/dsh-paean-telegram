/**
 * Goal progress feed for long-running autonomous /goal turns.
 *
 * One control-lane card per chat is created on turn/start (only when no
 * streaming renderer owns presentation), updated on every step/tool event,
 * and collapsed at turn/end into the turn receipt — including the
 * cache hit-rate line. The feed is pure bookkeeping + render; all Telegram
 * effects go through the injected ops.
 */
import type { StatusStats } from "../harness/adapters/status.js";
import type { TodoView } from "../harness/adapters/todos.js";
export interface ProgressGoal {
    objective: string;
}
export interface ProgressOps {
    send(chatId: number, text: string, options: Record<string, unknown>): Promise<number | undefined>;
    edit(chatId: number, messageId: number, text: string, options: Record<string, unknown>): Promise<boolean>;
}
export interface ProgressDeps {
    ops: ProgressOps;
    log: (message: string, error?: unknown) => void;
    chatIdForAgent(agentId: string): number | undefined;
    goalFor(chatId: number): ProgressGoal | undefined;
    todosFor(chatId: number): readonly TodoView[];
    statusStats(chatId: number): StatusStats | undefined;
    /** The harness-feed streaming renderer owns presentation while mounted. */
    liveRendererActive(): boolean;
    pendingInbound(chatId: number): boolean;
    /** Long-task notification switches (`notify.on*`, default true). */
    notifyOnComplete?(): boolean;
    notifyOnLongTask?(): boolean;
}
export interface ProgressSnapshot {
    objective: string;
    turn: number;
    step: number;
    tools: number;
    currentTool?: string;
    elapsedMs: number;
    todosDone: number;
    todosTotal: number;
}
/** Structural subset of the host context this feed needs (audit R3-6):
 * register one event listener and receive its disposer. Keeps the telegram
 * layer decoupled from the cordis `Context` type — any object with a
 * compatible `on` satisfies it, including plain test doubles. */
export interface ProgressContext {
    on(event: string, listener: (...args: never[]) => unknown): () => void;
}
/** Long tools can be silent for a while: heartbeat every 30s so the elapsed
 * timer keeps moving and the user sees the task is alive (issue #18). Shared
 * with the streaming feed's activity-card heartbeat. */
export declare const LIVENESS_HEARTBEAT_MS = 30000;
export declare class GoalProgressFeed {
    private readonly deps;
    private readonly running;
    private dispose;
    constructor(deps: ProgressDeps);
    attach(ctx: ProgressContext): void;
    detach(): void;
    snapshot(chatId: number): ProgressSnapshot | undefined;
    private record;
    private renderRunning;
    private schedule;
    /** Periodic liveness edit: even with no new session events the card's
     * elapsed timer advances, so a long silent tool never looks frozen. */
    private armHeartbeat;
    private sendCard;
    private editCard;
    private finalize;
}
