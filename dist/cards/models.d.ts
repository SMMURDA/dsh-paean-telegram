/**
 * Models / providers / reasoning-effort cards for dsh-telegram.
 *
 * The model picker chain: catalog overview (openModelsCard), per-provider
 * deployment facts (openProvidersCard), paginated per-provider model list
 * with the current selection (openProviderModelsCard) and the per-session
 * reasoning-effort picker (openModelThinkingCard).
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. All plugin-root singletons
 * arrive through one deps object so this module owns no mutable wiring of
 * its own.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { TelegramConfig } from "../config.js";
import type { CardLoad, OpenCard } from "../core/cards.js";
/** Structural slice of the plugin-root state singleton this module reads. */
interface ModelCardsStateSlice {
    /** Live config (reasoning-effort default). */
    readonly config: TelegramConfig;
}
export interface ModelCardsDeps {
    state: ModelCardsStateSlice;
    requireCtx(): Context;
    currentAgent(chatId?: number): Agent | undefined;
    cardLoad: CardLoad;
    openCard: OpenCard;
    token(payload: Record<string, string>, chatId?: number): string;
    log(message: string, error?: unknown): void;
}
/** Build the model-domain cards. Called once by index.ts; every card closes
 * over the shared deps like the previous module-scope closures did over
 * index.ts singletons. */
export declare function createModelCards(deps: ModelCardsDeps): {
    openModelsCard(chatId: number): Promise<void>;
    openProvidersCard(chatId: number): Promise<void>;
    openProviderModelsCard(chatId: number, providerId: string, page?: number): Promise<void>;
    openModelThinkingCard(chatId: number, providerId: string, modelId: string): Promise<void>;
    currentReasoningEffort(): "minimal" | "low" | "medium" | "high" | "max";
};
export {};
