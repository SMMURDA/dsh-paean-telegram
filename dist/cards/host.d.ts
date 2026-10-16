import type { Context } from "@deepseek-ai/cordis";
import type { TelegramConfig } from "../config.js";
import type { OpenCard } from "../core/cards.js";
/** Structural slice of the plugin-root state singleton this module reads. */
interface HostCardsStateSlice {
    /** Active project root (host card cwd context). */
    readonly workspaceRoot: string;
    /** Live config — security.browseRoots gates every directory listing. */
    readonly config: TelegramConfig;
}
export interface HostCardsDeps {
    state: HostCardsStateSlice;
    requireCtx(): Context;
    openCard: OpenCard;
    token(payload: Record<string, string>, chatId?: number): string;
}
/** Build the host-domain cards. Called once by index.ts; every card closes
 * over the shared deps like the previous module-scope closures did over
 * index.ts singletons. */
export declare function createHostCards(deps: HostCardsDeps): {
    openHostSettingsCard(chatId: number): Promise<void>;
    openSettingsNamespaceCard(chatId: number, ns: string): Promise<void>;
    openCredentialsCard(chatId: number): Promise<void>;
    openHostCard(chatId: number): Promise<void>;
    openHostDirectoryCard(chatId: number, path: string, page?: number): Promise<void>;
};
export {};
