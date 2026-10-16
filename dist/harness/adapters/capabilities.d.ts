/**
 * Capability matrix: probes which web-backing host services are composed.
 * This is a display matrix for the /capabilities card only (plus its
 * missing-services hint) — adapters do NOT consult it first; each one
 * degrades on its own via an optional `ctx.get` lookup when a headless
 * profile lacks a service. CAPABILITY_LABELS is accordingly just an identity
 * map that renders the matrix keys on the card.
 */
import type { Context } from "@deepseek-ai/cordis";
export interface CapabilityMatrix {
    sessions: boolean;
    agents: boolean;
    llm: boolean;
    loader: boolean;
    compaction: boolean;
    commands: boolean;
    goals: boolean;
    messageFeedback: boolean;
    workspaceRegistry: boolean;
    skills: boolean;
    subagents: boolean;
    agentPresets: boolean;
    settings: boolean;
    credentials: boolean;
    approval: boolean;
    userQuestions: boolean;
    sessionTitle: boolean;
    jobs: boolean;
    dynamicCordisRunner: boolean;
    attachments: boolean;
    sessionPersistence: boolean;
    agentDefaultModel: boolean;
}
export declare function probeCapabilities(ctx: Context): CapabilityMatrix;
/** Human-readable labels used by the /capabilities card. */
export declare const CAPABILITY_LABELS: Readonly<Record<keyof CapabilityMatrix, string>>;
export declare function missingServices(ctx: Context): string[];
