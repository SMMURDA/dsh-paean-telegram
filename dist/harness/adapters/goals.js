import { fail } from "./types.js";
function goalsOf(ctx) {
    return ctx.get("goals");
}
/** Resolve the current goal for one exact live agent. */
export function getGoal(ctx, agentId) {
    const goals = goalsOf(ctx);
    if (!goals)
        return undefined;
    const agent = ctx.agents?.get(agentId);
    if (!agent)
        return undefined;
    try {
        return goals.get(agent) ?? undefined;
    }
    catch {
        return undefined;
    }
}
function run(ctx, agentId, fn) {
    const goals = goalsOf(ctx);
    if (!goals)
        return fail("goals service is unavailable in this profile");
    const agent = ctx.agents?.get(agentId);
    if (!agent)
        return fail("no live agent in this session");
    try {
        const result = fn(goals, agent);
        return { ok: true, text: renderGoal(result), goal: "phase" in result ? result : undefined };
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}
function renderGoal(goal) {
    if (!("objective" in goal))
        return `\u{1F5D1} Goal cleared (revision ${goal.revision})`;
    return `\u{1F3AF} Goal ${goal.phase}/${goal.activation} \u00B7 ${goal.objective.slice(0, 80)}`;
}
export function createGoal(ctx, agentId, objective, maxGoalRounds) {
    const trimmed = objective.trim();
    if (!trimmed)
        return Promise.resolve(fail("goal objective must not be blank"));
    return Promise.resolve(run(ctx, agentId, (goals, agent) => goals.create(agent, { objective: trimmed, ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }) })));
}
export function editGoal(ctx, agentId, id, revision, request) {
    return Promise.resolve(run(ctx, agentId, (goals, agent) => goals.edit(agent, { id, revision }, request)));
}
export function pauseGoal(ctx, agentId, id, revision) {
    return Promise.resolve(run(ctx, agentId, (goals, agent) => goals.pause(agent, { id, revision })));
}
export function resumeGoal(ctx, agentId, id, revision) {
    return Promise.resolve(run(ctx, agentId, (goals, agent) => goals.resume(agent, { id, revision })));
}
export function clearGoal(ctx, agentId, id, revision) {
    return Promise.resolve(run(ctx, agentId, (goals, agent) => goals.clear(agent, { id, revision })));
}
//# sourceMappingURL=goals.js.map