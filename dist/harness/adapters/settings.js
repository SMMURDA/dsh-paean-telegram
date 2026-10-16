import { fail } from "./types.js";
function settingsOf(ctx) {
    return ctx.get("settings");
}
/** Split a Telegram command argument of the form `<json> [expectedRevision]`
 * without disturbing whitespace inside JSON string values: full JSON first,
 * then a backwards scan for a trailing integer after the closing token.
 * A-2: the parsed `value` rides along so callers never JSON.parse a second
 * time; the `json` field keeps the original shape backward compatible. */
export function parseJsonWithRevision(raw) {
    const trimmed = raw.trim();
    if (trimmed === "")
        return undefined;
    try {
        const value = JSON.parse(trimmed);
        return { json: trimmed, value };
    }
    catch {
        /* try the optional revision suffix below */
    }
    for (let index = trimmed.length - 1; index >= 0; index -= 1) {
        if (!/\s/.test(trimmed[index]))
            continue;
        const head = trimmed.slice(0, index).trimEnd();
        const tail = trimmed.slice(index).trim();
        if (!/^\d+$/.test(tail))
            continue;
        try {
            const value = JSON.parse(head);
            return { json: head, value, revision: Number(tail) };
        }
        catch {
            continue;
        }
    }
    return undefined;
}
export function describeSettings(ctx) {
    const settings = settingsOf(ctx);
    if (!settings)
        return { writable: false, hasDocument: false, namespaces: [], internalNamespaces: [] };
    try {
        const descriptors = settings.describe({ redactSecrets: true });
        const internalNamespaces = descriptors.filter((d) => d.exposed === false).map((d) => String(d.ns));
        return {
            writable: settings.writable ?? true,
            hasDocument: settings.documentPath !== undefined,
            ...(settings.documentPath === undefined ? {} : { documentPath: settings.documentPath }),
            namespaces: descriptors.filter((descriptor) => descriptor.exposed !== false).map((descriptor) => ({
                ns: String(descriptor.ns),
                ...(descriptor.schema === undefined ? {} : { schema: descriptor.schema }),
                value: descriptor.value,
                ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
                ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
                applies: descriptor.applies,
                secrets: descriptor.secrets ?? [],
                revision: descriptor.revision ?? 0,
            })),
            internalNamespaces,
        };
    }
    catch (err) {
        return { writable: false, hasDocument: false, namespaces: [], internalNamespaces: [], error: err instanceof Error ? err.message : String(err) };
    }
}
/** Shared body of the three settings writes: resolve the provider, run one
 * write call, then echo the fresh namespace view with a per-verb message. */
async function withSettingsWrite(ctx, ns, label, write) {
    const settings = settingsOf(ctx);
    if (!settings)
        return fail("settings service is unavailable in this profile");
    try {
        await write(settings);
        const view = describeSettings(ctx).namespaces.find((n) => n.ns === ns);
        return { ok: true, text: `\u2699\uFE0F ${ns} ${label}`, ...(view === undefined ? {} : { view }) };
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}
export async function updateSettings(ctx, ns, patch, expectedRevision) {
    // RG-5: the command layer hands through any parsed JSON. Scalar/array
    // patches violate the settings.update contract — reject them here with the
    // same clarity replace() applies to its section.
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
        return fail("settings patch must be a JSON object");
    }
    return withSettingsWrite(ctx, ns, "updated", (settings) => settings.update(ns, patch, expectedRevision));
}
export async function replaceSettings(ctx, ns, section, expectedRevision) {
    return withSettingsWrite(ctx, ns, "replaced", (settings) => settings.replace(ns, section, expectedRevision));
}
export async function mutateSettings(ctx, ns, ops, expectedRevision) {
    return withSettingsWrite(ctx, ns, "mutated", (settings) => settings.mutate(ns, ops, expectedRevision));
}
//# sourceMappingURL=settings.js.map