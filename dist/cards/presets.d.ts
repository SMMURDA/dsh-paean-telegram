/**
 * Agent-preset cards for dsh-telegram.
 *
 * The preset picker chain: the new-session preset chooser (web
 * session.create's agentPreset), the presets roster (openPresetsCard) and the
 * per-preset action sheet (openPresetDetailCard).
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. All plugin-root singletons
 * arrive through one deps object so this module owns no mutable wiring of
 * its own.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { CardLoad, OpenCard } from "../core/cards.js";
export interface PresetCardsDeps {
    requireCtx(): Context;
    currentAgent(chatId?: number): Agent | undefined;
    cardLoad: CardLoad;
    openCard: OpenCard;
    token(payload: Record<string, string>, chatId?: number): string;
}
/** Build the preset-domain cards. Called once by index.ts; every card closes
 * over the shared deps like the previous module-scope closures did over
 * index.ts singletons. */
export declare function createPresetCards(deps: PresetCardsDeps): {
    openNewSessionCard(chatId: number): Promise<void>;
    openPresetsCard(chatId: number): Promise<void>;
    openPresetDetailCard(chatId: number, presetId: string): Promise<void>;
};
