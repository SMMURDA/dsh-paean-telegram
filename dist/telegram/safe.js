/**
 * Fire-and-forget helper: never let a background promise reject into the
 * void. Failures are logged with their label so a dropped feedback path is
 * observable instead of silently vanishing (issues #11/#12/#13).
 */
export function safeWrap(label, fn, log) {
    const writer = log ?? ((message, error) => console.error(`[dsh-telegram] ${message}`, error ?? ""));
    return fn().catch((err) => {
        writer(`${label} FAILED`, err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err));
        return undefined;
    });
}
//# sourceMappingURL=safe.js.map