/**
 * Compact turn-receipt renderer, shared by the harness-feed streaming
 * extension and the core goal-progress card. The user contract: after a task
 * finishes, the activity card collapses into the one-line summary format,
 * including the cache hit rate line.
 */
import type { StatusStats } from "../harness/adapters/status.js";
export interface TokenFold {
    uncachedInputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}
export interface TurnReceipt {
    durationMs: number;
    reasoningSteps?: number;
    toolCalls?: number;
    tokens?: TokenFold;
    sessionStats?: StatusStats;
    /** Goal title prefix: `✅ <objective>` instead of the generic header. */
    goalObjective?: string;
}
/** Compact receipt (issue #21): ONE line of the five user-facing
 * metrics — duration, thoughts, tools, turns/steps, cache hit. Token billing
 * and performance segments stay internal; editText hit rate is logged by the
 * renderer instead of being shown to the user. */
export declare function renderTurnReceipt(receipt: TurnReceipt): string;
