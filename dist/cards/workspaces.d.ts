import type { Context } from "@deepseek-ai/cordis";
import type { TelegramConfig } from "../config.js";
import type { TelegramTransport } from "../telegram/transport.js";
import type { OpenCard } from "../core/cards.js";
/** Structural slice of the plugin-root state singleton this module reads and
 * mutates: applyProjectPath reassigns the active project root, persists the
 * config to disk and registers the folder with the workspace registry. */
interface WorkspaceCardsStateSlice {
    /** Active project folder — new sessions are created under it. */
    workspaceRoot: string;
    /** Boot workspace that owns `.pi/telegram.json` (config never moves). */
    configRoot: string;
    /** Live config; applyProjectPath writes workspace.activePath. */
    config: TelegramConfig;
}
export interface WorkspaceCardsDeps {
    state: WorkspaceCardsStateSlice;
    requireCtx(): Context;
    uiSend(chatId: number, text: string, options?: Parameters<TelegramTransport["sendText"]>[2]): Promise<number | undefined>;
    openCard: OpenCard;
    token(payload: Record<string, string>, chatId?: number): string;
    log(message: string, error?: unknown): void;
    openMenuAt(chatId: number, page: number): Promise<void>;
}
/** Build the workspace-domain cards. Called once by index.ts; every card
 * closes over the shared deps like the previous module-scope closures did
 * over index.ts singletons. */
export declare function createWorkspaceCards(deps: WorkspaceCardsDeps): {
    openWorkspacesCard(chatId: number): Promise<void>;
    openWorkspaceDetailCard(chatId: number, workspaceId: string): Promise<void>;
    openProjectCard(chatId: number, target?: string, offset?: number): Promise<void>;
    applyProjectPath(chatId: number, raw: string): Promise<void>;
    openWorkspaceCreatePicker(chatId: number, path: string, offset?: number): Promise<void>;
};
export {};
