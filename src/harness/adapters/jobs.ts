/**
 * Jobs domain (web events.mux `session/jobs` frame) over ctx.jobs.
 */
import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";

export interface JobView {
  id: string;
  kind: string;
  label: string;
  status: "running" | "stopping" | "completed" | "killed" | "failed";
  detail?: string;
  startedAt: number;
  finishedAt?: number;
}

interface JobRegistryLike {
  list(caller?: unknown): JobView[];
}

function jobsOf(ctx: Context): JobRegistryLike | undefined {
  return ctx.get("jobs") as JobRegistryLike | undefined;
}

export function listJobs(ctx: Context, agentId?: string): JobView[] {
  const jobs = jobsOf(ctx);
  if (!jobs) return [];
  try {
    const caller = agentId === undefined ? undefined : ctx.agents?.get(SessionId(agentId));
    return jobs.list(caller);
  } catch {
    return [];
  }
}
