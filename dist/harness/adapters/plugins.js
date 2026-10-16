/**
 * Plugin inventory + enable/disable. The inventory mirrors the web's
 * pluginInventory/list exactly (entryId, moduleName, enabled, fiberPhase).
 * The toggle is a dsh-core capability the web does NOT expose: runtime via
 * ctx.loader.update, durable via the profile's cordis.patch.yml user layer.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fail, ok } from "./types.js";
// R3-4: one home-resolution helper for the whole adapter family — the
// hand-rolled `env ?? join(homedir(), ".dsh")` copy drifted from dshHome().
import { detectProfile, dshHome } from "./mode.js";
const FIBER_STATE = {
    PENDING: 0,
    LOADING: 1,
    ACTIVE: 2,
    FAILED: 3,
    DISPOSED: 4,
    UNLOADING: 5,
};
const FIBER_PHASE = {
    [FIBER_STATE.PENDING]: "pending",
    [FIBER_STATE.LOADING]: "loading",
    [FIBER_STATE.ACTIVE]: "active",
    [FIBER_STATE.FAILED]: "failed",
    [FIBER_STATE.DISPOSED]: null,
    [FIBER_STATE.UNLOADING]: "unloading",
};
function loaderOf(ctx) {
    return ctx.get("loader");
}
/** pluginInventory/list: the web's exact projection shape. */
export function listPlugins(ctx) {
    const loader = loaderOf(ctx);
    if (!loader)
        return [];
    const out = [];
    for (const entry of loader.entries()) {
        if (entry.options.group)
            continue;
        out.push({
            entryId: String(entry.id),
            moduleName: entry.options.name,
            enabled: !entry.disabled,
            fiberPhase: entry.fiber == null ? null : (FIBER_PHASE[entry.fiber.state ?? -1] ?? null),
        });
    }
    return out;
}
export function patchFilePathFor(profile, home) {
    if (!profile)
        return undefined;
    return join(home, "profiles", profile, "cordis.patch.yml");
}
function patchFilePath() {
    return patchFilePathFor(detectProfile(), dshHome());
}
function yamlQuote(value) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function unquote(value) {
    const trimmed = value.trim();
    if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
        return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    return trimmed;
}
/** Top-level `- ` item boundaries at the file's minimum dash indent. */
function topLevelItems(lines) {
    const dashLines = [];
    for (let index = 0; index < lines.length; index += 1) {
        const match = /^(\s*)- /.exec(lines[index]);
        if (match)
            dashLines.push({ index, indent: match[1].length });
    }
    const minIndent = dashLines.length > 0 ? Math.min(...dashLines.map((entry) => entry.indent)) : 0;
    return { starts: dashLines.filter((entry) => entry.indent === minIndent).map((entry) => entry.index), flow: false };
}
function findEntry(lines, entryId) {
    const { starts } = topLevelItems(lines);
    for (let position = 0; position < starts.length; position += 1) {
        const idLine = starts[position];
        const end = position + 1 < starts.length ? starts[position + 1] : lines.length;
        const match = /^(\s*)- id:\s*(.+?)\s*$/.exec(lines[idLine]);
        if (match && unquote(match[2]) === entryId)
            return { idLine, end, indent: match[1] };
    }
    return undefined;
}
/** Indent of the first child line under `- id:` (falls back to id indent + 2). */
function childIndent(lines, entry) {
    for (let index = entry.idLine + 1; index < entry.end; index += 1) {
        const match = /^(\s+)\S/.exec(lines[index]);
        if (match)
            return match[1];
    }
    return `${entry.indent}  `;
}
/** Replace the direct-child `disabled:` value, or insert it right under `- id:`. */
function applyDisabled(lines, entry, disabled, indent) {
    const pattern = /^(\s+)disabled:\s*(true|false|null)\s*$/;
    for (let index = entry.idLine + 1; index < entry.end; index += 1) {
        const match = pattern.exec(lines[index]);
        if (match && match[1] === indent) {
            lines[index] = `${match[1]}disabled: ${disabled}`;
            return;
        }
    }
    lines.splice(entry.idLine + 1, 0, `${indent}disabled: ${disabled}`);
}
/**
 * Persist a patch file atomically: write "<target>.tmp-<suffix>" in the same
 * directory, then rename over the target so a reader never observes a
 * partially-written file. Best-effort cleanup of the temp file on failure.
 */
