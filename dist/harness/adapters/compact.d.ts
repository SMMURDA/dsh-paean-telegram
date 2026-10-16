/**
 * Manual compaction through the host-provided `ctx.compaction` engine — the
 * exact seam `/compact` uses, so behavior stays consistent with the harness.
 */
import type { Context } from "@deepseek-ai/cordis";
import { type AdapterResult } from "./types.js";
export declare function compactCurrent(ctx: Context, agentId?: string): Promise<AdapterResult>;
