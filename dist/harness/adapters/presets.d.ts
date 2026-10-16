/**
 * Agent preset domain (web ApiProxy agentPreset.list/select/read/copy/
 * openDocument/remove) over ctx.agentPresets.
 */
import type { Context } from "@deepseek-ai/cordis";
import { type AdapterResult } from "./types.js";
export interface AgentPresetEntry {
    id: string;
    trust: "system" | "user";
    isDefault: boolean;
    name?: string;
    description?: string;
    broken?: string;
}
export declare function listAgentPresets(ctx: Context): Promise<{
    presets: AgentPresetEntry[];
    authorable: boolean;
    hasDocument: boolean;
}>;
/** agentPreset.select — allowed only while the session is blank. */
export declare function selectAgentPreset(ctx: Context, sessionId: string, presetId: string): Promise<AdapterResult>;
/** Whether the session has already produced a turn (web's sessionBlank inverse). */
export declare function sessionHasStarted(ctx: Context, sessionId: string): boolean;
/**
 * Mid-session preset switch: fork the source session through its last
 * completed turn, resume the fork as a live agent, re-link the fork to the
 * new preset, and record the selection. The CALLER closes the original
 * session and re-binds the chat to the returned child id. The blank-check
 * is deliberately bypassed here — dsh's recompose leaves that check to the
 * caller, and this is the caller's documented mid-conversation escape hatch
 * (history moves to the fork; the original is closed, so no conversation
 * continues under the old toolset).
 */
export declare function switchAgentPresetMidSession(ctx: Context, sourceSessionId: string, presetId: string): Promise<AdapterResult & {
    childId?: string;
    handle?: unknown;
}>;
export declare function readAgentPreset(ctx: Context, presetId: string): Promise<AdapterResult & {
    content?: string;
}>;
export declare function copyAgentPreset(ctx: Context, from: string, presetId: string, name?: string): Promise<AdapterResult>;
export declare function removeAgentPreset(ctx: Context, presetId: string): Promise<AdapterResult>;
/** Set the agent-presets settings default: applied to NEW sessions only. */
export declare function setDefaultAgentPreset(ctx: Context, presetId: string): Promise<AdapterResult>;
/** agentPreset.openDocument: no native opener on a phone — give the directory hint. */
export declare function openAgentPresetDocument(ctx: Context, presetId: string): AdapterResult;
