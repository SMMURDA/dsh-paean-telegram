/**
 * Interactive answering (web ApiProxy `respond` for approval/question frames).
 * Mirrors the api-proxy semantics exactly:
 *   - approvals: `approval/request` waterfall listener claims the pending
 *     approval/asked event (callId-matched) and settles it with the button
 *     answer;
 *   - questions: `ctx.userQuestions.registerProvider` owns the ask() promise
 *     and settles it with the submitted answers.
 *
 * Both card flows (approval cards and question cards) share ONE internal
 * `CardSession` lifecycle — mint id -> broadcast with keyboard -> record
 * messageIds -> settle by editing in place -> abort cleanup, including the
 * zero-delivery / broadcast-rejection failure paths.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { QuestionOwnership } from "../../config.js";
export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled";
/** What the user tapped. Scoped grants settle the approval as allowed-once
 * while remembering the wider permission for later requests. */
export type ApprovalAnswer = ApprovalOutcome | "allowed-goal" | "allowed-session" | "allowed-always";
/** Structural subset of the host API proxy seam (SYNC-1). The actual
 * `ctx.apiProxy` object may carry more members; we only require the small
 * surface the dual-channel flow uses. */
export interface ApiProxyLike {
    events: {
        mux(request: unknown, signal: AbortSignal): AsyncIterable<{
            rpcId: string;
            payload: MuxFrameLike;
        }>;
    };
    respond(message: {
        type: "client-response";
        rpcId: string;
        result: {
            ok: true;
            value: unknown;
        } | {
            ok: false;
            error: {
                code?: string;
                message?: string;
                details?: unknown;
            };
        };
    }): Promise<{
        accepted: boolean;
        reason?: string;
    }>;
}
/** Mux frames relevant to approval/question dual-channel sync. Unknown frame
 * types are ignored by the adapter. */
export type MuxFrameLike = {
    type: "approval/requested";
    sessionId: string;
    approvalId: string;
    toolName: string;
    callId?: string;
    reason?: string;
} | {
    type: "approval/resolved";
    sessionId: string;
    approvalId: string;
    outcome: ApprovalOutcome;
} | {
    type: "question/requested";
    sessionId: string;
    questions: QuestionItemLike[];
} | {
    type: "question/resolved";
    sessionId: string;
    questionRpcId: string;
    outcome: "answered" | "cancelled";
} | {
    type: string;
};
export interface BroadcastDelivery {
    chatId: number;
    messageId: number;
}
export interface InteractiveDelivery {
    /** Send one Telegram message. When `chatId` is provided only that chat
     * receives it; otherwise the delivery defaults to every whitelisted chat. */
    broadcast(text: string, keyboard: unknown, chatId?: number): Promise<BroadcastDelivery[]>;
    edit(chatId: number, messageId: number, text: string, keyboard: unknown): Promise<boolean>;
    /** Resolve the chat that owns a dsh session (per-chat routing). Absent =
     * legacy broadcast-to-all behavior. */
    chatForSession?(sessionId: string): number | undefined;
}
interface QuestionOptionLike {
    /** Selected value echoed back in the answer. Required in the dsh contract;
     * legacy test shapes also carry an `id`. */
    label: string;
    description?: string;
    id?: string;
}
interface QuestionItemLike {
    id: string;
    question: string;
    detail?: string;
    header?: string;
    options?: QuestionOptionLike[];
    multiSelect?: boolean;
    intent?: {
        kind?: string;
        approve?: string;
    };
}
interface PendingQuestion {
    id: number;
    sessionId: string;
    questions: QuestionItemLike[];
    resolve: (answer: {
        answers: {
            id: string;
            selected: string[];
            custom?: string;
        }[];
    }) => void;
    reject: (err: Error) => void;
    /** The broadcast card this question waits on (messageIds + settle). */
    card: CardSession;
    selections: Map<string, string[]>;
    custom: Map<string, string>;
    /** api-proxy mux rpcId; only set for dual-mode questions. */
    rpcId?: string;
    /** SYNC-1 dual-mode detach path: close only the local Telegram card and
     * leave the web-side ask untouched (no `apiProxy.respond`). */
    closeLocal?: (err: Error) => void;
}
/** Read `ctx.apiProxy` structurally (SYNC-1). Returns undefined when the
 * host did not mount the api-proxy or the seam does not expose the two
 * functions we rely on. */
