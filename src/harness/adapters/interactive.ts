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
import { sessionEvents } from "./session-read.js";

export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled";
/** What the user tapped. Scoped grants settle the approval as allowed-once
 * while remembering the wider permission for later requests. */
export type ApprovalAnswer = ApprovalOutcome | "allowed-goal" | "allowed-session" | "allowed-always";

/** Structural subset of the host API proxy seam (SYNC-1). The actual
 * `ctx.apiProxy` object may carry more members; we only require the small
 * surface the dual-channel flow uses. */
export interface ApiProxyLike {
  events: {
    mux(request: unknown, signal: AbortSignal): AsyncIterable<{ rpcId: string; payload: MuxFrameLike }>;
  };
  respond(message: {
    type: "client-response";
    rpcId: string;
    result: { ok: true; value: unknown } | { ok: false; error: { code?: string; message?: string; details?: unknown } };
  }): Promise<{ accepted: boolean; reason?: string }>;
}

/** Mux frames relevant to approval/question dual-channel sync. Unknown frame
 * types are ignored by the adapter. */
export type MuxFrameLike =
  | { type: "approval/requested"; sessionId: string; approvalId: string; toolName: string; callId?: string; reason?: string }
  | { type: "approval/resolved"; sessionId: string; approvalId: string; outcome: ApprovalOutcome }
  | { type: "question/requested"; sessionId: string; questions: QuestionItemLike[] }
  | { type: "question/resolved"; sessionId: string; questionRpcId: string; outcome: "answered" | "cancelled" }
  | { type: string };

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

interface ApprovalRequestLike {
  agent: { id: string; session: { events: readonly { seq: number; type: string; data?: Record<string, unknown> }[] } };
  toolName: string;
  callId?: string;
  reason?: string;
  signal?: AbortSignal;
}

interface PendingApproval {
  id: number;
  approvalId: string;
  sessionId: string;
  toolName: string;
  reason?: string;
  /** Current goal id, when the chat has one — enables goal-scoped grants. */
  goalId?: string;
  /** api-proxy mux rpcId; only set for dual-mode approvals. */
  rpcId?: string;
  resolve: (outcome: ApprovalOutcome, display?: string) => void;
  /** The broadcast card this approval waits on (messageIds + settle). */
  card: CardSession;
  cardText: string;
  /** SYNC-1 dual-mode detach path: close only the local Telegram card and
   * leave the web-side ask untouched (no `apiProxy.respond`). */
  closeLocal?: () => void;
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
  intent?: { kind?: string; approve?: string };
}

interface QuestionRequestLike {
  agent?: { id: string };
  questions: QuestionItemLike[];
  signal?: AbortSignal;
}

interface PendingQuestion {
  id: number;
  sessionId: string;
  questions: QuestionItemLike[];
  resolve: (answer: { answers: { id: string; selected: string[]; custom?: string }[] }) => void;
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

interface QuestionsServiceLike {
  registerProvider(provider: { ask(request: QuestionRequestLike): Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }> }): () => void;
  /** The single active UI provider; web UI sets this when it owns the seam. */
  provider?: unknown;
}

interface LoaderEntryLike {
  disabled?: boolean;
  options?: { name?: string; group?: unknown };
}

interface LoaderLike {
  entries(): Iterable<LoaderEntryLike>;
}

/** The web API proxy owns the single userQuestions provider when mounted. */
function webUiOwnsQuestions(ctx: Context): boolean {
  const loader = ctx.get("loader") as LoaderLike | undefined;
  if (!loader) return false;
  for (const entry of loader.entries()) {
    if (entry.disabled === true) continue;
    if (entry.options?.name === "@deepseek-ai/dsh-host-apiproxy") return true;
  }
  return false;
}

/** Read `ctx.apiProxy` structurally (SYNC-1). Returns undefined when the
 * host did not mount the api-proxy or the seam does not expose the two
 * functions we rely on. */
export function apiProxySeam(ctx: Context): ApiProxyLike | undefined {
  const candidate = ctx.get("apiProxy");
  if (candidate === undefined || candidate === null || typeof candidate !== "object") return undefined;
  const events = (candidate as { events?: unknown }).events;
  const respond = (candidate as { respond?: unknown }).respond;
  if (events === undefined || events === null || typeof events !== "object") return undefined;
  if (typeof (events as { mux?: unknown }).mux !== "function") return undefined;
  if (typeof respond !== "function") return undefined;
  return candidate as ApiProxyLike;
}

/** Stable option identity inside one question: label is the protocol value;
 * a numeric token keeps callback_data tiny even for long labels. */
function optionKey(option: QuestionOptionLike, index: number): string {
  return String(index);
}

function optionValue(option: QuestionOptionLike): string {
  return option.label;
}

function findOption(question: QuestionItemLike, token: string): QuestionOptionLike | undefined {
  const options = question.options ?? [];
  const index = Number(token);
  if (Number.isInteger(index) && index >= 0 && index < options.length) return options[index];
  return options.find((option) => option.id === token || option.label === token);
}

