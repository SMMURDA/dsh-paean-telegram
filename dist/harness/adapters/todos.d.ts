/**
 * Todo domain over the durable `todo/write` session event. The schema is
 * minimal (content + status), so priority is derived from common text tags
 * (`[P0]`/`high`/🔴…) for display only — never invented into the model list.
 */
import type { Context } from "@deepseek-ai/cordis";
export interface TodoView {
    content: string;
    status: "pending" | "in_progress" | "completed";
}
export interface TodoDiff {
    added: TodoView[];
    started: TodoView[];
    completed: TodoView[];
    remaining: number;
}
/** Normalize the durable whole-list payload into stable TodoView objects. */
export declare function normalizeTodos(todos: readonly TodoView[]): TodoView[];
/** Latest whole-list snapshot for one live agent (last write wins). */
export declare function listTodos(ctx: Context, agentId: string): TodoView[];
/** Incomplete tasks only — the bar counter measures remaining work. */
export declare function pendingTodoCount(todos: readonly TodoView[]): number;
/** Compact diff for the notification card (stable order, statuses only). */
export declare function diffTodos(previous: readonly TodoView[], next: readonly TodoView[]): TodoDiff;
/** Display priority tag; absent from the durable schema, so this only colors
 * the Telegram card and never mutates the todo list. */
export declare function todoPriority(content: string): "high" | "medium" | "low";
export declare function todoIcon(todo: TodoView): string;
/** One-line card renderer shared by the todo card. Typography (design
 * language, telegram/ui.ts): icon + content only — completed items are struck
 * through and priority lives in the dot color, so no `[status]` tag noise.
 * Output is Telegram HTML; every card lane sends it with parse_mode HTML. */
/** Render-time ceiling for the item list (#TL-1). Session todo lists are
 * unbounded (append-only whole-list writes), and renderTodosCard wraps this
 * output in ≤~150 chars of header/progress/footer chrome, so a 3600 budget
 * keeps the FULL card under ~3800 — safely below Telegram's 4096 send/edit
 * ceiling. Without it, an overlong card made the transport's edit lane fail
 * fast and Ephemeral re-send the whole payload on every 5s refresh tick: an
 * unbounded flood that could never converge into one editable bubble. */
export declare const TODOS_RENDER_MAX_CHARS = 3600;
export declare function renderTodos(todos: readonly TodoView[], maxChars?: number): string;
