export function probeCapabilities(ctx) {
    return {
        sessions: ctx.get("sessions") !== undefined,
        agents: ctx.get("agents") !== undefined,
        llm: ctx.get("llm") !== undefined,
        loader: ctx.get("loader") !== undefined,
        compaction: ctx.get("compaction") !== undefined,
        commands: ctx.get("commands") !== undefined,
        goals: ctx.get("goals") !== undefined,
        messageFeedback: ctx.get("messageFeedback") !== undefined,
        workspaceRegistry: ctx.get("workspaceRegistry") !== undefined,
        skills: ctx.get("skills") !== undefined,
        subagents: ctx.get("subagents") !== undefined,
        agentPresets: ctx.get("agentPresets") !== undefined,
        settings: ctx.get("settings") !== undefined,
        credentials: ctx.get("credentials") !== undefined,
        approval: ctx.get("approval") !== undefined,
        userQuestions: ctx.get("userQuestions") !== undefined,
        sessionTitle: ctx.get("sessionTitle") !== undefined,
        jobs: ctx.get("jobs") !== undefined,
        dynamicCordisRunner: ctx.get("dynamicCordisRunner") !== undefined,
        attachments: ctx.get("attachments") !== undefined,
        sessionPersistence: ctx.get("sessionPersistence") !== undefined,
        agentDefaultModel: ctx.get("agentDefaultModel") !== undefined,
    };
}
/** Human-readable labels used by the /capabilities card. */
export const CAPABILITY_LABELS = {
    sessions: "sessions",
    agents: "agents",
    llm: "llm",
    loader: "loader",
    compaction: "compaction",
    commands: "commands",
    goals: "goals",
    messageFeedback: "messageFeedback",
    workspaceRegistry: "workspaceRegistry",
    skills: "skills",
    subagents: "subagents",
    agentPresets: "agentPresets",
    settings: "settings",
    credentials: "credentials",
    approval: "approval",
    userQuestions: "userQuestions",
    sessionTitle: "sessionTitle",
    jobs: "jobs",
    dynamicCordisRunner: "dynamicCordisRunner",
    attachments: "attachments",
    sessionPersistence: "sessionPersistence",
    agentDefaultModel: "agentDefaultModel",
};
export function missingServices(ctx) {
    const caps = probeCapabilities(ctx);
    return Object.keys(CAPABILITY_LABELS)
        .filter((key) => !caps[key])
        .map((key) => CAPABILITY_LABELS[key]);
}
//# sourceMappingURL=capabilities.js.map