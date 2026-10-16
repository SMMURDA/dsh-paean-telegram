import type { Context } from "@deepseek-ai/cordis";
import { type AdapterResult } from "./types.js";
export interface HostView {
    /** The real host version when the profile exposes one; never a guessed or
     * bridge-owned number (the bridge version lives in About). */
    version?: string;
    cwd: string;
    provider?: string;
    model?: string;
    attachedSessions: number;
    canOpenPath: boolean;
}
/** Best-effort host version discovery: an explicit `hostInfo` seam first,
 * then the launcher's DSH_VERSION env. Plugins cannot see the host package
 * version, so absence is reported as `undefined` instead of a fake number. */
export declare function hostVersionOf(ctx: Context, env?: NodeJS.ProcessEnv): string | undefined;
export declare function describeHost(ctx: Context, activeCwd?: string, version?: string | undefined): HostView;
export declare function listDirectory(path: string, browseRoots?: readonly string[]): Promise<AdapterResult & {
    entries?: {
        name: string;
        kind: "file" | "directory";
        size?: number;
    }[];
    totalEntries?: number;
}>;
/** Breadcrumb segments for host.listDirectory navigation: root first, then
 * every ancestor up to and including the path itself. */
export declare function breadcrumbSegments(path: string): {
    label: string;
    path: string;
}[];
/** True only when the path exists and resolves to a directory. */
export declare function isDirectory(path: string): Promise<boolean>;
export declare function createDirectory(path: string, browseRoots?: readonly string[]): Promise<AdapterResult>;
/** host.openPath: a phone cannot open a host file — return the resolved path. */
export declare function openPath(path: string, browseRoots?: readonly string[]): AdapterResult;
/** host.pickDirectory: native picker unavailable — prompt for a text path. */
export declare function pickDirectoryHint(current: string): AdapterResult;
export declare function parentOf(path: string): string;