function atomicWritePatch(target, content) {
    const tmp = `${target}.tmp-${randomUUID()}`;
    try {
        writeFileSync(tmp, content, "utf8");
        renameSync(tmp, target);
    }
    catch (err) {
        try {
            rmSync(tmp, { force: true });
        }
        catch {
            // Best-effort cleanup only — never mask the original failure.
        }
        throw err;
    }
}
/** Durable toggle: rewrite only the profile's user patch layer (block-style YAML). */
export function persistPluginPatch(entryId, disabled, file) {
    const target = file ?? patchFilePath();
    if (!target)
        return fail("current profile is unknown \u2014 cannot persist the plugin toggle (edit cordis.patch.yml manually)");
    if (!existsSync(target))
        return fail(`patch file missing: ${target}`);
    const source = readFileSync(target, "utf8");
    const trimmed = source.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]") && trimmed !== "[]") {
        return fail(`cordis.patch.yml at ${target} uses a flow-style YAML array, which dsh-telegram does not rewrite \u2014 convert it to a block-style list and retry`);
    }
    if (trimmed === "[]" || trimmed === "") {
        const block = `- id: ${yamlQuote(entryId)}\n  disabled: ${disabled}\n`;
        if (trimmed === "") {
            atomicWritePatch(target, block);
        }
        else {
            const replaced = source.replace(/\[\]\s*$/, block.trimEnd());
            atomicWritePatch(target, replaced);
        }
        return ok(`\u{1F527} Plugin ${entryId} ${disabled ? "disabled" : "enabled"} \u2014 persisted in ${target}; restart the profile to apply.`);
    }
    const lines = source.split("\n");
    const entry = findEntry(lines, entryId);
    if (entry) {
        const indent = childIndent(lines, entry);
        applyDisabled(lines, entry, disabled, indent);
    }
    else {
        const { starts } = topLevelItems(lines);
        let last = -1;
        if (starts.length > 0) {
            for (let index = lines.length - 1; index >= starts[starts.length - 1]; index -= 1) {
                if (lines[index].trim() !== "") {
                    last = index;
                    break;
                }
            }
        }
        let insertAt;
        if (last === -1) {
            insertAt = lines.length;
        }
        else {
            insertAt = last + 1;
        }
        const indent = starts.length > 0 ? childIndent(lines, { idLine: starts[starts.length - 1], end: lines.length, indent: "" }) : "  ";
        const block = [`- id: ${yamlQuote(entryId)}`, `${indent}disabled: ${disabled}`];
        if (insertAt < lines.length) {
            lines.splice(insertAt, 0, ...block);
        }
        else {
            if (lines[lines.length - 1] === "")
                lines[lines.length - 1] = block[0];
            else
                lines.push(block[0]);
            lines.push(block[1]);
        }
    }
    const next = lines.join("\n").replace(/\n*$/, "\n");
    atomicWritePatch(target, next);
    return ok(`\u{1F527} Plugin ${entryId} ${disabled ? "disabled" : "enabled"} \u2014 persisted in ${target}; restart the profile to apply.`);
}
function persistPatch(entryId, disabled) {
    return persistPluginPatch(entryId, disabled);
}
/** Toggle one plugin: live now (restart-reverted) + durable patch (restart-applied). */
export async function togglePlugin(ctx, entryId, disabled) {
    const loader = loaderOf(ctx);
    if (!loader)
        return fail("loader service is unavailable in this profile");
    const entry = [...loader.entries()].find((candidate) => String(candidate.id) === entryId);
    if (!entry)
        return fail(`plugin entry ${entryId} not found`);
    let liveText = "";
    try {
        await loader.update(entryId, { disabled });
        liveText = ` \u00B7 live: ${disabled ? "disabled" : "enabled"}`;
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
    // Persistence failures surface in the message text only — the live toggle
    // already succeeded, so the result stays ok either way. The sync IO below
    // (readFileSync/writeFileSync/renameSync) can reject on EACCES/ENOSPC even
    // though the live toggle already succeeded, so it must not escape as a
    // rejection (D-2): wrap it in its own try/catch.
    let persisted;
    try {
        persisted = persistPatch(entryId, disabled);
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
            ok: true,
            text: `\u{1F527} Plugin ${entryId} ${disabled ? "disabled" : "enabled"} \u00B7 live: ${disabled ? "disabled" : "enabled"} \u00B7 persist failed: ${reason}`,
        };
    }
    return { ok: true, text: `${persisted.text}${liveText}` };
}
/** Entry id for a module name (the loader's stable id is usually the name). */
export function entryIdFor(ctx, moduleName) {
    const loader = loaderOf(ctx);
    if (!loader)
        return undefined;
    for (const entry of loader.entries()) {
        if (String(entry.id) === moduleName)
            return String(entry.id);
        if (entry.options.name === moduleName)
            return String(entry.id);
    }
    return undefined;
}
//# sourceMappingURL=plugins.js.map