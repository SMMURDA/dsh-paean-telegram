/**
 * Fire-and-forget helper: never let a background promise reject into the
 * void. Failures are logged with their label so a dropped feedback path is
 * observable instead of silently vanishing (issues #11/#12/#13).
 */
export declare function safeWrap<T>(label: string, fn: () => Promise<T>, log?: (message: string, error?: unknown) => void): Promise<T | undefined>;
