/**
 * Downloads domain (web ApiProxy downloads.sessionLog GET). Telegram cannot
 * carry files over 50 MB, so we stream the same ZIP through the web's own
 * export seam and either send it as a document or hand over the guidance.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fail, ok } from "./types.js";
import { dshHome } from "./mode.js";
export const TELEGRAM_DOCUMENT_LIMIT_BYTES = 50 * 1024 * 1024;
/** The ZIP is capped at 50 MB, so 120s is generous even on slow links; a
 * stalled stream must fail the command instead of hanging /sessionlog. */
const SESSION_LOG_EXPORT_TIMEOUT_MS = 120_000;
/**
 * Seam module locations tried in order. The export seam moved out of
 * `@deepseek-ai/dsh-host-apiproxy` into `@deepseek-ai/dsh-session-log-export`;
 * both are probed so one build serves older and current profiles.
 */
const SEAM_CANDIDATES = [
    ["@deepseek-ai/dsh-session-log-export", "lib/index.js"],
    ["@deepseek-ai/dsh-session-log-export", "lib/types/index.js"],
    ["@deepseek-ai/dsh-host-apiproxy", "lib/types/session-export.js"],
];
/** Blue-7: one probe costs readdirSync + require.resolve + a dynamic import.
 * The resolution promise is cached at module level so every export after the
 * first — including concurrent calls and permanent misses (negative cache;
 * profile dependencies do not appear mid-process) — reuses that single
 * result instead of re-walking the filesystem on each /sessionlog. */
let exportSeamPromise;
async function probeExportSeam() {
    // The web session-export seam lives inside `@deepseek-ai/dsh-host-apiproxy`,
    // which is a PROFILE dependency, not a dependency of this plugin. Resolve it
    // from plausible profile roots (workspace cwd, DSH_HOME or the ~/.dsh
    // default — same fallback as mode.ts dshHome(), each profile dir)
    // instead of only this plugin's node_modules.
    const bases = new Set([process.cwd()]);
    const home = dshHome();
    if (home !== "") {
        bases.add(home);
        try {
            for (const entry of readdirSync(join(home, "profiles"))) {
                bases.add(join(home, "profiles", entry));
            }
        }
        catch {
            /* no profiles dir */
        }
    }
    for (const base of bases) {
        const require = createRequire(join(base, "noop.js"));
        for (const [pkg, entry] of SEAM_CANDIDATES) {
            try {
                const manifest = require.resolve(`${pkg}/package.json`);
                const moduleUrl = pathToFileURL(join(manifest.replace(/package\.json$/, ""), entry)).href;
                const seam = (await import(moduleUrl));
                if (typeof seam.streamSessionLogZip === "function")
                    return seam;
            }
            catch {
                /* try the next candidate, then the next profile root */
            }
        }
    }
    return undefined;
}
function loadExportSeam() {
    if (exportSeamPromise === undefined) {
        exportSeamPromise = probeExportSeam().catch(() => undefined);
    }
    return exportSeamPromise;
}
/**
 * Test seam: pin the probe result so the "seam present" and "seam absent"
 * branches are both deterministic. On a host where the profile packages really
 * resolve (any developer machine running Paean), the probe succeeds and the
 * absent-branch test would otherwise depend on the environment. Production code
 * never calls this.
 */
export function setExportSeamForTest(seam) {
    exportSeamPromise = Promise.resolve(seam);
}
/** Oversize guidance: the web URL path and the host-side location, so a
 * >50 MB log is still reachable instead of a dead end. */
export function oversizeGuidance(sessionId, totalBytes) {
    const mb = Math.max(1, Math.round(totalBytes / 1024 / 1024));
    return [
        `session log ZIP exceeds the 50 MB Telegram limit (${mb} MB).`,
        `Web: open the web UI \u2192 Sessions \u2192 ${sessionId} \u2192 Log download.`,
        "Host: the same archive lives under $DSH_HOME/sessions (default ~/.dsh/sessions).",
    ].join("\n");
}
/**
 * Root log handed to the ZIP writer. The current seam serializes it itself and
 * expects JSONL text through `readSessionLogText`; the legacy apiproxy seam
 * expected the raw `readRaw` payload instead.
 */
async function readRootLog(seam, deps, sessionId, signal) {
    if (typeof seam.readSessionLogText === "function") {
        return await seam.readSessionLogText(deps.sessionPersistence, sessionId, signal);
    }
    const legacy = deps.sessionPersistence?.readRaw;
    if (typeof legacy !== "function") {
        throw new Error("this profile's session-export seam cannot read the session log");
    }
    return await legacy.call(deps.sessionPersistence, sessionId, signal);
}
/** sessionLog download: same ZIP the web serves, buffered for Telegram. */
export async function exportSessionLog(ctx, sessionId, includeDescendants) {
    const seam = await loadExportSeam();
    if (!seam) {
        return {
            result: fail(`session log ZIP is served by the web profile \u2014 this profile cannot build the archive. Open the web UI's session download for ${sessionId}.`),
        };
    }
    const deps = seam.sessionLogExportDeps(ctx);
    if (!deps.sessionPersistence)
        return { result: fail("session persistence is unavailable in this profile \u2014 the session log cannot be exported") };
    const signal = AbortSignal.timeout(SESSION_LOG_EXPORT_TIMEOUT_MS);
    try {
        await seam.flushLiveSessionLog(deps, sessionId, signal);
        const root = await readRootLog(seam, deps, sessionId, signal);
        if (root === undefined)
            return { result: fail(`session ${sessionId} not found`) };
        const stream = seam.streamSessionLogZip(deps, root, sessionId, includeDescendants, 6, signal);
        const reader = stream.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
            let readResult;
            try {
                readResult = await reader.read();
            }
            catch (err) {
                void reader.cancel().catch(() => { });
                if (signal.aborted)
                    throw new Error(`session log ZIP export timed out after ${Math.round(SESSION_LOG_EXPORT_TIMEOUT_MS / 1000)}s`);
                throw err;
            }
            const { done, value } = readResult;
            if (done)
                break;
            if (value) {
                total += value.byteLength;
                if (total > TELEGRAM_DOCUMENT_LIMIT_BYTES) {
                    void reader.cancel().catch(() => { });
                    return { result: fail(oversizeGuidance(sessionId, total)) };
                }
                chunks.push(value);
            }
        }
        const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
        return { result: ok(`\u{1F4E6} ${sessionId}.zip \u00B7 ${Math.round(buffer.byteLength / 1024)} KB`), buffer };
    }
    catch (err) {
        return { result: fail(err instanceof Error ? err.message : String(err)) };
    }
}
//# sourceMappingURL=downloads.js.map