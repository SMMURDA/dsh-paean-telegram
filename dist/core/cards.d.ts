import { Ephemeral, type ChatOps } from "../telegram/ephemeral.js";
import type { TelegramTransport } from "../telegram/transport.js";
/** Race one promise against a deadline so a hung callee fails its caller. */
export declare function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T>;
/** Telegram sizes the bubble (and its inline keyboard) to the widest text
 * line. A trailing line of non-breaking spaces forces the card to span the
 * maximum bubble width so keyboard rows never leave a right-hand gap. */
export declare function widenCard(text: string): string;
/** Shared card-opener / card-loader signatures consumed by the cards/* domain
 * modules, so every deps interface describes them identically. */
export type OpenCard = (chatId: number, text: string, keyboard: unknown, refresh?: () => Promise<void>) => Promise<void>;
export type CardLoad = <T>(chatId: number, label: string, load: () => Promise<T>) => Promise<T | undefined>;
export interface CardRegistryDeps {
    requireTransport(): TelegramTransport;
    uiOps(t: TelegramTransport): ChatOps;
    ephemeral: Ephemeral;
    /** Mint a callback token; `chatId` (when given) binds the token to its
     * minting chat so take() rejects taps from any other chat (RF-1). */
    token(payload: Record<string, string>, chatId?: number): string;
    log(message: string, error?: unknown): void;
    uiSend(chatId: number, text: string, options?: Parameters<TelegramTransport["sendText"]>[2]): Promise<number | undefined>;
}
/** Build the card registry. Called once by index.ts; the returned functions
 * close over the shared deps like the previous module-scope closures did over
 * index.ts singletons. */
export declare function createCardRegistry(deps: CardRegistryDeps): {
    activeCardRenderers: Map<number, () => Promise<void>>;
    openCard: OpenCard;
    refreshActiveCards(): void;
    askConfirm(chatId: number, text: string, confirmPayload: Record<string, string>, cancelPayload: Record<string, string>): Promise<void>;
    cardLoad: CardLoad;
};
