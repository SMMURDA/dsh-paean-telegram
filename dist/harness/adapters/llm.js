import { fail } from "./types.js";
function llmOf(ctx) {
    return ctx.get("llm");
}
/** Model discovery dials a draft baseURL; a hung endpoint must not suspend
 * Telegram command processing forever (the request used to carry no signal).
 * Same race shape as host.ts's withFsTimeout; the signal is also passed so
 * fetch-based adapters abort their connection immediately. Matches media.ts's
 * transcription budget. */
const DISCOVER_TIMEOUT_MS = 60_000;
/** Build the web's exact model catalog shape (groups + failures + routable). */
export async function modelCatalog(ctx, current) {
    const llm = llmOf(ctx);
    if (!llm)
        return { groups: [], failures: [], current: current ?? {}, routable: true };
    const providers = llm.listProviders();
    // Two-level fan-out (providers × models), matching models.ts: both loops
    // used to await one entry at a time, so a slow adapter serialized the whole
    // catalog. Promise.all gathers positionally, so group/failure order still
    // follows listProviders() regardless of completion order.
    const settled = await Promise.all(providers.map(async (provider) => {
        try {
            const models = await llm.listModels(provider.id);
            const entries = await Promise.all(models.map(async (model) => {
                let reasoning;
                try {
                    const resolved = await llm.resolveModelInfo(provider.id, model.id);
                    reasoning = resolved.reasoning;
                }
                catch {
                    /* offline adapter must not hide the rest of the catalog */
                }
                return {
                    id: model.id,
                    name: model.name,
                    ...(model.description === undefined ? {} : { description: model.description }),
                    ...(reasoning === undefined ? {} : { reasoning }),
                };
            }));
            return { group: { id: provider.id, name: provider.name, models: entries } };
        }
        catch (err) {
            return { failure: { provider: provider.id, message: err instanceof Error ? err.message : String(err) } };
        }
    }));
    const groups = settled.flatMap((entry) => (entry.group === undefined ? [] : [entry.group]));
    const failures = settled.flatMap((entry) => (entry.failure === undefined ? [] : [entry.failure]));
    return {
        groups,
        failures,
        current: current ?? {},
        routable: current?.provider === undefined || providers.some((entry) => entry.id === current.provider),
    };
}
/** llm.providers: the provider roster with deployment facts, failures kept
 * separate so one broken registration never hides the rest. */
export async function providerCatalog(ctx) {
    const llm = llmOf(ctx);
    if (!llm)
        return { providers: [], failures: [] };
    try {
        return {
            providers: llm.listProviders().map((provider) => ({
                id: provider.id,
                name: provider.name,
                ...(provider.settingsNs === undefined ? {} : { settingsNs: provider.settingsNs }),
                ...(provider.settingsPath === undefined ? {} : { settingsPath: provider.settingsPath }),
                ...(provider.active === undefined ? {} : { active: provider.active }),
                ...(provider.declared === undefined ? {} : { declared: provider.declared }),
            })),
            failures: [],
        };
    }
    catch (err) {
        return { providers: [], failures: [{ provider: "*", message: err instanceof Error ? err.message : String(err) }] };
    }
}
/** llm.discoverModels: interrogate a draft endpoint, never storing the key. */
export async function discoverModels(ctx, settingsNs, request) {
    const llm = llmOf(ctx);
    if (!llm)
        return fail("llm service is unavailable in this profile");
    let timer;
    try {
        const models = await Promise.race([
            llm.discoverModels(settingsNs, { ...request, signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS) }),
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`model discovery timed out after ${DISCOVER_TIMEOUT_MS}ms`)), DISCOVER_TIMEOUT_MS);
            }),
        ]);
        const lines = models.map((model) => `${model.id}${model.name === undefined ? "" : ` \u00B7 ${model.name}`}${model.contextWindow === undefined ? "" : ` \u00B7 ctx ${model.contextWindow}`}`);
        return { ok: true, text: `\u{1F50D} ${models.length} model(s) discovered:\n${lines.join("\n").slice(0, 3500)}`, models };
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
//# sourceMappingURL=llm.js.map