/** Same validation the user-questions service applies before `provider.ask`. */
function assertValidRequest(ctx: Context, request: QuestionRequestLike): void {
  if (request.signal?.aborted === true) {
    throw new Error("ask_user_question was aborted before the user answered");
  }
  if (request.questions.length === 0) {
    throw new Error("ask_user_question requires at least one question");
  }
  const agent = request.agent;
  if (agent === undefined) return;
  const agents = ctx.get("agents") as { get(id: unknown): unknown; roots?(): unknown[] } | undefined;
  if (agents === undefined || agents.get(agent.id) !== agent) {
    throw new Error("human interaction requires the exact live calling agent when an agent is supplied");
  }
  if (typeof agents.roots === "function" && !agents.roots().includes(agent)) {
    throw new Error(
      "human interaction is unavailable while the calling agent is owned by another live agent; " +
      "include the unresolved question or decision in the child agent's final result",
    );
  }
  for (const question of request.questions) {
    const intent = question.intent;
    if (intent === undefined) continue;
    const approve = intent.approve;
    if (approve !== undefined && !(question.options ?? []).some((option) => option.label === approve)) {
      throw new Error(`question ${question.id} declares an intent whose approve label names none of its options`);
    }
    if (question.detail === undefined) {
      throw new Error(`question ${question.id} declares an intent without the detail it reviews`);
    }
  }
}

interface ApprovalServiceLike {
  on?: unknown;
}

interface CordisEventsLike {
  on<K extends string>(name: K, listener: (...args: unknown[]) => unknown): () => void;
}

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

const approvals = new Map<number, PendingApproval>();
const questions = new Map<number, PendingQuestion>();
/** SYNC-1 dual mode: api-proxy rpcId -> Telegram card id, used to dedupe
 * replayed mux frames and to settle the local card when the web side sends an
 * approval/resolved or question/resolved frame. */
const approvalByRpc = new Map<string, number>();
const questionByRpc = new Map<string, number>();
/** Goal ids the user granted: later approvals under the same goal auto-allow. */
const grantedGoals = new Set<string>();
/** sessionId -> tool names the user granted for the rest of that session. */
const grantedSessions = new Map<string, Set<string>>();
/** Tool names the user granted forever (persisted by the host via options). */
const grantedTools = new Set<string>();
let counter = 0;

/** Tools whose irreversible actions deserve a warning on the forever button.
 * Unknown tools default to normal: showing the option is more useful than
 * hiding it behind a risk table the plugin cannot keep complete. */
const HIGH_RISK_TOOLS = new Set(["bash", "shell", "exec", "sudo", "write", "edit", "delete", "remove", "rm", "kill", "stop", "abort", "publish", "uninstall"]);

/** Whether the "Allow forever" button should carry a warning emoji. */
export function isRiskyTool(toolName: string): boolean {
  const name = toolName.trim().toLowerCase();
  if (HIGH_RISK_TOOLS.has(name)) return true;
  return /\b(bash|shell|exec|delete|remove|rm|kill|abort|uninstall)\b/.test(name);
}

function mint(): number {
  counter += 1;
  return counter;
}

async function reRenderQuestion(ctx: Context, pending: PendingQuestion, chatId: number, delivery: InteractiveDelivery): Promise<void> {
  const messageId = pending.card.messageIds.get(chatId);
  if (messageId === undefined) return;
  const text = renderQuestions(pending, chatId);
  await delivery.edit(chatId, messageId, text, questionKeyboard(pending.id, chatId)).catch(() => {});
  void ctx;
}

/** Resolve one pending card once every question carries an answer: a question
 * with options needs a selection or staged custom text, a text-only question
 * needs nothing beyond what staging already did. Returns false while a sibling
 * question is still unanswered, leaving the card pending for a later Submit. */
function settleQuestionCard(pending: PendingQuestion, id: number): boolean {
  const answers: { id: string; selected: string[]; custom?: string }[] = [];
  for (const question of pending.questions) {
    const selected = pending.selections.get(question.id) ?? [];
    const custom = pending.custom.get(question.id);
    if (selected.length === 0 && custom === undefined && question.options?.length) return false;
    answers.push({ id: question.id, selected, ...(custom === undefined ? {} : { custom }) });
  }
  questions.delete(id);
  pending.resolve({ answers });
  void pending.card.settle(`\u2705 Questions answered (id ${id}).`);
  return true;
}

/** Prefer the chat bound to the requesting session; fall back to the legacy
 * broadcast-to-all only when the host offers no per-chat resolver. The
 * microtask hop (IA-1 #2) turns a synchronously throwing `broadcast` into a
 * rejected promise so `deliver`'s rejection branch always owns the unwind —
 * a sync throw would otherwise escape past both `.then` handlers and strand
 * the freshly registered abort listener plus its pending entry. */
function broadcastForSession(delivery: InteractiveDelivery, sessionId: string, text: string, keyboard: unknown): Promise<BroadcastDelivery[]> {
  return Promise.resolve().then(() => delivery.broadcast(text, keyboard, delivery.chatForSession?.(sessionId)));
}

/** SC-2/RF-1 ownership for interactive cards: only a chat that actually
 * received this card may act on it (IA-1 #3). Legacy broadcast cards record
 * every delivered chat, and each of those copies legitimately answers. */
function ownsCard(card: CardSession, chatId: number): boolean {
  return card.messageIds.has(chatId);
}

/** Settle/status text edits each card that actually received it in place
 * (Telegram users expect the answered card to lose its buttons, not spawn a
 * second status message next to a stale clickable card). When no card ever
 * landed, fall back to a bare status message so the outcome is not lost. */
