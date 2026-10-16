/**
 * Session display helpers: durable-title fallback chain, directory basename
 * disambiguation, project grouping, and running-first ordering. Pure
 * functions over plain data — no Context, no services, no I/O — so both the
 * read queries (session-read.ts) and the Telegram cards can consume them
 * without coupling to the host seams.
 */
export interface SessionDetail {
    id: string;
    cwd?: string;
    live: boolean;
    running: boolean;
    title?: string;
    blank: boolean;
    lastPromptAt?: number;
    eventCount: number;
    archived: boolean;
}
/** Workspace rows consumed by project grouping (workspace adapter shape). */
export interface ProjectWorkspace {
    workspaceId: string;
    title: string;
    path: string;
    sessionIds: readonly string[];
}
/** One project bucket in the Sessions card: a real Workspace or a cwd-derived
 * pseudo project. Sessions are sorted running-first inside the group. */
export interface ProjectGroup {
    key: string;
    label: string;
    workspaceId?: string;
    path?: string;
    sessions: SessionDetail[];
    runningCount: number;
    latestPromptAt: number;
}
/** Group key for sessions whose header carries no usable cwd. */
export declare const UNGROUPED_KEY = "__ungrouped__";
/** Web session-list display title: durable title → cwd basename → raw id. */
export declare function displayTitleFor(title: string | undefined, cwd: string | undefined, id: string): string;
/** Running sessions first, then most-recently-prompted, then stable id. */
export declare function sortProjectSessions(details: readonly SessionDetail[]): SessionDetail[];
/**
 * Group sessions into project buckets. Real Workspaces keep their registry
 * title and membership (`sessionIds`); every other session falls into a
 * cwd-derived pseudo project (same basenames are disambiguated), and
 * cwd-less sessions trail under {@link UNGROUPED_KEY}.
 *
 * Registry membership is advisory, never authoritative: the host registry
 * folds new sessions in lazily (boot-time canonical-cwd reconciliation), so
 * a freshly created session is routinely MISSING from `sessionIds` while its
 * cwd already equals the workspace path. Falling straight through to a pseudo
 * project used to split one project into two look-alike groups ("dsh-telegram"
 * beside "dsh-telegram (cx)") and pushed every live session into the shadow
 * copy — the reported "selected the project, but the session sits in
 * Ungrouped". An unclaimed session whose cwd matches a known group path
 * therefore joins THAT group instead of spawning a duplicate.
 */
export declare function groupSessionsByProject(details: readonly SessionDetail[], workspaces: readonly ProjectWorkspace[]): ProjectGroup[];
/**
 * Project display order: bound running project first, then running projects
 * by recent activity, then the bound project, then everything else by recent
 * activity; the cwd-less bucket is always last.
 */
export declare function orderProjectGroups(groups: readonly ProjectGroup[], boundSessionId?: string): ProjectGroup[];
