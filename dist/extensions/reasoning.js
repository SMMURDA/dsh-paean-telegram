import { REASONING_EFFORTS, isReasoningEffort, reasoningLabel } from "../reasoning.js";
import { buildThinkingKeyboard } from "../telegram/keyboard.js";
const CALLBACK_REASONING = "m:thinking";
const ACTION_REASONING_SELECT = "reasoning-select";
function currentEffort(host) {
    const effort = host.getConfigPath("reasoning.effort");
    return effort !== undefined && isReasoningEffort(effort) ? effort : "medium";
}
async function openReasoningCard(chatId, host) {
    const current = currentEffort(host);
    const lines = [
        `\u{1F9E0} Reasoning \u00B7 ${reasoningLabel(current)}`,
        "",
        "Steers how much deliberation the agent applies on every message.",
        "",
        `current: ${reasoningLabel(current)}`,
    ];
    const options = REASONING_EFFORTS.map((effort) => ({
        id: effort,
        name: reasoningLabel(effort),
        cb: host.token({ action: ACTION_REASONING_SELECT, effort }),
    }));
    await host.openCard(chatId, lines.join("\n"), buildThinkingKeyboard(options, current));
}
export const reasoningExtension = {
    name: "reasoning",
    menuItems: (host) => [
        {
            label: `\u{1F9E0} Reasoning \u00B7 ${reasoningLabel(currentEffort(host))}`,
            cb: CALLBACK_REASONING,
            full: true,
        },
    ],
    barButtons: {
        "\u{1F9E0} Reasoning": (chatId, host) => openReasoningCard(chatId, host),
    },
    callbacks: {
        [CALLBACK_REASONING]: (chatId, _payload, host) => openReasoningCard(chatId, host),
        [ACTION_REASONING_SELECT]: async (chatId, payload, host) => {
            const effort = payload["effort"];
            if (effort === undefined || !isReasoningEffort(effort)) {
                await host.send(chatId, "\u274C Unknown reasoning effort.", { parse_mode: "HTML" });
                return openReasoningCard(chatId, host);
            }
            const changed = host.applyConfig({ reasoning: { effort } });
            if (changed.length === 0) {
                await host.send(chatId, "\u274C Failed to apply reasoning effort.", { parse_mode: "HTML" });
                return openReasoningCard(chatId, host);
            }
            host.refreshAllPanels();
            await host.send(chatId, `\u{1F9E0} Reasoning set to ${reasoningLabel(effort)} \u2014 applied live + persisted.`, { parse_mode: "HTML" });
            return openReasoningCard(chatId, host);
        },
    },
};
/** Harness plugin entry: `dsh-telegram/extensions/reasoning` loader entry.
 * Hot-pluggable: on loader disable/unload the effect disposer unregisters the
 * extension and the core refreshes the UI immediately. */
export const inject = ["telegram"];
export function apply(ctx, _config) {
    const host = ctx.telegram;
    if (host === undefined)
        return;
    host.registerExtension(reasoningExtension);
    ctx.effect(() => () => host.unregisterExtension(reasoningExtension.name));
}
//# sourceMappingURL=reasoning.js.map