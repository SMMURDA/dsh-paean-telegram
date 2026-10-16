/**
 * Todos + Goals cards for dsh-telegram.
 *
 * The live Todos card owns a per-chat 5-second auto-refresh loop
 * (todoCardTimers): the loop only fires while the SAME renderer is still the
 * chat's active card, so Back/Close/any other card stops it on the next tick
 * (issue #14). The Goals card renders the chat agent's current completion
 * goal with edit/pause/clear shortcuts.
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. All plugin-root singletons
 * arrive through one deps object; the timer map and the stop helper are
 * returned so index.ts teardown/ejectChat and openStatusPanel keep using
 * them.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Ephemeral, type ChatOps } from "../telegram/ephemeral.js";
import type { TelegramTransport } from "../telegram/transport.js";
import type { OpenCard } from "../core/cards.js";
export interface GoalCardsDeps {
    requireTransport(): TelegramTransport;
    requireCtx(): Context;
    currentAgent(chatId?: number): Agent | undefined;
    ephemeral: Ephemeral;
    uiOps(t: TelegramTransport): ChatOps;
    /** Active-card renderer map owned by core/cards.ts (loop liveness check). */
    activeCardRenderers: Map<number, () => Promise<void>>;
    openCard: OpenCard;
    token(payload: Record<string, string>, chatId?: number): string;
    log(message: string, error?: unknown): void;
    uiSend(chatId: number, text: string, options?: Parameters<TelegramTransport["sendText"]>[2]): Promise<number | undefined>;
}
/** Build the todos/goals cards and the per-chat Todos refresh loop. Called
 * once by index.ts; every card closes over the shared deps like the previous
 * module-scope closures did over index.ts singletons. */
export declare function createGoalCards(deps: GoalCardsDeps): {
    /** Per-chat 5-second refresh loops for the live Todos card (issue #14). */
    todoCardTimers: Map<number, ReturnType<typeof setInterval>>;
    stopTodoCardRefresh(chatId: number): void;
    openTodosCard(chatId: number): Promise<void>;
    openGoalsCard(chatId: number): Promise<void>;
};
