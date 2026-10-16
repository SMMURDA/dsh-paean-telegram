import type { Context } from "@deepseek-ai/cordis";
/** Whole-session figures mirrored from the web stats strip sources:
 * `sessionStats` + `tokenUsage` projections, plus a live tool-call counter. */
export interface StatusStats {
    turns: number;
    steps: number;
    toolCalls: number;
    llmMs: number;
    toolMs: number;
    ttftMs: number;
    ttftSteps: number;
    decodeMs: number;
    decodeTokens: number;
    uncachedInputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}
export interface StatusSnapshot {
    agentId?: string;
    status: "idle" | "running" | "none";
    provider?: string;
    model?: string;
    /** Reasoning effort of the live selection (web session.models.current). */
    reasoningEffort?: string;
    /** Agent preset in effect (web resolveSessionPreset: latest
     * agent-preset/selected event, falling back to the session header). */
    preset?: string;
    queue: number;
    sessions: number;
    /** Present when any stats source contributed a number (web profile). */
    stats?: StatusStats;
}
/** Increment the bound session's tool-call counter (called from the bridge). */
export declare function noteToolCall(sessionId: string): void;
/** Drop in-memory stats counters on hot unplug / re-mount. */
export declare function resetStatusStats(): void;
/** Session disposal cleanup (LOOP_AUDIT #8): the live tool-call counter must
 * not accumulate entries for every session the bot ever touched. */
export declare function forgetStatusSession(sessionId: string): void;
/** One-line variant for the turn-end summary (receipt stats segment):
 * `📊 4 turns · 279 steps | ⚡ LLM 46m41s · Tool time 5m10s | 🎯 First token avg 3.5s · 68 tok/s` */
export declare function renderStatsLine(stats: StatusStats): string | undefined;
/** Conversation stats, multi-line grouped: turn/step, durations, speeds,
 * cache hit, and tokens. Shared by the status card and the streamed draft
 * finalization. */
export declare function renderStatsStrip(stats: NonNullable<ReturnType<typeof statusSnapshot>["stats"]>): string | undefined;
export declare function statusSnapshot(ctx: Context, preferAgentId?: string, fallbackToFirst?: boolean): StatusSnapshot;
