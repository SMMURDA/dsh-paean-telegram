function runnerOf(ctx) {
    return ctx.get("dynamicCordisRunner");
}
export function listDynamicCordis(ctx) {
    const runner = runnerOf(ctx);
    if (!runner)
        return [];
    // Inventory is a synchronous seam: it either returns or throws (both
    // handled below), so there is no async hang to race a deadline against —
    // only the awaited lifecycle calls below get RUNNER_TIMEOUT_MS (audit IA-2).
    try {
        return runner.inventory()
            .filter((row) => typeof row.pluginId === "string" && row.pluginId !== "")
            .map((row) => ({ ...row, pluginId: String(row.pluginId) }));
    }
    catch {
        return [];
    }
}
function fail(text) {
    return { ok: false, text };
}
function describeError(err) {
    return err instanceof Error ? err.message : String(err);
}
/** Runner deadline (audit IA-2, LOOP_AUDIT #3 class): a hung
 * dynamicCordisRunner — deadlocked runner or wedged plugin — used to hang the
 * originating card callback (dispatch plugin-run/stop/remove-confirm) or the
 * /pluginadd lane forever. One documented bound for all lifecycle seams,
 * mirroring host.ts withFsTimeout and core/cards.ts CARD_LOAD_TIMEOUT_MS. */
export const RUNNER_TIMEOUT_MS = 15_000;
/** Race one lifecycle invocation against RUNNER_TIMEOUT_MS and fail closed:
 * the caller's existing catch turns the deadline into its normal ok/fail
 * result with a "timed out after Ns" message. `define` is synchronous in this
 * profile but wrapped anyway so a seam that drifts to returning a promise
 * cannot hang either; a synchronously-deadlocked seam blocks the event loop
 * outright, where no timer could ever fire (same for `inventory`).
 *
 * State semantics (IA-2): this adapter keeps no registry of running plugins —
 * every card render re-reads runner.inventory(), so there is no cached flag a
 * timed-out call could desync. A stop that hits the deadline therefore means
 * "outcome unknown, possibly still running": the adapter reports failure
 * without claiming any transition, marks nothing stopped client-side, and the
 * next ⏸/🗑 tap re-asks the runner, which remains the sole source of truth. */
async function withRunnerTimeout(label, invoke) {
    const pending = Promise.resolve(invoke());
    // The raced seam may still reject long after the deadline decided the
    // outcome; detach a no-op handler so that loser rejection can't surface as
    // an unhandled rejection crashing the bridge (IA-2).
    void pending.catch(() => { });
    let timer;
    try {
        return (await Promise.race([
            pending,
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => {
                    // AbortError marks the deadline (host.ts convention); seconds form
                    // because that is what surfaces verbatim in user-facing text.
                    const err = new Error(`${label} timed out after ${Math.round(RUNNER_TIMEOUT_MS / 1000)}s`);
                    err.name = "AbortError";
                    reject(err);
                }, RUNNER_TIMEOUT_MS);
            }),
        ]));
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
/**
 * Define a new dynamic Plugin's first Package (or append to an existing one
 * when `pluginId` is given). Mirrors web define semantics: the request is
 * session-scoped and returns Host-minted identities.
 */
export async function defineDynamicCordis(ctx, agentId, input, existingPluginId) {
    const runner = runnerOf(ctx);
    if (!runner?.define)
        return fail("dynamicCordisRunner service is not available in this profile.");
    const name = input.name.trim();
    const purpose = input.purpose.trim();
    if (!name)
        return fail("Plugin name must not be blank.");
    if (!purpose)
        return fail("Plugin purpose must not be blank.");
    const host = typeof input.host === "string" ? input.host : undefined;
    const client = typeof input.client === "string" ? input.client : undefined;
    if ((host === undefined || host.trim() === "") && (client === undefined || client.trim() === "")) {
        return fail('At least one source half is required: {"host": "..."} or {"client": "..."}.');
    }
    try {
        const receipt = await withRunnerTimeout("plugin define", () => runner.define({
            sessionId: agentId,
            plugin: existingPluginId ? { kind: "existing", pluginId: existingPluginId } : { kind: "new", idPrefix: name },
            name,
            purpose,
            code: { ...(host !== undefined && host.trim() !== "" ? { host } : {}), ...(client !== undefined && client.trim() !== "" ? { client } : {}) },
        }));
        const halves = [
            receipt.hasHostHalf === false ? undefined : "host",
            receipt.hasClientHalf ? "client" : undefined,
        ].filter(Boolean);
        return {
            ok: true,
            text: `Defined ${receipt.name} → plugin ${receipt.pluginId} · package ${receipt.packageId} (${halves.join("+")} half).`,
            pluginId: receipt.pluginId,
            packageId: receipt.packageId,
        };
    }
    catch (err) {
        return fail(`Define failed: ${describeError(err)}`);
    }
}
/** Newest known package for a plugin. Prefering the last-defined version is
 * what makes "define a v2 via /pluginadd, tap ▶ Run" activate that v2; the
 * transition lands as an update when it differs from the current activation. */
