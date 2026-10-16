/**
 * Context-pressure compaction watcher (issue #8).
 *
 * The dsh profile has no dedicated `context_tokens` service in rc.6, so the
 * watcher reads the authoritative durable sources: `request/context` gives the
 * model context window and each stream's `usage` gives the latest request
 * input size. On step end it compares the ratio against `compact.threshold`
 * and either compacts (auto) or asks once (ask); a successful compaction is
 * announced from the durable compaction/summary + compaction/end pair.
 */
import type { Context } from "@deepseek-ai/cordis";
export interface CompactionUsage {
    used?: number;
    window?: number;
    ratio?: number;
}
export interface CompactionWatcherDeps {
    ctx: Context;
    log: (message: string, error?: unknown) => void;
    chatIdForAgent(agentId: string): number | undefined;
    threshold(): number;
    policy(): "auto" | "ask" | "never";
    cooldownMs(): number;
    /** Ask the user (one inline card per session until answered/compacted). */
    askApproval(chatId: number, sessionId: string, usage: CompactionUsage): void;
    notify(chatId: number, text: string): void;
    now?: () => number;
}
interface EventLike {
    type?: string;
    data?: {
        contextWindow?: number;
        chunk?: {
            type?: string;
            usage?: TokenUsageLike;
        };
        usage?: TokenUsageLike;
        shadowedTokenCount?: number;
        summary?: readonly {
            type?: string;
            text?: string;
        }[];
        error?: string;
    };
}
interface TokenUsageLike {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}
interface AgentLike {
    id: unknown;
    session?: unknown;
    options?: {
        provider?: string;
        model?: string;
    };
}
export interface ContextUsageSource {
    /** Legacy seam (unit tests): the log handed over directly. */
    events?: readonly EventLike[];
    /** Real agent: the log lives on its session. */
    session?: unknown;
    options?: {
        provider?: string;
        model?: string;
    };
}
/** Pure threshold predicate: triggers once per cooldown window. */
export declare function shouldCompact(used: number, window: number, threshold: number, lastTriggerAt: number | undefined, now: number, cooldownMs: number): boolean;
/** Read the latest durable context facts for one live agent. */
export declare function contextUsageOf(agent: AgentLike | undefined): CompactionUsage;
export declare class CompactionWatcher {
    private readonly deps;
    private readonly states;
    private dispose;
    private disposeSession;
    constructor(deps: CompactionWatcherDeps);
    attach(): void;
    detach(): void;
    /** User answered the approval card: compact on the next idle boundary. */
    approve(sessionId: string): void;
    snooze(sessionId: string): void;
    private record;
    private agentFor;
    private state;
    private runAuto;
}
export {};
