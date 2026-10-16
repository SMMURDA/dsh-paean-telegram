/**
 * Workspace domain (web ApiProxy workspace.* seven methods) over
 * ctx.workspaceRegistry. The registry is optional — headless profiles without
 * it degrade with readable hints.
 */
import type { Context } from "@deepseek-ai/cordis";
import { type AdapterResult } from "./types.js";
export interface WorkspaceView {
    workspaceId: string;
    path: string;
    title: string;
    sessionIds: string[];
    createdAt?: number;
    updatedAt?: number;
}
/** workspace.list + the registry-global archive set. */
export declare function listWorkspaces(ctx: Context): {
    items: WorkspaceView[];
    archivedSessionIds: string[];
};
export declare function createWorkspace(ctx: Context, path: string, title?: string, browseRoots?: readonly string[]): Promise<AdapterResult & {
    workspace?: WorkspaceView;
}>;
export declare function renameWorkspace(ctx: Context, workspaceId: string, title: string): Promise<AdapterResult & {
    workspace?: WorkspaceView;
}>;
export declare function deleteWorkspace(ctx: Context, workspaceId: string): Promise<AdapterResult>;
export declare function insertWorkspaceBefore(ctx: Context, workspaceId: string, beforeWorkspaceId?: string): Promise<AdapterResult & {
    workspaceIds?: string[];
}>;
export declare function insertSessionBefore(ctx: Context, workspaceId: string, sessionId: string, beforeSessionId?: string): Promise<AdapterResult & {
    workspace?: WorkspaceView;
}>;
export declare function archiveSession(ctx: Context, sessionId: string): Promise<AdapterResult & {
    archivedSessionIds?: string[];
}>;
