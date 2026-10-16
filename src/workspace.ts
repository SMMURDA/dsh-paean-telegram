import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Entry itself counts as a workspace when `.pi` is a file or directory inside it. */
function hasPiMarker(dir: string): boolean {
  try {
    const names = readdirSync(dir);
    return names.some((name) => name === '.pi');
  } catch {
    return false;
  }
}

/**
 * Walk up from `startDir` and return the nearest ancestor (inclusive) that
 * contains a `.pi` entry, or `undefined` when no workspace root exists.
 */
export function findWorkspaceRoot(startDir: string = process.cwd()): string | undefined {
  let current = resolve(startDir);
  for (;;) {
    if (hasPiMarker(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Convenience check used by /status output and tests. */
export function hasWorkspaceRoot(startDir: string = process.cwd()): boolean {
  return findWorkspaceRoot(startDir) !== undefined;
}

/** Absolute path of the `.pi` directory inside a workspace root. */
export function piDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.pi');
}

/** Create the `.pi` directory inside a workspace root when it is missing. */
export function ensurePiDir(workspaceRoot: string): void {
  mkdirSync(piDir(workspaceRoot), { recursive: true });
}
