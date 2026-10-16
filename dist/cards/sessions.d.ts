/**
 * Sessions / projects / history / search cards for dsh-telegram.
 *
 * The session browser chain: web-style ordered project groups
 * (sessionProjectSnapshot), the paginated Sessions roster (openSessionsCard),
 * the project switcher (openSessionProjectsCard), per-session detail
 * (openSessionDetailCard), the turn-grouped trajectory view (openHistoryCard)
 * and full-text search (openSearchCard).
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. All plugin-root singletons
 * arrive through one deps object so this module owns no mutable wiring of
 * its own.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Bridge } from "../harness/bridge.js";
import type { TelegramTransport } from "../telegram/transport.js";
import type { CardLoad, OpenCard } from "../core/cards.js";
/** Structural slice of the plugin-root state singleton this module reads. */
interface SessionCardsStateSlice {
    /** Chat↔agent bridge (bound-agent highlight + reverse lookups). Undefined while unmounted. */
    readonly bridge: Bridge | undefined;
    /** Last project key shown on the per-chat Sessions card (back navigation). */
    readonly lastSessionsProject: Map<number, string>;
}
export interface SessionCardsDeps {
    state: SessionCardsStateSlice;
    requireCtx(): Context;
    cardLoad: CardLoad;
    openCard: OpenCard;
    uiSend(chatId: number, text: string, options?: Parameters<TelegramTransport["sendText"]>[2]): Promise<number | undefined>;
    token(payload: Record<string, string>, chatId?: number): string;
}
/** Build the session-domain cards. Called once by index.ts; every card closes
 * over the shared deps like the previous module-scope closures did over
 * index.ts singletons. */
export declare function createSessionCards(deps: SessionCardsDeps): {
    lastProjectKey(chatId: number): string | undefined;
    openSessionsCard(chatId: number, projectKey?: string, page?: number): Promise<void>;
    openSessionProjectsCard(chatId: number, page?: number): Promise<void>;
    openSessionDetailCard(chatId: number, sessionId: string): Promise<void>;
    openHistoryCard(chatId: number, sessionId: string, beforeSeq?: number): Promise<void>;
    openSearchCard(chatId: number, query: string, page?: number): Promise<void>;
};
export {};
