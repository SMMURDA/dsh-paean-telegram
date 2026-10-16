/**
 * Read-only session queries: list (live + persisted roster), search, flat
 * history windows, and turn-grouped trajectory views — mirroring the web
 * ApiProxy `sessions` domain over the host seams (`ctx.sessions`,
 * `ctx.sessionTitle`, `ctx.sessionPersistence`).
 *
 * This module is also the dependency root of the sessions family: the
 * structural event/session shapes and the `ctx` seam accessors shared with
 * session-lifecycle.ts live here and are exported within the family only
 * (the public barrel in sessions.ts re-exports just the query API).
 */
import type { Context } from "@deepseek-ai/cordis";
import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionDetail } from "./session-render.js";
/** One event as read from a live or persisted session log (structural). */
export interface SessionEventLike {
    seq: number;
    type: string;
    /** Event timestamp on current dsh (`SessionEvent.time`). */
    time?: number;
    /** Legacy timestamp field: seams written before the `time` rename. */
    at?: number;
    data?: Record<string, unknown>;
}
export interface SessionLike {
    id: SessionId;
    /** Legacy shape: releases before dsh 0.2 exposed the log as an array. */
    events?: readonly SessionEventLike[];
    /** Current dsh `Session`: the log is materialized through this method. */
    snapshotEvents?: () => readonly SessionEventLike[];
    header?: {
        cwd?: string;
    };
}
export interface SessionTitleServiceLike {
    get(session: SessionLike): {
        title: string;
        eventSeq: number;
    } | undefined;
    rename(session: SessionLike, title: string): {
        title: string;
        eventSeq: number;
    };
}
export interface AgentLike {
    id: SessionId;
    session: SessionLike;
    options?: {
        provider?: string;
        model?: string;
    };
    status?: string;
}
export declare function agentsOf(ctx: Context): {
    list(): AgentLike[];
    get(id: SessionId): AgentLike | undefined;
    create(options: {
        sessionId: SessionId;
        meta?: {
            cwd?: string;
            agentPreset?: string;
        };
        agentOptions?: {
            provider?: string;
            model?: string;
        };
        setup?: (agentCtx: Context) => Promise<void>;
    }): Promise<AgentHandle>;
    resume(options: {
        resumeSessionId: SessionId;
        agentOptions?: {
            provider?: string;
            model?: string;
        };
    }): Promise<AgentHandle>;
} | undefined;
export declare function sessionTitleService(ctx: Context): SessionTitleServiceLike | undefined;
/**
 * Read one session-like value's event log under either host shape.
 *
 * dsh exposes the log through `Session.snapshotEvents()`; earlier releases
 * exposed a plain `events` array. Reading `.events` alone returned the method
 * itself on the current host, so every fold threw `session.events is not
 * iterable` and the Sessions card failed to load. Both shapes are accepted so
 * one build serves old and new hosts.
 */
export declare function sessionEvents(session: unknown): readonly SessionEventLike[];
/** Whether a session-like value exposes any readable event log at all. */
export declare function hasEventLog(session: unknown): boolean;
/** Event timestamp: `time` on current dsh, `at` on the legacy array shape. */
export declare function eventTime(event: SessionEventLike | undefined): number | undefined;
export declare function sessionsOf(ctx: Context): {
    list(): SessionLike[];
    get(id: SessionId): SessionLike | undefined;
    fork(id: SessionId, boundary: number | undefined, childId: SessionId): SessionLike;
} | undefined;
export declare function sessionById(ctx: Context, id: string): SessionLike | undefined;
/** session.list: live + persisted sessions with web-style summary metadata. */
export declare function listSessionDetails(ctx: Context): Promise<SessionDetail[]>;
export declare function textOfContent(content: unknown): string;
export interface SearchHit {
    sessionId: string;
    seq: number;
    type: string;
    snippet: string;
    live: boolean;
}
/** session.search: scan live logs + persisted logs, web-style snippet cap 240. */
export declare function searchSessions(ctx: Context, query: string, limit?: number): Promise<SearchHit[]>;
export interface HistoryItem {
    seq: number;
    type: string;
    role: string;
    text: string;
}
/** session.history: read a flat window of events (legacy; prefer readTrajectory). */
export declare function readHistory(ctx: Context, sessionId: string, limit?: number, beforeSeq?: number): Promise<HistoryItem[]>;
export interface TrajectoryStep {
    seq: number;
    kind: "user" | "assistant" | "reasoning" | "tool-call" | "tool-result";
    text: string;
}
export interface TrajectoryTurn {
    startSeq: number;
    endSeq?: number;
    index: number;
    seconds?: number;
    outcome?: string;
    model?: string;
    changes?: string;
    steps: TrajectoryStep[];
}
export interface TrajectoryResult {
    turns: TrajectoryTurn[];
    hasMore: boolean;
    nextBefore?: number;
}
/** session.trajectory: turn-grouped structured view (issue #32). */
export declare function readTrajectory(ctx: Context, sessionId: string, maxTurns?: number, beforeSeq?: number): Promise<TrajectoryResult>;
