/**
 * Queue card for dsh-telegram.
 *
 * Renders the bound agent's inbox queue (next-turn/step items) plus the live
 * goal-progress line and outbound send backlog for the chat.
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. All plugin-root singletons
 * arrive through one deps object so this module owns no mutable wiring of
 * its own.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { type QueueItem } from "../harness/adapters/sessions.js";
import type { ProgressSnapshot } from "../telegram/goal-progress.js";
import type { TelegramTransport } from "../telegram/transport.js";
import type { OpenCard } from "../core/cards.js";
/** Structural slice of the plugin-root state singleton this module reads. */
interface QueueCardsStateSlice {
    /** Live transport (outbound send backlog). Undefined while unmounted. */
    readonly transport: TelegramTransport | undefined;
}
export interface QueueCardsDeps {
    state: QueueCardsStateSlice;
    requireCtx(): Context;
    currentAgent(chatId?: number): Agent | undefined;
    boundAgentId(chatId?: number): string | undefined;
    progressFor(chatId: number): ProgressSnapshot | undefined;
    openCard: OpenCard;
}
/** Render one numbered queue preview line. Pure so the text and button windows
 * can be tested side by side (QC-1). */
export declare function renderQueuePreviewLine(item: QueueItem, index: number): string;
/** Build the queue card. Called once by index.ts; the card closes over the
 * shared deps like the previous module-scope closure did over index.ts
 * singletons. */
export declare function createQueueCards(deps: QueueCardsDeps): {
    openQueueCard(chatId: number): Promise<void>;
};
export {};
