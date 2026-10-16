import type { Context } from "@deepseek-ai/cordis";
import { type AgentHandle } from "@deepseek-ai/dsh-agent";
import { type AdapterResult } from "./types.js";
export interface AttachmentRefLike {
    attachmentId: string;
    mediaType: string;
    bytes: number;
    width: number;
    height: number;
    name?: string;
}
/** session.selectModel: per-session ModelSelectionRef + default persistence. */
export declare function selectSessionModel(ctx: Context, sessionId: string, provider: string, model: string, reasoningEffort?: string): Promise<AdapterResult>;
/** session.models.current: the per-session selection or the live agent default. */
export declare function currentSessionModel(ctx: Context, sessionId: string): {
    provider?: string;
    model?: string;
    reasoningEffort?: string;
};
export declare function releaseModelSelection(sessionId: string): void;
export declare function releaseAllModelSelections(): void;
export interface QueueItem {
    itemId: string;
    target: "next-turn" | "next-step";
    text: string;
}
export type QueueAction = {
    kind: "edit";
    content: string;
} | {
    kind: "remove";
} | {
    kind: "steer";
};
/** session/queue snapshot (the web's events.mux `session/queue` frame). */
export declare function listQueue(ctx: Context, sessionId: string): QueueItem[];
/** session.updateQueue over agent.inbox (exact web semantics). */
export declare function updateQueueItem(ctx: Context, sessionId: string, itemId: string, action: QueueAction): AdapterResult;
/** session.attachment admission: promote image bytes, mirroring the web gate. */
export declare function saveImageAttachment(ctx: Context, data: Uint8Array, mediaType: string, name?: string): Promise<AdapterResult & {
    attachment?: AttachmentRefLike;
}>;
/** session.attachment read (base64, same as the web response). The web seam
 * verifies bytes against the exact durable ref, so only attachments this
 * bridge saved can be read back through Telegram. */
export declare function readImageAttachment(ctx: Context, attachmentId: string): Promise<AdapterResult & {
    data?: string;
    mediaType?: string;
}>;
/** Plugin teardown: drop the in-memory ref registry (durable refs stay). */
export declare function releaseSavedAttachments(): void;
/** session.rename over ctx.sessionTitle (the web's exact seam). */
export declare function renameSession(ctx: Context, sessionId: string, title: string): AdapterResult;
/** session.fork over ctx.sessions.fork (web semantics: boundary anchors to turn ends). */
export declare function forkSession(ctx: Context, sessionId: string, atSeq?: number): AdapterResult & {
    childId?: string;
};
/** Resume a persisted session as a live agent (session.open equivalent).
 * `inheritFrom` names the live agent whose provider/model the resumed agent
 * inherits. Without it the source is only resolvable when exactly ONE live
 * agent exists: among several, defaulting to list()[0] could inherit another
 * chat's model, so the request fails instead of guessing (🟠-17). */
export declare function resumeSession(ctx: Context, sessionId: string, inheritFrom?: string): Promise<AdapterResult & {
    agentId?: string;
    handle?: AgentHandle;
}>;
/** session.prompt: route text to queue or steer, mirroring the web modes. */
export declare function promptSession(ctx: Context, sessionId: string, text: string, mode: "queue" | "steer" | "followup"): AdapterResult;
export interface CreatedSession {
    result: AdapterResult;
    agentId?: string;
    /** Preset the new session was composed from (web session.create echo). */
    agentPreset?: string;
    /** True when no session was created because the chat already had a live
     * one (onlyIfUnbound short-circuit): the requested model was NOT applied
     * to any session, so callers must not treat this as "model set". */
    reusedLive?: boolean;
}
export interface SessionCreateOptions {
    /** Close this previously-owned session after the new one is published. */
    replaceSessionId?: string;
    /** Compose the new agent from this preset (omitted = default preset). */
    agentPreset?: string;
}
/** Delete one session entirely: dispose its live agent, drop the in-memory
 * model selection, and remove its durable session directory. There is no web
 * RPC for this — it is a Telegram-side convenience. */
export declare function deleteSession(ctx: Context, sessionId: string): Promise<AdapterResult>;
export declare class SessionLifecycle {
    /**
     * Create a session, mirroring web `session.create`:
     * - `model` (optional telegram-owned default) overrides the profile default
     *   (`ctx.agentDefaultModel.currentSelection()`), so prompt assembly always
     *   has a `{{model}}` value.
     * - `agentPreset` (optional) is resolved BEFORE the agent exists and mounted
     *   through the creation `setup` hook; the resolved id is recorded on the
     *   session header. Omitted = the roster's default preset (or no setup when
     *   the profile composes no preset roster).
     * - `replaceSessionId` (optional) names the agent THIS chat is leaving; only
     *   that agent is disposed after the new one publishes. Other chats' agents
     *   are never touched.
     */
    create(ctx: Context, cwd: string, model?: {
        provider?: string;
        model?: string;
    }, options?: SessionCreateOptions): Promise<CreatedSession>;
    /** Resolve a live agent by id (agent id === session id). */
    find(ctx: Context, agentId: string): import("@deepseek-ai/dsh-agent").Agent | undefined;
    /** Track a handle this plugin did not create (e.g. a resumed fork). The
     * model-selection ref installs here too: an adopted agent's first switch
     * must stay outermost, exactly like a created one. */
    adopt(handle: AgentHandle): void;
    /** Close (dispose) one live agent. Tracked handles are preferred; a live
     * agent this plugin adopted externally falls back to its own dispose. The
     * per-session model selection is released here so every destroy path that
     * funnels through close() drops it exactly once (`releaseModelSelection`
     * is idempotent; deleteSession claims the tracked handle through the same
     * trunk and releases the selection itself). */
    close(agentId: string, ctx?: Context): Promise<AdapterResult>;
    /** Cancel the current turn of one agent (defaults to the only live agent).
     * `keepInbox: true` preserves queued messages: only the in-flight turn is
     * aborted, the session and its pending work stay alive. With several live
     * agents the default is refused — cancelling list()[0] could kill another
     * chat's turn (🟠-17). */
    stop(ctx: Context, agentId?: string): AdapterResult;
    /** Plugin teardown: dispose every agent this plugin created or adopted. */
    dispose(): Promise<void>;
}
