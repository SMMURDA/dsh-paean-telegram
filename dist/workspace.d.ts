/**
 * Walk up from `startDir` and return the nearest ancestor (inclusive) that
 * contains a `.pi` entry, or `undefined` when no workspace root exists.
 */
export declare function findWorkspaceRoot(startDir?: string): string | undefined;
/** Convenience check used by /status output and tests. */
export declare function hasWorkspaceRoot(startDir?: string): boolean;
/** Absolute path of the `.pi` directory inside a workspace root. */
export declare function piDir(workspaceRoot: string): string;
/** Create the `.pi` directory inside a workspace root when it is missing. */
export declare function ensurePiDir(workspaceRoot: string): void;
