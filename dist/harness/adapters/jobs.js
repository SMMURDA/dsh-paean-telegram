import { SessionId } from "@deepseek-ai/dsh-session";
function jobsOf(ctx) {
    return ctx.get("jobs");
}
export function listJobs(ctx, agentId) {
    const jobs = jobsOf(ctx);
    if (!jobs)
        return [];
    try {
        const caller = agentId === undefined ? undefined : ctx.agents?.get(SessionId(agentId));
        return jobs.list(caller);
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=jobs.js.map