export declare function apiProxySeam(ctx: Context): ApiProxyLike | undefined;
export interface Interactive {
    /** `chatId` binds settlement to the chats the card was delivered to
     * (IA-1 #3): a tap relayed from any other chat is refused instead of
     * settling someone else's pending approval. */
    answerApproval(chatId: number, id: number, answer: ApprovalAnswer): boolean;
    /** Hot-update the persisted forever-allow set (e.g. /config changed it). */
    setAllowedTools(tools: readonly string[]): void;
    toggleQuestionOption(chatId: number, id: number, questionId: string, optionId: string): Promise<boolean>;
    setQuestionCustom(chatId: number, id: number, questionId: string, text: string): Promise<boolean>;
    /** Stage free text for one question by index and settle the card in the same
     * call when that question carries no options: a text-only question has nothing
     * left to choose, so demanding a separate Submit tap left the tool call — and
     * the whole turn — waiting until the operator aborted it. `staged` means the
     * card is still open (an option-bearing question, or an unanswered sibling). */
    answerQuestionText(chatId: number, id: number, questionIndex: number, text: string): Promise<"submitted" | "staged" | "stale">;
    submitQuestions(chatId: number, id: number): Promise<boolean>;
    cancelQuestions(chatId: number, id: number): Promise<boolean>;
    detach(): void;
}
/** Whether the "Allow forever" button should carry a warning emoji. */
export declare function isRiskyTool(toolName: string): boolean;
/** One interactive card's shared lifecycle, owned here exactly once
 * (🟡-5; red-2 / LOOP_AUDIT #4): mint an id, publish the card with its
 * inline keyboard, remember which chats it landed in, settle every landed
 * copy in place, and unwind the abort listener. Zero delivered chats and a
 * rejected broadcast route through the same `onDeliveryFailed` hook via a
 * two-argument `.then`, so pending work settles instead of waiting forever
 * on a card nobody ever received. IA-1 #1: settlement is terminal and
 * idempotent — the first `settle` fixes the terminal text, and any copy of
 * the card that lands AFTER an abort/detach race is stripped immediately
 * instead of staying live with dead tokens. */
interface CardSession {
    /** The minted pending id — registry key and callback_data prefix. */
    readonly id: number;
    /** chatId -> messageId for every chat the card actually reached. */
    readonly messageIds: Map<number, number>;
    /** Publish the card. `onDeliveryFailed` runs when the broadcast rejected
     * or delivered nothing; by then the abort listener is already unwound. */
    deliver(text: string, keyboard: unknown, onDeliveryFailed: () => void): void;
    /** Edit every landed card in place (bare status fallback when none did)
     * and unwind the abort listener. Idempotent: only the first call edits. */
    settle(text: string): Promise<void>;
    /** Unwind the abort listener without touching any card. */
    dispose(): void;
}
export declare function questionIdAt(id: number, index: number): string | undefined;
export declare function renderQuestions(pending: PendingQuestion, chatId: number): string;
export declare function questionKeyboard(pendingId: number, chatId: number): unknown;
export interface InteractiveOptions {
    /** Explicit channel ownership for `ask_user_question`. Defaults to `both`
     * (Telegram + web sync when the api-proxy seam exists; Telegram-only when it
     * does not). */
    userQuestions?: QuestionOwnership;
    /** Diagnostic sink; defaults to console.error. */
    log?: (message: string, error?: unknown) => void;
    /** Resolve the current goal id for one agent/session. Absent = no
     * goal-scoped approval button. */
    goalIdForSession?: (sessionId: string) => string | undefined;
    /** Tool names already allowed forever (loaded from persisted config). */
    allowedTools?: readonly string[];
    /** Persist a new forever-allow for one tool. Return false when the write
     * failed; the grant stays live in memory for this plugin mount. */
    persistToolAllow?: (toolName: string) => boolean;
    /** SYNC-1: host api-proxy seam for dual Telegram + web interactive cards.
     * Usually supplied from `apiProxySeam(ctx)` at the call site. */
    apiProxy?: ApiProxyLike;
}
export declare function attachInteractive(ctx: Context, delivery: InteractiveDelivery, options?: InteractiveOptions): Interactive;
export {};
