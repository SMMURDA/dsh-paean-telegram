/**
 * Jobs domain (web events.mux `session/jobs` frame) over ctx.jobs.
 */
import type { Context } from "@deepseek-ai/cordis";
export interface JobView {
    id: string;
    kind: string;
    label: string;
    status: "running" | "stopping" | "completed" | "killed" | "failed";
    detail?: string;
    startedAt: number;
    finishedAt?: number;
}
export declare function listJobs(ctx: Context, agentId?: string): JobView[];
