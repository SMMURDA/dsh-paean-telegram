/**
 * Subagent domain (web ApiProxy subagent.list/history/prompt/interrupt) over
 * ctx.subagents.
 */
import type { Context } from "@deepseek-ai/cordis";
import { type AdapterResult } from "./types.js";
export interface SubagentEntry {
    id: string;
    kind: "child" | "diagnostic";
    activity: "running" | "inactive";
    /** One-shot terminal child or resumable conversation (web catalog row). */
    mode?: "one-shot" | "continuable";
    label?: string;
    hasChildren?: boolean;
    reason?: "corrupt" | "unsupported" | "unavailable";
    /** Web catalog row fact: whether the parent session still has a live agent
     * (prompt/interrupt need it). */
    parentAvailable?: boolean;
}
export declare function listSubagents(ctx: Context, parentSessionId: string): Promise<SubagentEntry[]>;
export declare function subagentHistory(ctx: Context, childSessionId: string, limit?: number): Promise<import("./session-read.js").HistoryItem[]>;
export declare function promptSubagent(ctx: Context, parentSessionId: string, childSessionId: string, text: string, options?: {
    clientTimeZone?: string;
    signal?: AbortSignal;
}): Promise<AdapterResult>;
/** IA-1 #4 (audit: "interrupt lacks target validation"): unlike promptSubagent, the
 * interrupt path used to forward any id pair straight into
 * subagents.interrupt with no target validation at all. Fail closed on
 * every gap: blank/malformed ids, a parent without a live agent, a child
 * not listed under that parent in the live catalog, and non-child
 * (diagnostic) rows. Only a verified live child under the named parent is
 * interruptible; continuable one-shot children stay interruptible because
 * stopping them is exactly what interrupt is for. */
export declare function interruptSubagent(ctx: Context, parentSessionId: string, childSessionId: string): Promise<AdapterResult>;
