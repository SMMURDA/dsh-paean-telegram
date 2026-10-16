/**
 * Host domain (web ApiProxy host.describe/listDirectory/createDirectory/
 * openPath/pickDirectory) over process facts and the filesystem. Native
 * dialogs and platform openers do not exist on a phone, so those two degrade
 * to path-based flows with the same data.
 */
import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { assertBrowsable } from "../../config.js";
import { fail, ok } from "./types.js";
/** Node's fs.promises typings in this profile predate `signal`; the timeout
 * race gives the same bounded behaviour for readdir/stat/mkdir (LOOP_AUDIT #3). */
const FS_TIMEOUT_MS = 10_000;
function withFsTimeout(promise) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
                const err = new Error(`filesystem operation timed out after ${FS_TIMEOUT_MS}ms`);
                err.name = "AbortError";
                reject(err);
            }, FS_TIMEOUT_MS);
        }),
    ]).finally(() => {
        if (timer !== undefined)
            clearTimeout(timer);
    });
}
/** Best-effort host version discovery: an explicit `hostInfo` seam first,
 * then the launcher's DSH_VERSION env. Plugins cannot see the host package
 * version, so absence is reported as `undefined` instead of a fake number. */
export function hostVersionOf(ctx, env = process.env) {
    const info = ctx.get("hostInfo");
    if (info && typeof info.version === "string" && info.version.trim() !== "")
        return info.version;
    const fromEnv = env.DSH_VERSION;
    if (typeof fromEnv === "string" && fromEnv.trim() !== "")
        return fromEnv;
    return undefined;
}
export function describeHost(ctx, activeCwd = process.cwd(), version = hostVersionOf(ctx)) {
    // Same source as web host.describe and session.create's fallback: the
    // saved default selection is what the NEXT session will start from.
    const selection = ctx.get("agentDefaultModel")?.currentSelection();
    const agent = ctx.agents?.list()[0];
    return {
        version,
        cwd: activeCwd,
        provider: selection?.provider ?? agent?.options.provider,
        model: selection?.model ?? agent?.options.model,
        attachedSessions: ctx.agents?.list().length ?? 0,
        canOpenPath: false,
    };
}
export async function listDirectory(path, browseRoots) {
    try {
        // B-7r: optional root confinement — unset/empty roots keep the legacy
        // unconstrained behavior byte-for-byte.
        assertBrowsable(path, browseRoots);
        const target = resolve(path);
        // Bad disks/NFS can hang readdir/stat forever and wedge the UI lane;
        // degrade to an error card after 10s instead (LOOP_AUDIT #3).
        const names = await withFsTimeout(readdir(target));
        const entries = await Promise.all(names.slice(0, 200).map(async (name) => {
            try {
                const info = await withFsTimeout(stat(join(target, name)));
                return { name, kind: (info.isDirectory() ? "directory" : "file"), ...(info.isFile() ? { size: info.size } : {}) };
            }
            catch {
                return { name, kind: "file" };
            }
        }));
        entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
        const lines = entries.map((entry) => `${entry.kind === "directory" ? "\u{1F4C1}" : "\u{1F4C4}"} ${entry.name}${entry.size === undefined ? "" : ` (${entry.size} B)`}`);
        // RG-1: when the 200-entry render cap truncated the listing, hand callers
        // the true count so pagination text stops under-reporting. Absent = every
        // entry is visible in `entries`.
        const totalEntries = names.length > entries.length ? names.length : undefined;
        return { ok: true, text: `\u{1F4C2} ${target}\n${lines.join("\n").slice(0, 3500)}`, entries, ...(totalEntries === undefined ? {} : { totalEntries }) };
    }
    catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
            return fail(`directory listing timed out after 10s: ${path}`);
        }
        return fail(err instanceof Error ? err.message : String(err));
    }
}
/** Breadcrumb segments for host.listDirectory navigation: root first, then
 * every ancestor up to and including the path itself. */
export function breadcrumbSegments(path) {
    const abs = resolve(path);
    const root = parse(abs).root;
    const segments = [{ label: "/", path: root }];
    let current = root;
    for (const part of abs.slice(root.length).split(/[/\\]+/).filter(Boolean)) {
        current = join(current, part);
        segments.push({ label: part, path: current });
    }
    return segments;
}
/** True only when the path exists and resolves to a directory. */
export async function isDirectory(path) {
    try {
        const info = await withFsTimeout(stat(resolve(path)));
        return info.isDirectory();
    }
    catch {
        return false;
    }
}
export async function createDirectory(path, browseRoots) {
    try {
        assertBrowsable(path, browseRoots); // B-7r: enforced only when roots are configured
        await withFsTimeout(mkdir(resolve(path), { recursive: false }));
        return ok(`\u{1F4C1} Created ${path}`);
    }
    catch (err) {
        if (err instanceof Error && err.name === "AbortError")
            return fail(`directory creation timed out after 10s: ${path}`);
        return fail(err instanceof Error ? err.message : String(err));
    }
}
/** host.openPath: a phone cannot open a host file — return the resolved path. */
export function openPath(path, browseRoots) {
    try {
        assertBrowsable(path, browseRoots); // B-7r: enforced only when roots are configured
        return ok(`\u{1F4C2} ${resolve(path)} \u2014 open it on the host (a phone client cannot launch host apps).`);
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}
/** host.pickDirectory: native picker unavailable — prompt for a text path. */
export function pickDirectoryHint(current) {
    return ok(`\u{1F4C1} Native directory picker is unavailable on Telegram \u2014 reply with the path (current: ${current}) or use /mkdir.`);
}
export function parentOf(path) {
    return dirname(resolve(path));
}
//# sourceMappingURL=host.js.map