async function settleCards(delivery: InteractiveDelivery, messageIds: ReadonlyMap<number, number>, fallbackChat: number | undefined, text: string): Promise<void> {
  if (messageIds.size === 0) {
    if (fallbackChat !== undefined) await delivery.broadcast(text, undefined, fallbackChat).catch(() => {});
    return;
  }
  await Promise.all(
    [...messageIds].map(([chatId, messageId]) =>
      delivery.edit(chatId, messageId, text, undefined).catch(() => {}),
    ),
  );
}

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

/** Open a card session for one dsh session's interactive card. `onAbort`
 * fires at most once per settlement and never after `settle`/`dispose`; a
 * signal that arrived already aborted reports through the same hook
 * asynchronously instead of leaving the card unwatched. */
function openCardSession(
  delivery: InteractiveDelivery,
  sessionId: string,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): CardSession {
  const id = mint();
  const messageIds = new Map<number, number>();
  let unwound = false;
  /** Terminal text captured by the first settle (IA-1 #1): late-landing
   * copies of this card are stripped with exactly this text. */
  let terminalText: string | undefined;
  // Exactly-once registration and unwind (IA-1 #2): every exit — settle,
  // dispose, delivery failure, abort — funnels through `unwind`, so a
  // long-lived signal can never accumulate this session's listeners.
  const unwind = () => {
    if (unwound) return;
    unwound = true;
    signal?.removeEventListener("abort", onAbort);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted === true) Promise.resolve().then(onAbort);
  return {
    id,
    messageIds,
    deliver(text, keyboard, onDeliveryFailed) {
      void broadcastForSession(delivery, sessionId, text, keyboard).then(
        (delivered) => {
          // An abort/detach that raced the in-flight broadcast must not leave
          // a freshly landed card alive with clickable dead tokens (IA-1 #1):
          // strip the late copy at once and record nothing.
          if (terminalText !== undefined) {
            if (delivered.length > 0) {
              void settleCards(delivery, new Map(delivered.map((entry) => [entry.chatId, entry.messageId])), undefined, terminalText);
            }
            return;
          }
          for (const entry of delivered) messageIds.set(entry.chatId, entry.messageId);
          // Zero deliveries would leave the pending work waiting forever on
          // a card no chat can answer (LOOP_AUDIT #4): take the failure path.
          if (delivered.length === 0) {
            unwind();
            onDeliveryFailed();
          }
        },
        // A rejected broadcast delivered nothing either: take the same path
        // as zero deliveries so nothing waits on a card never sent (red-2).
        () => {
          unwind();
          onDeliveryFailed();
        },
      );
    },
    settle(text) {
      const first = terminalText === undefined;
      if (first) terminalText = text;
      unwind();
      // Idempotent (IA-1 #1): repeat settles — double-settle races, an abort
      // arriving after a user answer's guard slipped — never re-edit.
      if (!first) return Promise.resolve();
      return settleCards(delivery, messageIds, delivery.chatForSession?.(sessionId), text);
    },
    dispose: unwind,
  };
}

export function questionIdAt(id: number, index: number): string | undefined {
  const pending = questions.get(id);
  return pending?.questions[index]?.id;
}

export function renderQuestions(pending: PendingQuestion, chatId: number): string {
  const lines = [`\u2753 ${pending.sessionId ? `Session ${pending.sessionId}` : "Session"} asks (id ${pending.id}):`, ""];
  pending.questions.forEach((question, index) => {
    lines.push(`${index + 1}. ${question.header ? `[${question.header}] ` : ""}${question.question}`);
    if (question.detail) lines.push(`   ${question.detail}`);
    const selected = pending.selections.get(question.id) ?? [];
    const custom = pending.custom.get(question.id);
    if (question.options?.length) {
      for (const option of question.options) {
        lines.push(`   ${selected.includes(optionValue(option)) ? "\u2705" : "\u25CB"} ${option.label}`);
      }
      if (question.multiSelect) lines.push("   (multi-select: tap to toggle)");
    } else {
      // A text-only question needs one step, not two: `/answer` settles it on
      // its own (see `answerQuestionText`). The old hint named only the reply
      // command while the actual settle still waited for a Submit tap, which is
      // exactly how an operator ends up aborting a turn that looks hung.
      lines.push(selected.length ? `   \u2705 ${selected[0]}` : "   \u25CB (reply with /answer <id> <question-number> <text> \u2014 it submits by itself)");
    }
    if (custom) lines.push(`   \u270F custom: ${custom}`);
    void chatId;
  });
  return lines.join("\n").slice(0, 3800);
}

export function questionKeyboard(pendingId: number, chatId: number): unknown {
  const pending = questions.get(pendingId);
  if (!pending) return undefined;
  const rows: { text: string; callback_data: string }[][] = [];
  pending.questions.forEach((question, index) => {
    (question.options ?? []).slice(0, 24).forEach((option, optionIndex) => {
      const selected = pending.selections.get(question.id) ?? [];
      const marked = selected.includes(optionValue(option)) ? "\u2705 " : "";
      rows.push([{ text: `${index + 1}:${marked}${option.label}`.slice(0, 40), callback_data: `qu:${pendingId}:${index}:${optionKey(option, optionIndex)}`.slice(0, 64) }]);
    });
  });
  rows.push([
    { text: "\u2714\uFE0F Submit", callback_data: `qu:${pendingId}:s` },
    { text: "\u2716 Cancel", callback_data: `qu:${pendingId}:c` },
  ]);
  return { inline_keyboard: rows };
}

