import { escapeHtml, truncate } from "../../telegram/html.js";
import { hasEventLog, sessionEvents } from "./session-read.js";
/** Normalize the durable whole-list payload into stable TodoView objects. */
export function normalizeTodos(todos) {
    return todos.map((todo) => ({
        content: typeof todo.content === "string" ? todo.content : String(todo.content ?? ""),
        status: todo.status === "completed" || todo.status === "in_progress" ? todo.status : "pending",
    }));
}
/**
 * Incremental cache for `listTodos` (issue #14): session event lists are
 * append-only and can reach thousands of entries, so the common case must not
 * re-scan the whole array for every bar sync / 5-second card refresh. The
 * first call scans once and records the scanned end index; later calls only
 * inspect newly appended events.
 *
 * Keyed by the EVENTS ARRAY object itself, not the agent: a compaction/reset
 * can swap in a fresh array with the SAME length, which a length-only check
 * would silently accept as "nothing appended" and serve stale todos. With
 * identity keying any replaced array misses the cache and forces one full
 * re-scan; scannedEnd still short-circuits pure appends on the same array.
 */
const todoListCache = new WeakMap();
/** Latest whole-list snapshot for one live agent (last write wins). */
export function listTodos(ctx, agentId) {
    const agent = ctx.agents?.get(agentId);
    const session = agent?.session;
    if (!hasEventLog(session))
        return [];
    const events = sessionEvents(session);
    const end = events.length - 1;
    const cached = todoListCache.get(events);
    if (cached !== undefined && cached.scannedEnd === end)
        return cached.todos;
    if (cached !== undefined && cached.scannedEnd < end) {
        // Only the newly appended tail can contain a newer todo/write event.
        for (let index = end; index > cached.scannedEnd; index -= 1) {
            const event = events[index];
            if (event?.type === "todo/write" && Array.isArray(event.data?.todos)) {
                const todos = normalizeTodos(event.data.todos);
                todoListCache.set(events, { scannedEnd: end, todos });
                return todos;
            }
        }
        return cached.todos;
    }
    // First scan on this array, or the events array was REPLACED at any length
    // (compaction/reset): walk the whole array once and cache the result,
    // including the empty result.
    for (let index = end; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type === "todo/write" && Array.isArray(event.data?.todos)) {
            const todos = normalizeTodos(event.data.todos);
            todoListCache.set(events, { scannedEnd: end, todos });
            return todos;
        }
    }
    todoListCache.set(events, { scannedEnd: end, todos: [] });
    return [];
}
/** Incomplete tasks only — the bar counter measures remaining work. */
export function pendingTodoCount(todos) {
    return todos.filter((todo) => todo.status !== "completed").length;
}
/** Compact diff for the notification card (stable order, statuses only). */
export function diffTodos(previous, next) {
    const previousByContent = new Map(previous.map((todo) => [todo.content, todo]));
    const added = next.filter((todo) => !previousByContent.has(todo.content));
    const started = next.filter((todo) => todo.status === "in_progress" && previousByContent.get(todo.content)?.status === "pending");
    const completed = next.filter((todo) => todo.status === "completed" && previousByContent.get(todo.content)?.status !== "completed");
    return {
        added,
        started,
        completed,
        remaining: pendingTodoCount(next),
    };
}
const PRIORITY_HIGH = /(?:^|[^A-Za-z0-9])(?:🔴|P0|high|urgent|\u7D27\u6025|\u9AD8)(?:[^A-Za-z0-9]|$)/i;
const PRIORITY_MEDIUM = /(?:^|[^A-Za-z0-9])(?:🟡|P1|medium|\u4E2D)(?:[^A-Za-z0-9]|$)/i;
/** Display priority tag; absent from the durable schema, so this only colors
 * the Telegram card and never mutates the todo list. */
export function todoPriority(content) {
    if (PRIORITY_HIGH.test(content))
        return "high";
    if (PRIORITY_MEDIUM.test(content))
        return "medium";
    return "low";
}
export function todoIcon(todo) {
    if (todo.status === "completed")
        return "\u2705";
    if (todo.status === "in_progress")
        return "\u23F3";
    return todoPriority(todo.content) === "high" ? "\u{1F534}" : todoPriority(todo.content) === "medium" ? "\u{1F7E1}" : "\u{1F7E2}";
}
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
export const TODOS_RENDER_MAX_CHARS = 3600;
/** "… +N more" tail for the clamped list; literal text, nothing to escape. */
function moreTail(hidden) {
    return `\u2026 +${hidden} more`;
}
function todoLine(todo) {
    const content = escapeHtml(todo.content);
    return todo.status === "completed" ? `${todoIcon(todo)} <s>${content}</s>` : `${todoIcon(todo)} ${content}`;
}
export function renderTodos(todos, maxChars = TODOS_RENDER_MAX_CHARS) {
    if (todos.length === 0)
        return "(no todos yet)";
    const lines = todos.map(todoLine);
    // Clamp at WHOLE-item granularity: rendered lines contain markup (<s>,
    // entities), so the list may only be cut BETWEEN items — a mid-line cut
    // could split a tag or entity and make Telegram reject the card outright.
    let keep = 0;
    let used = 0;
    for (let index = 0; index < lines.length; index += 1) {
        const cost = (keep === 0 ? 0 : 1) + lines[index].length;
        // Reserve room for the "+N more" tail whenever keeping this item still
        // leaves later ones hidden — otherwise the tail itself could overflow.
        const hiddenIfKept = lines.length - index - 1;
        const reserve = hiddenIfKept > 0 ? moreTail(hiddenIfKept).length + 1 : 0;
        if (used + cost + reserve > maxChars)
            break;
        used += cost;
        keep += 1;
    }
    if (keep === 0) {
        // A single item bigger than the whole budget: clip its PLAIN content
        // before escaping (never cut rendered HTML mid-tag/mid-entity) so at
        // least one entry renders. Worst-case entity growth is &#x27; (6 chars
        // per input char), hence the /6 divisor; +16 covers icon, <s></s> and
        // the joining newline.
        const hidden = todos.length - 1;
        const clipAt = Math.max(64, Math.floor((maxChars - moreTail(hidden).length - 16) / 6));
        const line = todoLine({ ...todos[0], content: truncate(todos[0].content, clipAt) });
        return hidden > 0 ? `${line}\n${moreTail(hidden)}` : line;
    }
    const body = lines.slice(0, keep).join("\n");
    const hidden = todos.length - keep;
    return hidden > 0 ? `${body}\n${moreTail(hidden)}` : body;
}
//# sourceMappingURL=todos.js.map