function latestPackageOf(runner, pluginId) {
    try {
        const row = runner.inventory().find((candidate) => String(candidate.pluginId) === pluginId);
        if (!row)
            return undefined;
        const packages = row.packages ?? [];
        return packages.at(-1)?.packageId ?? row.nextPackageId ?? row.currentPackageId;
    }
    catch {
        return undefined;
    }
}
/**
 * Activate (or update to) a Package. With no explicit packageId the latest
 * known version is used. An unauthorized Client half parks in approval — the
 * interactive card flow settles it, same as the web.
 */
export async function runDynamicPlugin(ctx, agent, pluginId, packageId) {
    const runner = runnerOf(ctx);
    if (!runner?.run)
        return fail("dynamicCordisRunner service is not available in this profile.");
    const target = packageId ?? latestPackageOf(runner, pluginId);
    if (!target)
        return fail(`No package found for plugin ${pluginId} — define one first (/pluginadd).`);
    let mode = "run";
    try {
        const row = runner.inventory().find((candidate) => String(candidate.pluginId) === pluginId);
        if (row?.currentPackageId !== undefined && String(row.currentPackageId) !== target)
            mode = "update";
    }
    catch {
        // Inventory read failure keeps the safe default ('run').
    }
    try {
        const response = await withRunnerTimeout("plugin run", () => runner.run(agent, pluginId, target, mode));
        if (!response.ok)
            return fail(`Run failed (${response.message})`);
        if (response.status === "awaiting-approval")
            return { ok: true, text: `Activation awaiting your approval — watch for the approval card.` };
        if (response.status === "starting")
            return { ok: true, text: `Activation starting — the client half is loading.` };
        return { ok: true, text: `Running ${pluginId} @ ${target}.` };
    }
    catch (err) {
        return fail(`Run failed: ${describeError(err)}`);
    }
}
/** Stop the active run while keeping every immutable version. */
export async function stopDynamicPlugin(ctx, agent, pluginId) {
    const runner = runnerOf(ctx);
    if (!runner?.stop)
        return fail("dynamicCordisRunner service is not available in this profile.");
    try {
        const response = await withRunnerTimeout("plugin stop", () => runner.stop(agent, pluginId));
        return response.ok
            ? { ok: true, text: `Stopped ${pluginId} (versions retained).` }
            : fail(`Stop failed (${response.message})`);
    }
    catch (err) {
        return fail(`Stop failed: ${describeError(err)}`);
    }
}
/** Remove a Plugin, its active run, and all Packages. Irreversible. */
export async function undefineDynamicPlugin(ctx, agent, pluginId) {
    const runner = runnerOf(ctx);
    if (!runner?.undefine)
        return fail("dynamicCordisRunner service is not available in this profile.");
    try {
        const receipt = await withRunnerTimeout("plugin remove", () => runner.undefine(agent, pluginId));
        return receipt.ok
            ? { ok: true, text: `Removed ${pluginId}${receipt.stoppedActiveRun ? " (active run stopped)" : ""}.` }
            : fail(`Remove failed (${receipt.message ?? "unknown reason"})`);
    }
    catch (err) {
        return fail(`Remove failed: ${describeError(err)}`);
    }
}
//# sourceMappingURL=dynamicCordis.js.map