function approvalKeyboard(id: number, goalId: string | undefined, toolName: string): unknown {
  const rows: { text: string; callback_data: string }[][] = [];
  const scoped: { text: string; callback_data: string }[] = [];
  if (goalId !== undefined) {
    scoped.push({ text: "\u{1F7E2} Allow for this goal", callback_data: `ap:${id}:g` });
  }
  scoped.push({ text: "\u{1F7E3} Allow for this session", callback_data: `ap:${id}:s` });
  rows.push(scoped);
  rows.push([
    { text: "\u2705 Allow once", callback_data: `ap:${id}:y` },
    { text: "\u274C Reject", callback_data: `ap:${id}:n` },
  ]);
  rows.push([
    {
      text: isRiskyTool(toolName) ? "\u{1F7E4} Allow forever \u26A0\uFE0F risky" : "\u{1F7E4} Allow forever (by tool)",
      callback_data: `ap:${id}:a`,
    },
  ]);
  return { inline_keyboard: rows };
}

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

interface ToolExecutionLike {
  name?: string;
  arguments?: { questions?: unknown };
  agent?: { id: string };
  signal?: AbortSignal;
}

/** Project a `tools/execute` execution for `ask_user_question` onto the same
 * request shape the user-questions service forwards to providers. */
function toQuestionRequest(exec: ToolExecutionLike): QuestionRequestLike | undefined {
  if (exec.name !== "ask_user_question") return undefined;
  const raw = exec.arguments?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const questions: QuestionItemLike[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const item = entry as {
      id?: unknown;
      question?: unknown;
      detail?: unknown;
      header?: unknown;
      options?: unknown;
      multi_select?: unknown;
    };
    if (typeof item.id !== "string" || typeof item.question !== "string") return undefined;
    let options: QuestionOptionLike[] | undefined;
    if (item.options !== undefined) {
      if (!Array.isArray(item.options)) return undefined;
      options = [];
      for (const option of item.options) {
        const value = option as { label?: unknown; description?: unknown };
        // Leave malformed arguments for the tool body's schema validation.
        if (typeof value.label !== "string") return undefined;
        options.push({
          label: value.label,
          ...(typeof value.description === "string" ? { description: value.description } : {}),
        });
      }
    }
    questions.push({
      id: item.id,
      question: item.question,
      ...(typeof item.detail === "string" ? { detail: item.detail } : {}),
      ...(typeof item.header === "string" ? { header: item.header } : {}),
      ...(options === undefined ? {} : { options }),
      ...(item.multi_select === true ? { multiSelect: true } : {}),
    });
  }
  return {
    ...(exec.agent === undefined ? {} : { agent: exec.agent }),
    questions,
    ...(exec.signal === undefined ? {} : { signal: exec.signal }),
  };
}

/** Create the pending Telegram question card and wait for the user's answer. */
function askViaTelegram(delivery: InteractiveDelivery, request: QuestionRequestLike): Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }> {
  const sessionId = request.agent?.id;
  if (sessionId === undefined) return Promise.reject(new Error("telegram user interaction requires an agent-owned session"));
  // Same shape as assertValidRequest's abort check: a signal that arrived
  // already aborted must fail fast, not broadcast a dead card.
  if (request.signal?.aborted === true) {
    return Promise.reject(new Error("ask_user_question was aborted before the user answered"));
  }
  return new Promise((resolve, reject) => {
    const card = openCardSession(delivery, sessionId, request.signal, () => {
      if (!questions.delete(card.id)) return;
      // IA-1 #1: an aborted ask must not leave its already-delivered card
      // clickable — taps would hit dead tokens forever. Settle every landed
      // copy to a terminal closed state (also unwinds the abort listener,
      // IA-1 #2). Safe against a settle that raced in first: idempotent.
      void card.settle(`\u2753 Session ${sessionId} asks (id ${card.id}):\n\n\u2716 Question aborted \u2014 its buttons are closed.`);
      reject(new Error("ask_user_question was aborted before the user answered"));
    });
    const pending: PendingQuestion = {
      id: card.id,
      sessionId,
      questions: request.questions,
      resolve,
      reject,
      card,
      selections: new Map(),
      custom: new Map(),
    };
    pending.questions.forEach((question) => pending.selections.set(question.id, []));
    questions.set(card.id, pending);
    card.deliver(renderQuestions(pending, 0), questionKeyboard(card.id, 0), () => {
      // A broadcast that rejected or delivered nothing leaves no card any
      // chat could answer: settle with a clear error instead of letting the
      // tool execution wait forever (LOOP_AUDIT #4 / red-2).
      if (questions.delete(card.id)) {
        reject(new Error("no allowed Telegram chat is available to answer this question"));
      }
    });
  });
}

