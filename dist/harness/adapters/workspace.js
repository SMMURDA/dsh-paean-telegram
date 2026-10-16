import { SessionId } from "@deepseek-ai/dsh-session";
import { assertBrowsable } from "../../config.js";
import { fail, ok } from "./types.js";
function registryOf(ctx) {
    return ctx.get("workspaceRegistry");
}
function view(workspace) {
    return {
        workspaceId: workspace.id,
        path: typeof workspace.path === "string" ? workspace.path : String(workspace.path ?? ""),
        title: typeof workspace.title === "string" ? workspace.title : String(workspace.title ?? workspace.path ?? workspace.id),
        // Older/alternate registry entries may omit the list; a card render must
        // never dead-button because of a missing field.
        sessionIds: Array.isArray(workspace.sessionIds) ? [...workspace.sessionIds] : [],
        ...(workspace.createdAt === undefined ? {} : { createdAt: workspace.createdAt }),
        ...(workspace.updatedAt === undefined ? {} : { updatedAt: workspace.updatedAt }),
    };
}
/** workspace.list + the registry-global archive set. */
export function listWorkspaces(ctx) {
    const registry = registryOf(ctx);
    if (!registry)
        return { items: [], archivedSessionIds: [] };
    const archived = Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds : [];
    return { items: registry.list().map(view), archivedSessionIds: archived.map(String) };
}
export async function createWorkspace(ctx, path, title, browseRoots) {
    const registry = registryOf(ctx);
    if (!registry)
        return fail("workspaceRegistry is unavailable in this profile");
    try {
        // B-7r: enforced only when security.browseRoots is configured — unset
        // roots keep the legacy unconstrained behavior byte-for-byte.
        assertBrowsable(path, browseRoots);
        const workspace = await registry.create(path, title);
        return { ok: true, text: `\u{1F5C2} Workspace ${workspace.title} (${workspace.path})`, workspace: view(workspace) };
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}
export async function renameWorkspace(ctx, workspaceId, title) {
    const registry = registryOf(ctx);
    if (!registry)
        return fail("workspaceRegistry is unavailable in this profile");
    const workspace = registry.get(workspaceId);
    if (!workspace)
        return fail(`workspace ${workspaceId} not found`);
    const trimmed = title.trim();
    if (!trimmed)
        return fail("workspace title must not be blank");
    try {
        await workspace.setTitle(trimmed);
        return { ok: true, text: `\u270F Renamed to "${workspace.title}"`, workspace: view(workspace) };
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}
export async function deleteWorkspace(ctx, workspaceId) {
    const registry = registryOf(ctx);
    if (!registry)
        return fail("workspaceRegistry is unavailable in this profile");
    try {
        const deleted = await registry.delete(workspaceId);
        return deleted ? ok("\u{1F5D1} Workspace registration deleted (directory and logs retained)") : fail(`workspace ${workspaceId} not found`);
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}
export async function insertWorkspaceBefore(ctx, workspaceId, beforeWorkspaceId) {
    const registry = registryOf(ctx);
    if (!registry)
        return fail("workspaceRegistry is unavailable in this profile");
    try {
        const order = await registry.insertBefore(workspaceId, beforeWorkspaceId);
        return { ok: true, text: "\u2194\uFE0F Workspace order updated", workspaceIds: [...order].map(String) };
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}
export async function insertSessionBefore(ctx, workspaceId, sessionId, beforeSessionId) {
    const registry = registryOf(ctx);
    if (!registry)
        return fail("workspaceRegistry is unavailable in this profile");
    const workspace = registry.get(workspaceId);
    if (!workspace)
        return fail(`workspace ${workspaceId} not found`);
    try {
        await workspace.insertSessionBefore(SessionId(sessionId), beforeSessionId === undefined ? undefined : SessionId(beforeSessionId));
        return { ok: true, text: "\u2194\uFE0F Session order updated", workspace: view(workspace) };
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}
export async function archiveSession(ctx, sessionId) {
    const registry = registryOf(ctx);
    if (!registry)
        return fail("workspaceRegistry is unavailable in this profile");
    try {
        await registry.archiveSession(SessionId(sessionId));
        return { ok: true, text: "\u{1F5C4} Session archived", archivedSessionIds: [...registry.archivedSessionIds].map(String) };
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}
//# sourceMappingURL=workspace.js.map