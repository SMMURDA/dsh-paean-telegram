import { listAgentPresets } from "../harness/adapters/presets.js";
import { plain, truncate } from "../telegram/html.js";
import { bold, headerLine, metaJoin } from "../telegram/ui.js";
import { buildNewSessionKeyboard, buildPresetDetailKeyboard, buildPresetsKeyboard } from "../telegram/keyboard.js";
/** Build the preset-domain cards. Called once by index.ts; every card closes
 * over the shared deps like the previous module-scope closures did over
 * index.ts singletons. */
export function createPresetCards(deps) {
    const { requireCtx, currentAgent, cardLoad, openCard, token } = deps;
    /** New-session preset picker (web session.create's agentPreset): use the
     * roster's default preset with one tap, or pick a specific preset. Profiles
     * without presets fall straight through to creation. */
    async function openNewSessionCard(chatId) {
        const presetsView = await cardLoad(chatId, "agent presets", () => listAgentPresets(requireCtx()));
        if (presetsView === undefined)
            return;
        const { presets } = presetsView;
        const lines = [
            headerLine("\u2728", "New session"),
            "",
            presets.length > 0
                ? "Compose the session from a preset, or use the roster default:"
                : "This profile composes no agent presets \u2014 the new session uses the profile default.",
            "",
            ...presets.slice(0, 12).map((preset) => `${preset.isDefault ? "\u2B50" : "\u2022"} ${bold(preset.id)}${preset.isDefault ? " \u00B7 default" : ""}`),
        ];
        await openCard(chatId, lines.join("\n"), buildNewSessionKeyboard(token({ action: "new-default" }, chatId), presets.slice(0, 12).map((preset) => ({ id: preset.id, isDefault: preset.isDefault, cb: token({ action: "preset-new", presetId: preset.id }, chatId) }))));
    }
    async function openPresetsCard(chatId) {
        const presetsView = await cardLoad(chatId, "agent presets", () => listAgentPresets(requireCtx()));
        if (presetsView === undefined)
            return;
        const { presets, authorable, hasDocument } = presetsView;
        const lines = [
            headerLine("\u{1F3AD}", "Agent presets", `${presets.length}`, `authorable ${authorable ? "yes" : "no"}`, `document ${hasDocument ? "yes" : "no"}`),
            "",
        ];
        for (const preset of presets.slice(0, 20)) {
            const flags = [preset.trust, ...(preset.broken ? ["\u26A0\uFE0F broken"] : [])];
            lines.push(metaJoin(`${preset.isDefault ? "\u2B50" : "\u2022"} ${bold(preset.id)}`, ...flags));
            if (preset.description)
                lines.push(`  ${plain(truncate(preset.description, 60))}`);
        }
        if (presets.length > 20)
            lines.push(`\u2026 +${presets.length - 20} more presets not shown`);
        if (presets.length === 0)
            lines.push("This profile composes no agent presets.");
        const rows = presets.slice(0, 20).map((preset) => ({ id: preset.id, cb: token({ action: "preset", presetId: preset.id }, chatId) }));
        await openCard(chatId, lines.join("\n"), buildPresetsKeyboard(rows), () => openPresetsCard(chatId));
    }
    async function openPresetDetailCard(chatId, presetId) {
        const agent = currentAgent(chatId);
        const lines = [
            headerLine("\u{1F3AD}", truncate(presetId, 40)),
            "",
            "Blank session: applies in place. Started session: forks it, applies the preset to the fork, and closes the original.",
        ];
        const callbacks = {
            select: token({ action: "preset-select", presetId, sessionId: agent?.id ?? "" }, chatId),
            read: token({ action: "preset-read", presetId }, chatId),
            create: token({ action: "preset-new", presetId }, chatId),
            copy: token({ action: "preset-copy", presetId }, chatId),
            remove: token({ action: "preset-remove", presetId }, chatId),
            open: token({ action: "preset-open", presetId }, chatId),
            default: token({ action: "preset-default", presetId }, chatId),
        };
        await openCard(chatId, lines.join("\n"), buildPresetDetailKeyboard(callbacks));
    }
    return { openNewSessionCard, openPresetsCard, openPresetDetailCard };
}
//# sourceMappingURL=presets.js.map