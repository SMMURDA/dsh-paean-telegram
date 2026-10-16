/**
 * Misc-domain cards for dsh-telegram.
 *
 * Everything that has no tighter home: the plugins roster (openPluginsCard),
 * skills (openSkillsCard), the subagents browser + detail + continuable
 * probe (openSubagentsCard / openSubagentDetailCard / isContinuableSubagent),
 * background jobs (openJobsCard), dynamic cordis plugins
 * (openDynamicCordisCard), host capabilities (openCapabilitiesCard), message
 * feedback (openFeedbackListCard) and the small display cards — mode,
 * allowed chats, watch, telegram settings, about (openModeCard ..
 * openAboutCard).
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. All plugin-root singletons
 * arrive through one deps object so this module owns no mutable wiring of
 * its own.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { TelegramConfig } from "../config.js";
import type { TelegramTransport } from "../telegram/transport.js";
import { type CardLoad, type OpenCard } from "../core/cards.js";
/** One slow subagent listing must never latch a shared sync promise forever:
 * every later panel refresh would otherwise await the same stuck promise.
 * Shared with index.ts's refreshStatusSubagents. */
export declare const STATUS_SUBAGENTS_TIMEOUT_MS = 5000;
/** Structural slice of the plugin-root state singleton this module reads. */
interface MiscCardsStateSlice {
    /** Active project root (skills cwd fallback, About card). */
    readonly workspaceRoot: string;
    /** Live config (mode name, allowed chats, watch, outbound settings). */
    readonly config: TelegramConfig;
    /** Live transport (About card bot info). Undefined while unmounted. */
    readonly transport: TelegramTransport | undefined;
    /** Whether Telegram long-polling is on (Watch card). */
    readonly watching: boolean;
}
export interface MiscCardsDeps {
    state: MiscCardsStateSlice;
    /** Plugin version reported by the About card (index.ts export). */
    version: string;
    requireCtx(): Context;
    currentAgent(chatId?: number): Agent | undefined;
    boundSessionCwd(ctx: Context, agentId: string | undefined): string | undefined;
    cardLoad: CardLoad;
    openCard: OpenCard;
    token(payload: Record<string, string>, chatId?: number): string;
    log(message: string, error?: unknown): void;
}
/** Build the misc-domain cards. Called once by index.ts; every card closes
 * over the shared deps like the previous module-scope closures did over
 * index.ts singletons. */
export declare function createMiscCards(deps: MiscCardsDeps): {
    openPluginsCard(chatId: number, page?: number): Promise<void>;
    openSkillsCard(chatId: number): Promise<void>;
    openSubagentsCard(chatId: number): Promise<void>;
    isContinuableSubagent(parentId: string, childId: string): Promise<boolean>;
    openSubagentDetailCard(chatId: number, parentId: string, childId: string): Promise<void>;
    openJobsCard(chatId: number, page?: number): Promise<void>;
    openDynamicCordisCard(chatId: number): Promise<void>;
    openCapabilitiesCard(chatId: number): Promise<void>;
    openFeedbackListCard(chatId: number, sessionId: string): Promise<void>;
    openModeCard(chatId: number): Promise<void>;
    openAllowedCard(chatId: number): Promise<void>;
    openWatchCard(chatId: number): Promise<void>;
    openSettingsCard(chatId: number): Promise<void>;
    openAboutCard(chatId: number): Promise<void>;
};
export {};
