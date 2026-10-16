function skillsOf(ctx) {
    return ctx.get("skills");
}
function normalizeSkillOptions(options) {
    if (options === undefined)
        return undefined;
    return typeof options === "string" ? { sessionId: options } : options;
}
export async function listSkills(ctx, options) {
    const skills = skillsOf(ctx);
    if (!skills)
        return [];
    try {
        // Web skill.list is addressed by session + cwd + scope: the host resolves
        // the session's project root and returns its user-invocable catalog.
        // Structural fallback: registries that take no options still work.
        const normalized = normalizeSkillOptions(options);
        const summaries = await skills.list(normalized === undefined ? undefined : { ...normalized });
        return summaries.map((skill) => {
            const invocation = skill.invocation;
            const modelInvocable = "model" in (invocation ?? {}) ? invocation.model !== false : invocation?.modelInvocable ?? true;
            const userInvocable = "user" in (invocation ?? {}) ? invocation.user !== false : invocation?.userInvocable ?? true;
            return {
                name: skill.name,
                description: skill.description,
                ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
                source: skill.source,
                provider: skill.provider,
                modelInvocable,
                userInvocable,
            };
        });
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=skills.js.map