export function attachInteractive(ctx: Context, delivery: InteractiveDelivery, options: InteractiveOptions = {}): Interactive {
  const disposers: (() => void)[] = [];
  const ownership = options.userQuestions ?? "both";
  const log = options.log ?? ((message: string, error?: unknown) => console.error(`[dsh-telegram] ${message}`, error ?? ""));
  const goalIdForSession = options.goalIdForSession;
  // Reset per attach (🟠-6 / IA-6): a re-mount must reflect exactly the
  // current persisted allow list. Goal and session grants are mount-scoped
  // too, so clear them alongside the permanent tool grants — accumulating
  // across mounts would let a hot reload leave stale approvals behind.
  grantedGoals.clear();
  grantedSessions.clear();
  grantedTools.clear();
  for (const toolName of options.allowedTools ?? []) {
    if (toolName.trim() !== "") grantedTools.add(toolName.trim());
  }

  const apiProxy = options.apiProxy ?? apiProxySeam(ctx);
  const dual = ownership === "both" && apiProxy !== undefined;
  const effectiveOwnership = ownership === "both" && !dual ? "telegram" : ownership;

  if (dual) {
    // SYNC-1 dual-channel mode: do not compete with the web for the
    // approval waterfall or the single userQuestions provider. Instead we
    // subscribe to the api-proxy mux and mirror every pending ask to
    // Telegram. Whichever side resolves first settles both representations;
    // a Telegram-only card failure intentionally leaves the web ask alive.
    approvalByRpc.clear();
    questionByRpc.clear();

    const controller = new AbortController();
    disposers.push(() => controller.abort());

    const respondApproval = async (rpcId: string, requested: Extract<MuxFrameLike, { type: "approval/requested" }>, outcome: ApprovalOutcome): Promise<void> => {
      await apiProxy!.respond({
        type: "client-response",
        rpcId,
        result: {
          ok: true,
          value: {
            sessionId: requested.sessionId,
            approvalId: requested.approvalId,
            outcome,
          },
        },
      });
    };

    const handleFrame = (envelope: { rpcId: string; payload: MuxFrameLike }): void => {
      if (envelope === null || envelope === undefined || envelope.payload === null || envelope.payload === undefined || typeof envelope.payload !== "object") return;
      const frame = envelope.payload;
      if (frame.type === "approval/requested" && "approvalId" in frame) {
        const requested = frame as Extract<MuxFrameLike, { type: "approval/requested" }>;
        if (approvalByRpc.has(envelope.rpcId)) return;
        const goalId = goalIdForSession?.(requested.sessionId);
        const toolName = requested.toolName.trim();
        if (
          (goalId !== undefined && grantedGoals.has(goalId)) ||
          grantedTools.has(toolName) ||
          (grantedSessions.get(requested.sessionId)?.has(toolName) ?? false)
        ) {
          // A grant already covers this request: answer the web immediately.
          void respondApproval(envelope.rpcId, requested, "allowed-once").catch((err) => log(`api-proxy granted-approval respond failed for ${requested.approvalId}`, err));
          return;
        }

        const cardText = `\u{1F6E1} Approval requested \u00B7 ${requested.toolName}${requested.reason ? `\nReason: ${requested.reason}` : ""}\nSession: ${requested.sessionId}`;
        const card = openCardSession(delivery, requested.sessionId, undefined, () => {});
        const settle = (outcome: ApprovalOutcome, display: string = outcome): void => {
          const pending = approvals.get(card.id);
          if (!pending) return;
          approvals.delete(card.id);
          approvalByRpc.delete(envelope.rpcId);
          void card.settle(`${cardText}\n\n\u{1F6E1} Approval ${display} \u00B7 ${requested.toolName}${requested.reason ? ` \u00B7 ${requested.reason}` : ""}`);
          void respondApproval(envelope.rpcId, requested, outcome).catch((err) => log(`api-proxy respond failed for approval ${requested.approvalId}`, err));
        };
        const pending: PendingApproval = {
          id: card.id,
          approvalId: requested.approvalId,
          sessionId: requested.sessionId,
          toolName: requested.toolName,
          ...(requested.reason === undefined ? {} : { reason: requested.reason }),
          ...(goalId === undefined ? {} : { goalId }),
          rpcId: envelope.rpcId,
          resolve: settle,
          closeLocal: () => {
            approvals.delete(card.id);
            approvalByRpc.delete(envelope.rpcId);
            void card.settle(`\u2716 Telegram interactive detached \u2014 buttons closed.`);
          },
          card,
          cardText,
        };
        approvals.set(card.id, pending);
        approvalByRpc.set(envelope.rpcId, card.id);
        card.deliver(cardText, approvalKeyboard(card.id, goalId, requested.toolName), () => {
          if (approvals.delete(card.id)) {
            approvalByRpc.delete(envelope.rpcId);
            card.dispose();
            log(`telegram delivery failed for approval ${requested.approvalId}; web UI still owns the ask`);
          }
        });
        return;
      }

      if (frame.type === "approval/resolved" && "outcome" in frame) {
        const resolved = frame as Extract<MuxFrameLike, { type: "approval/resolved" }>;
        for (const pending of approvals.values()) {
          if (pending.approvalId !== resolved.approvalId) continue;
          approvals.delete(pending.id);
          if (pending.rpcId !== undefined) approvalByRpc.delete(pending.rpcId);
          const text = `${pending.cardText}\n\n\u{1F6E1} Approval ${resolved.outcome} \u00B7 ${pending.toolName}${pending.reason ? ` \u00B7 ${pending.reason}` : ""}`;
          void pending.card.settle(text);
          return;
        }
        return;
      }

      if (frame.type === "question/requested" && "questions" in frame) {
        const requested = frame as Extract<MuxFrameLike, { type: "question/requested" }>;
        if (questionByRpc.has(envelope.rpcId)) return;
        const card = openCardSession(delivery, requested.sessionId, undefined, () => {});
        const pending: PendingQuestion = {
          id: card.id,
          sessionId: requested.sessionId,
          questions: requested.questions,
          resolve: (answer) => {
            questions.delete(card.id);
            questionByRpc.delete(envelope.rpcId);
            void card.settle(`\u2705 Questions answered (id ${card.id}).`);
            void apiProxy!.respond({
              type: "client-response",
              rpcId: envelope.rpcId,
              result: {
                ok: true,
                value: { sessionId: requested.sessionId, answer },
              },
            }).catch((err) => log(`api-proxy respond failed for question ${card.id}`, err));
          },
          reject: (err) => {
            questions.delete(card.id);
            questionByRpc.delete(envelope.rpcId);
            void card.settle(`\u2716 Questions cancelled (id ${card.id}).`);
            void apiProxy!.respond({
              type: "client-response",
              rpcId: envelope.rpcId,
              result: {
                ok: false,
                error: { code: "cancelled", message: err.message, details: {} },
              },
            }).catch((err2) => log(`api-proxy respond failed for cancelled question ${card.id}`, err2));
          },
          closeLocal: (err) => {
            questions.delete(card.id);
            questionByRpc.delete(envelope.rpcId);
            void card.settle(`\u2716 Telegram interactive detached \u2014 buttons closed.`);
            // Do NOT call apiProxy.respond: the web UI keeps ownership of the
            // outstanding ask after this plugin detaches.
            void err;
          },
          card,
          selections: new Map(),
          custom: new Map(),
          rpcId: envelope.rpcId,
        };
        pending.questions.forEach((question) => pending.selections.set(question.id, []));
        questions.set(card.id, pending);
        questionByRpc.set(envelope.rpcId, card.id);
        card.deliver(renderQuestions(pending, 0), questionKeyboard(card.id, 0), () => {
          if (questions.delete(card.id)) {
            questionByRpc.delete(envelope.rpcId);
            card.dispose();
            log(`telegram delivery failed for question ${card.id}; web UI still owns the ask`);
          }
        });
        return;
      }

      if (frame.type === "question/resolved" && "questionRpcId" in frame) {
        const resolved = frame as Extract<MuxFrameLike, { type: "question/resolved" }>;
        const cardId = questionByRpc.get(resolved.questionRpcId);
        if (cardId === undefined) return;
        const pending = questions.get(cardId);
        if (!pending) return;
        questions.delete(cardId);
        questionByRpc.delete(resolved.questionRpcId);
        const text = resolved.outcome === "answered"
          ? `\u2705 Questions answered on the web (id ${cardId}).`
          : `\u2716 Questions cancelled (id ${cardId}).`;
        void pending.card.settle(text);
        return;
      }
    };

    void (async () => {
      try {
        for await (const envelope of apiProxy!.events.mux({}, controller.signal)) handleFrame(envelope);
      } catch (err) {
        if (!controller.signal.aborted) log("interactive dual-mode mux stream failed; web side is unreachable", err);
      }
    })();
  }

  if (!dual && ctx.get("approval") === undefined) {
    // Same apply-time visibility rule as the question seam: report it instead
    // of silently leaving every approval card to the web UI.
    log("interactive.approval: no approval service is visible to this plugin on this host; approval cards stay with the web UI");
  }

  if (!dual && ctx.get("approval") !== undefined) {
    const events = ctx as unknown as CordisEventsLike;
    disposers.push(
      events.on("approval/request", (request, next) => {
        const req = request as ApprovalRequestLike;
        if (req.signal?.aborted === true) return Promise.resolve("cancelled");
        const goalId = goalIdForSession?.(String(req.agent.id));
        // A previous "Allow for this goal" covers the rest of the goal:
        // settle without showing another card.
        if (goalId !== undefined && grantedGoals.has(goalId)) return Promise.resolve("allowed-once");
        // Session and forever (by-tool) grants cover the same tool without
        // another card. Session grants die with the plugin mount, matching
        // the web's per-session permission model.
        const toolName = req.toolName.trim();
        if (grantedTools.has(toolName) || grantedSessions.get(String(req.agent.id))?.has(toolName)) {
          return Promise.resolve("allowed-once");
        }
        const claimed = new Set([...approvals.values()].map((entry) => entry.approvalId));
        const decided = new Set<string>();
        let approvalId: string | undefined;
        const approvalEvents = sessionEvents(req.agent.session);
        for (let i = approvalEvents.length - 1; i >= 0; i -= 1) {
          const event = approvalEvents[i]!;
          if (event.type === "approval/decided") decided.add(String((event.data as { id?: unknown })?.id));
          else if (event.type === "approval/asked") {
            const data = event.data as { id?: unknown; callId?: unknown };
            if (decided.has(String(data.id)) || claimed.has(String(data.id))) continue;
            if ((req.callId ?? null) !== (data.callId ?? null)) continue;
            approvalId = String(data.id);
            break;
          }
        }
        if (approvalId === undefined) return (next as () => Promise<unknown>)();
        const cardText = `\u{1F6E1} Approval requested \u00B7 ${req.toolName}${req.reason ? `\nReason: ${req.reason}` : ""}\nSession: ${req.agent.id}`;
        return new Promise<ApprovalOutcome>((resolve) => {
          const settle = (outcome: ApprovalOutcome, display: string = outcome) => {
            if (!approvals.delete(card.id)) return;
            // Edit the requested card in place and drop its inline buttons.
            // No remove_keyboard reply: that would wipe the persistent command
            // bar for the whole chat.
            void card.settle(`${cardText}\n\n\u{1F6E1} Approval ${display} \u00B7 ${req.toolName}${req.reason ? ` \u00B7 ${req.reason}` : ""}`);
            resolve(outcome);
          };
          const card = openCardSession(delivery, req.agent.id, req.signal, () => settle("cancelled"));
          const pending: PendingApproval = { id: card.id, approvalId, sessionId: req.agent.id, toolName: req.toolName, ...(req.reason === undefined ? {} : { reason: req.reason }), ...(goalId === undefined ? {} : { goalId }), resolve: settle, card, cardText };
          approvals.set(card.id, pending);
          card.deliver(cardText, approvalKeyboard(card.id, goalId, req.toolName), () => {
            // Zero deliveries and broadcast rejections both land here: cancel
            // instead of blocking the agent forever on an unanswered card
            // (LOOP_AUDIT #4 / red-2).
            settle("cancelled");
          });
        });
      }),
    );
  }

  const questionsService = ctx.get("userQuestions") as QuestionsServiceLike | undefined;
  let disposeProvider: (() => void) | undefined;
  const webMounted = webUiOwnsQuestions(ctx);
  const serviceOwned = questionsService?.provider !== undefined;
  // A host may expose no usable provider seam at all: `ctx.get` is read once,
  // at apply time, so a service mounted later is simply absent here, and an
  // older release may ship a service without `registerProvider`. The
  // `tools/execute` interception below needs no service, so it is the correct
  // path in both cases instead of leaving the bridge unable to answer.
  const providerSeamUsable = questionsService !== undefined && typeof questionsService.registerProvider === "function";

  /** Install the service-independent interception: Telegram answers
   * `ask_user_question` before the tool body and any other asker ever run. */
  const installToolsExecuteSeam = (reason: string): void => {
    const events = ctx as unknown as CordisEventsLike;
    if (typeof events.on !== "function") return;
    disposers.push(
      events.on("tools/execute", (exec, next) => {
        const request = toQuestionRequest(exec as ToolExecutionLike);
        if (request === undefined) return (next as () => Promise<unknown>)();
        assertValidRequest(ctx, request);
        return askViaTelegram(delivery, request).then((answer) => ({ value: answer }));
      }),
    );
    log(`interactive.userQuestions=telegram: ${reason}; Telegram answers ask_user_question at the tools/execute seam`);
  };

  if (effectiveOwnership === "telegram") {
    // The one-provider invariant stays untouched: Telegram never registers a
    // second provider. When the provider seam is free and usable, the ordinary
    // provider path keeps the service's own validation in front of every ask;
    // otherwise Telegram claims ask_user_question at the public
    // `tools/execute` seam, whether another UI owns the service, the web API
    // proxy is mounted, or this host has no usable service at all.
    if (questionsService !== undefined && providerSeamUsable && !serviceOwned && !webMounted) {
      try {
        disposeProvider = questionsService.registerProvider({ ask: (request) => askViaTelegram(delivery, request) });
      } catch (err) {
        log("telegram userQuestions provider registration failed; connecting the tools/execute seam instead", err);
        installToolsExecuteSeam("the userQuestions provider seam rejected Telegram");
      }
    } else if (!providerSeamUsable) {
      installToolsExecuteSeam(
        questionsService === undefined
          ? "no userQuestions service is available to this plugin on this host"
          : "this host's userQuestions service exposes no registerProvider",
      );
    } else if (serviceOwned) {
      installToolsExecuteSeam("another UI owns ctx.userQuestions");
    } else {
      installToolsExecuteSeam("the web API proxy is mounted and keeps the single provider seam");
    }
  } else if (effectiveOwnership === "auto") {
    // Legacy inference: only register when no other provider and no enabled
    // web API proxy loader entry. The service itself enforces the
    // single-provider invariant on the attempted registration.
    if (questionsService !== undefined && providerSeamUsable && questionsService.provider === undefined && !webMounted) {
      try {
        disposeProvider = questionsService.registerProvider({ ask: (request) => askViaTelegram(delivery, request) });
      } catch (err) {
        log("telegram userQuestions provider registration failed; another provider owns the seam", err);
      }
    } else if (questionsService !== undefined && (serviceOwned || webMounted)) {
      log(`interactive.userQuestions=auto: ${serviceOwned ? "another provider" : "web API proxy"} owns ask_user_question; Telegram will not answer questions`);
    }
  }

  return {
    answerApproval(chatId, id, answer) {
      const pending = approvals.get(id);
      if (!pending) return false;
      // IA-1 #3: a callback from a chat that never received this card must
      // not settle someone else's pending approval (SC-2 token ownership).
      if (!ownsCard(pending.card, chatId)) return false;
      const toolName = pending.toolName.trim();
      if (answer === "allowed-goal") {
        if (pending.goalId === undefined) return false;
        grantedGoals.add(pending.goalId);
        pending.resolve("allowed-once", "allowed-goal (this goal)");
        return true;
      }
      if (answer === "allowed-session") {
        const allowed = grantedSessions.get(pending.sessionId) ?? new Set<string>();
        allowed.add(toolName);
        grantedSessions.set(pending.sessionId, allowed);
        pending.resolve("allowed-once", "allowed-session (this session)");
        return true;
      }
      if (answer === "allowed-always") {
        grantedTools.add(toolName);
        let persisted = true;
        try {
          persisted = options.persistToolAllow?.(toolName) ?? true;
        } catch (err) {
          log("persisting an approval forever-allow failed; grant stays in memory for this plugin mount", err);
          persisted = false;
        }
        if (!persisted) log(`persisting approval forever-allow for ${toolName} failed; grant stays in memory for this plugin mount`);
        pending.resolve("allowed-once", "allowed-always (by tool)");
        return true;
      }
      pending.resolve(answer);
      return true;
    },
    setAllowedTools(tools) {
      grantedTools.clear();
      for (const toolName of tools) {
        if (toolName.trim() !== "") grantedTools.add(toolName.trim());
      }
    },
    async toggleQuestionOption(chatId, id, questionId, optionToken) {
      const pending = questions.get(id);
      if (!pending) return false;
      // IA-1 #3: refuse to even mutate selections from a chat the card never
      // reached — a foreign chat must not shape another chat's answer.
      if (!ownsCard(pending.card, chatId)) return false;
      const question = pending.questions.find((candidate) => candidate.id === questionId);
      if (!question) return false;
      const option = findOption(question, optionToken);
      if (!option) return false;
      const value = optionValue(option);
      const selected = pending.selections.get(questionId) ?? [];
      if (selected.includes(value)) {
        pending.selections.set(questionId, selected.filter((entry) => entry !== value));
      } else if (question.multiSelect) {
        pending.selections.set(questionId, [...selected, value]);
      } else {
        pending.selections.set(questionId, [value]);
      }
      await reRenderQuestion(ctx, pending, chatId, delivery);
      return true;
    },
    async setQuestionCustom(chatId, id, questionId, text) {
      const pending = questions.get(id);
      if (!pending) return false;
      // IA-1 #3: same ownership rule as option toggles (see above).
      if (!ownsCard(pending.card, chatId)) return false;
      pending.custom.set(questionId, text);
      await reRenderQuestion(ctx, pending, chatId, delivery);
      return true;
    },
    async answerQuestionText(chatId, id, questionIndex, text) {
      const pending = questions.get(id);
      if (!pending) return "stale";
      // IA-1 #3: same ownership rule as option toggles (see above).
      if (!ownsCard(pending.card, chatId)) return "stale";
      const question = pending.questions[questionIndex];
      if (!question) return "stale";
      pending.custom.set(question.id, text);
      if (question.options?.length) {
        // An option-bearing question still needs the operator's Submit: only
        // that tap says the staged text is meant as this question's answer.
        await reRenderQuestion(ctx, pending, chatId, delivery);
        return "staged";
      }
      // Text-only: staging is the whole answer. An unanswered sibling option
      // question keeps the card open, and the caller reports that instead of
      // claiming a settled ask.
      if (settleQuestionCard(pending, id)) return "submitted";
      await reRenderQuestion(ctx, pending, chatId, delivery);
      return "staged";
    },
    async submitQuestions(chatId, id) {
      const pending = questions.get(id);
      if (!pending) return false;
      // IA-1 #3: chat B must never settle chat A's pending question —
      // settlement is bound to the chats the card was delivered to.
      if (!ownsCard(pending.card, chatId)) return false;
      if (!settleQuestionCard(pending, id)) {
        void delivery.edit(chatId, pending.card.messageIds.get(chatId) ?? 0, `${renderQuestions(pending, chatId)}\n\n\u26A0\uFE0F Answer every question first.`, questionKeyboard(id, chatId)).catch(() => {});
      }
      return true;
    },
    async cancelQuestions(chatId, id) {
      const pending = questions.get(id);
      if (!pending) return false;
      // IA-1 #3: only a chat holding a delivered copy may cancel the ask.
      if (!ownsCard(pending.card, chatId)) return false;
      questions.delete(id);
      pending.reject(new Error("the user cancelled ask_user_question"));
      void pending.card.settle(`\u2716 Questions cancelled (id ${id}).`);
      void chatId;
      return true;
    },
    detach() {
      for (const dispose of disposers.splice(0)) dispose();
      disposeProvider?.();
      disposeProvider = undefined;
      if (dual) {
        // Approvals: close only the local Telegram cards. The web UI keeps
        // owning the outstanding approval after this plugin detaches, so we
        // must NOT call apiProxy.respond(cancelled) from here; closeLocal
        // skips the web response by design.
        for (const id of [...approvalByRpc.values()]) {
          const pending = approvals.get(id);
          if (!pending) continue;
          pending.closeLocal?.();
        }
        // Questions: close only the local Telegram cards. The web UI keeps
        // owning the outstanding ask after this plugin detaches, so we must
        // NOT call apiProxy.respond(cancelled) from here; closeLocal skips
        // the web response by design.
        for (const rpcId of [...questionByRpc.keys()]) {
          const pending = questions.get(questionByRpc.get(rpcId)!);
          if (!pending) continue;
          pending.closeLocal?.(new Error("telegram interactive provider was disposed"));
        }
      } else {
        for (const pending of approvals.values()) pending.resolve("cancelled");
        for (const pending of questions.values()) {
          // IA-1 #1/#2: detach must not leave live keyboards behind — settle
          // every delivered question card to a closed state (which also unwinds
          // its abort listener, the same treatment approvals get via
          // resolve("cancelled")). Best-effort: edits are catch-guarded.
          void pending.card.settle("\u2716 Telegram interactive detached \u2014 buttons closed.");
          pending.reject(new Error("telegram interactive provider was disposed"));
        }
      }
      approvals.clear();
      questions.clear();
      approvalByRpc.clear();
      questionByRpc.clear();
      grantedGoals.clear();
      grantedSessions.clear();
      grantedTools.clear();
    },
  };
}
