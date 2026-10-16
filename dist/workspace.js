import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
/** Entry itself counts as a workspace when `.pi` is a file or directory inside it. */
function hasPiMarker(dir) {
    try {
        const names = readdirSync(dir);
        return names.some((name) => name === '.pi');
    }
    catch {
        return false;
    }
}
/**
 * Walk up from `startDir` and return the nearest ancestor (inclusive) that
 * contains a `.pi` entry, or `undefined` when no workspace root exists.
 */
export function findWorkspaceRoot(startDir = process.cwd()) {
    let current = resolve(startDir);
    for (;;) {
        if (hasPiMarker(current))
            return current;
        const parent = dirname(current);
        if (parent === current)
            return undefined;
        current = parent;
    }
}
/** Convenience check used by /status output and tests. */
export function hasWorkspaceRoot(startDir = process.cwd()) {
    return findWorkspaceRoot(startDir) !== undefined;
}
/** Absolute path of the `.pi` directory inside a workspace root. */
export function piDir(workspaceRoot) {
    return join(workspaceRoot, '.pi');
}
/** Create the `.pi` directory inside a workspace root when it is missing. */
export function ensurePiDir(workspaceRoot) {
    mkdirSync(piDir(workspaceRoot), { recursive: true });
}
//# sourceMappingURL=workspace.js.map