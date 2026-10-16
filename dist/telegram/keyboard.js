/**
 * Pure keyboard builders.
 *
 * - The persistent reply-keyboard bar carries the 9 hot functions
 *   (3 rows x 3). `BAR_LABELS` keeps superseded labels so stale
 *   persisted bars on clients still dispatch correctly.
 * - The `☰ Menu` inline card carries the paginated CORE rows.
 * - The "all functions" inline card is available through `⚙️ All` callbacks.
 *
 * Builders are pure: no dsh imports, no I/O, trivially unit-testable.
 */
import { InlineKeyboard, Keyboard } from "grammy";
export const MENU_BTN = "\u2630 Menu";
export const NEW_BTN = "\u2728 New";
export const COMPACT_BTN = "\u{1F9F9} Compact";
export const MODELS_BTN = "\u{1F9E9} Models";
export const PLUGINS_BTN = "\u{1F50C} Plugins";
export const MODE_BTN = "\u{1F3AD} Mode";
export const SESSIONS_BTN = "\u{1F9ED} Sessions";
export const STATUS_BTN = "\u{1F4CA} Status";
export const QUEUE_BTN = "\u231B Queue";
export const QUEUE_BTN_PREFIX = `${QUEUE_BTN} \u00B7 `;
export const GOAL_BTN = "\u{1F3AF} Goal";
export const TODO_BTN = "\u{1F4CB} Todos";
export const TODO_BTN_PREFIX = `${TODO_BTN} \u00B7 `;
/** Kept so clients with stale bars still dispatch; no longer rendered on the bar. */
export const PRESETS_BTN = "\u{1F3AD} Presets";
export const THINKING_BTN = "\u{1F9E0} Thinking";
/** Bar label for the reasoning picker (unified name; THINKING_BTN kept for
 * stale client bars). */
export const REASONING_BTN = "\u{1F9E0} Reasoning";
/** Abort the current turn only; `/stop` is the command that closes the session. */
export const ABORT_BTN = "\u23F9 Abort";
/** Legacy bar label from older clients; still dispatches to abort. */
export const STOP_BTN = "\u23F9 Stop";
/** Collapses the whole bar to a single return button (more chat history visible). */
export const COLLAPSE_BTN = "\u{1F5DC}\uFE0F \u6536\u8D77";
/** The one button left on a collapsed bar; tapping it restores the full bar. */
export const RETURN_BTN = "\u8FD4\u56DE";
/** Stale client bars from earlier builds keep these labels working. */
export const LEGACY_COLLAPSE_BTN = "\u{1F648} \u6536\u8D77";
export const LEGACY_RETURN_BTN = "\u{1F519} \u8FD4\u56DE";
export const BAR_LABELS = [
    MENU_BTN,
    NEW_BTN,
    COMPACT_BTN,
    MODELS_BTN,
    PLUGINS_BTN,
    MODE_BTN,
    SESSIONS_BTN,
    STATUS_BTN,
    QUEUE_BTN,
    GOAL_BTN,
    TODO_BTN,
    REASONING_BTN,
    THINKING_BTN,
    PRESETS_BTN,
    ABORT_BTN,
    STOP_BTN,
    COLLAPSE_BTN,
    RETURN_BTN,
    LEGACY_COLLAPSE_BTN,
    LEGACY_RETURN_BTN,
];
/** Queue button label with a live count embedded (`⌛ Queue · 3`). */
export function queueBarLabel(queueCount) {
    return `${QUEUE_BTN_PREFIX}${queueCount}`;
}
/** Todo button label with the remaining count embedded (`📋 Todos · 3`). */
export function todoBarLabel(todoCount) {
    return `${TODO_BTN_PREFIX}${todoCount}`;
}
const callbackBytes = (value) => new TextEncoder().encode(value).length;
/** Build `<prefix><url-encoded value><suffix>` bounded to Telegram's 64-BYTE
 * callback_data limit by trimming the raw value before encoding, so the
 * result is always valid percent-encoding (never truncated mid-sequence).
 * `suffix` (e.g. `:use`) is appended verbatim after its bytes are reserved
 * from the budget, so action-bearing payloads stay byte-safe too. */
export function encodedCallback(prefix, value, suffix = "") {
    const fixed = callbackBytes(prefix) + callbackBytes(suffix);
    let trimmed = value;
    while (trimmed.length > 0 && fixed + callbackBytes(encodeURIComponent(trimmed)) > 64) {
        const last = trimmed.length - 1;
        const secondLast = trimmed.length - 2;
        // Remove exactly one full code point from the end. An astral character is
        // two UTF-16 code units; slicing by one would split the pair and then
        // encodeURIComponent would throw URIError (KB-1).
        if (secondLast >= 0 &&
            trimmed.charCodeAt(secondLast) >= 0xd800 && trimmed.charCodeAt(secondLast) <= 0xdbff &&
            trimmed.charCodeAt(last) >= 0xdc00 && trimmed.charCodeAt(last) <= 0xdfff) {
            trimmed = trimmed.slice(0, -2);
        }
        else {
            trimmed = trimmed.slice(0, -1);
        }
    }
    return prefix + encodeURIComponent(trimmed) + suffix;
}
/** Byte-safe callback_data for ids read back VERBATIM by colon-splitting
 * parsers (`s:`, `w:`): a value that already fits Telegram's 64-byte cap
 * passes through unchanged — colons included, so `data.split(":")` keeps
 * resolving ids exactly as before — and only an oversized value falls back
 * to the percent-encoded trimmed form (audit RE-9: a UTF-16 code-unit slice
 * could still exceed the byte budget and 400 the whole card). */
export function boundedCallback(prefix, value, suffix = "") {
    const fixed = callbackBytes(prefix) + callbackBytes(suffix);
    if (fixed + callbackBytes(value) <= 64)
        return `${prefix}${value}${suffix}`;
    return encodedCallback(prefix, value, suffix);
}
/** Decode a callback payload that should be percent-encoded. Legacy cards or
 * providers whose ids contain a literal `%` are decoded best-effort; a
 * malformed sequence must return the raw value instead of killing the tap. */
export function decodeCallbackValue(value) {
    try {
        return decodeURIComponent(value);
    }
    catch {
        return value;
    }
}
/** Always-visible bar grouped by frequency:
 * `Menu · New · Models` / `Sessions · Plugins · Status` /
 * `Goal · Queue · Compact` / `Todos · Abort`. `🧠 Reasoning` stays
 * reachable from the menu P1. Pass `queueCount`/`todoCount` for live counts.
 *
 * No in-bar 收起 button anymore: show/hide is the client's OWN input-row
 * toggle (the ⊞ grid button) — one native tap, no bot round-trip. That ⊞
 * icon is only rendered in the API's DEFAULT keyboard mode: `is_persistent`
 * must stay FALSE (Bot API: "the custom keyboard can be hidden and opened
 * with a keyboard icon"). Persistent mode (`true`) asks clients to pin the
 * keyboard permanently and they drop the ⊞ icon — once hidden, there is no
 * way back. `one_time_keyboard` stays false, so bar taps do NOT auto-close
 * it; `/bar off` keeps the explicit collapse for anyone who wants it; a
 * stale 收起 tap on an old rendered keyboard restores the fresh full bar. */
export function buildBarKeyboard(queueCount, todoCount) {
    return new Keyboard()
        .text(MENU_BTN)
        .text(NEW_BTN)
        .text(MODELS_BTN)
        .row()
        .text(SESSIONS_BTN)
        .text(PLUGINS_BTN)
        .text(STATUS_BTN)
        .row()
        .text(GOAL_BTN)
        .text(queueCount === undefined ? QUEUE_BTN : queueBarLabel(queueCount))
        .text(COMPACT_BTN)
        .row()
        .text(todoCount === undefined ? TODO_BTN : todoBarLabel(todoCount))
        .text(ABORT_BTN)
        .resized();
}
/** Collapsed bar: only the return button, so the chat itself gets the screen. */
export function buildCollapsedBarKeyboard() {
    return new Keyboard().text(RETURN_BTN).resized();
}
/** Map inbound bar-button text back to its canonical label. The Queue
 * button's text changes as the live count is embedded (`⌛ Queue · 7`), so
 * exact BAR_LABELS matching alone would drop those taps. */
export function normalizeBarLabel(text) {
    if (text === LEGACY_COLLAPSE_BTN)
        return COLLAPSE_BTN;
    if (text === LEGACY_RETURN_BTN)
        return RETURN_BTN;
    if (text === STOP_BTN)
        return ABORT_BTN;
    if (BAR_LABELS.includes(text))
        return text;
    if (text.startsWith(QUEUE_BTN_PREFIX))
        return QUEUE_BTN;
    if (text.startsWith(TODO_BTN_PREFIX))
        return TODO_BTN;
    return undefined;
}
/** Dense paginated menu (codex-bridge style): primary items full-width,
 * the rest paired two-per-row, then prev/page/next + close. */
export function buildMenuPage(items, page, total) {
    const rows = [];
    const pair = [];
    const flush = () => {
        if (pair.length > 0) {
            rows.push([...pair]);
            pair.length = 0;
        }
    };
    for (const item of items.slice(0, 30)) {
        const button = { text: item.label.slice(0, 32), callback_data: item.cb };
        if (item.full) {
            flush();
            rows.push([button]);
        }
        else {
            pair.push(button);
            if (pair.length === 2)
                flush();
        }
    }
    flush();
    const nav = [];
    if (page > 0)
        nav.push({ text: "\u2B05\uFE0F Prev", cb: "m:prev" });
    // The header already carries `page X/Y`; a tappable page-number button is a
    // dead-looking control, so it is deliberately omitted.
    if (page < total - 1)
        nav.push({ text: "More \u27A1\uFE0F", cb: "m:more" });
    if (nav.length > 0) {
        rows.push(nav.map((button) => ({ text: button.text, callback_data: button.cb })));
    }
    rows.push([{ text: "\u2716 Close", callback_data: "m:close" }]);
    return InlineKeyboard.from(rows);
}
/** Single "back to menu" row for domain cards that only need one action. */
export function buildBackKeyboard() {
    return new InlineKeyboard().text("\u2190 Back", "m:back");
}
/** Two-button confirmation row for destructive actions. */
export function buildConfirmKeyboard(callbacks) {
    return new InlineKeyboard()
        .text("\u2705 Confirm", callbacks.confirm)
        .text("\u2716 Cancel", callbacks.cancel);
}
/** Folder picker: nav row (Up/Home/Root) + quick workspace paths, then
 * directory entries two per row, then Use/Close. Pure builder — callback
 * payloads are pre-encoded by index.ts. */
export function buildProjectKeyboard(dirs, actions) {
    const rows = [];
    const nav = [];
    if (actions.up !== undefined)
        nav.push({ text: "\u2B06\uFE0F Up", cb: actions.up });
    if (actions.home !== undefined)
        nav.push({ text: "\u{1F3E0} ~", cb: actions.home });
    if (actions.root !== undefined)
        nav.push({ text: "\u{1F5A5}\uFE0F /", cb: actions.root });
    if (nav.length > 0) {
        rows.push(nav.slice(0, 3).map((button) => ({ text: button.text, callback_data: button.cb })));
    }
    const breadcrumb = (actions.breadcrumb ?? []).slice(0, 3);
    if (breadcrumb.length > 0) {
        rows.push(breadcrumb.map((segment) => ({ text: `\u{1F4C2} ${segment.label.slice(0, 16)}`, callback_data: segment.cb })));
    }
    for (const quick of (actions.quick ?? []).slice(0, 3))
        rows.push([{ text: quick.label.slice(0, 40), callback_data: quick.cb }]);
    const seen = new Set();
    const pairs = [];
    for (const entry of dirs) {
        if (seen.has(entry.cb))
            continue;
        seen.add(entry.cb);
        pairs.push({ text: `\u{1F4C1} ${entry.label.slice(0, 26)}`, callback_data: entry.cb });
    }
    for (let index = 0; index < pairs.length; index += 2) {
        rows.push(index + 1 < pairs.length ? [pairs[index], pairs[index + 1]] : [pairs[index]]);
    }
    const paging = [];
    for (const button of (actions.paging ?? []).slice(0, 3)) {
        paging.push({ text: button.text.slice(0, 40), callback_data: button.cb });
    }
    if (paging.length > 0)
        rows.push(paging);
    if (actions.newFolder !== undefined)
        rows.push([{ text: "\u{1F4C1} New folder", callback_data: actions.newFolder }]);
    if (actions.menu !== undefined)
        rows.push([{ text: "\u2630 Menu", callback_data: actions.menu }]);
    const footer = [];
    if (actions.use !== undefined)
        footer.push({ text: "\u2705 Use this folder", callback_data: actions.use });
    if (actions.close !== undefined)
        footer.push({ text: "\u2716 Close", callback_data: actions.close });
    if (footer.length > 0)
        rows.push(footer);
    return InlineKeyboard.from(rows);
}
export const CALLBACK_RE = /^m:([a-z]+)(?::([\s\S]+))?$/;
/** Generic pagination row for text-heavy cards plus a back button. */
export function buildPagingKeyboard(callbacks) {
    const rows = [];
    if (callbacks.previous !== undefined || callbacks.next !== undefined) {
        const nav = [];
        if (callbacks.previous !== undefined)
            nav.push({ text: "\u2039 Prev", callback_data: callbacks.previous });
        if (callbacks.next !== undefined)
            nav.push({ text: "More \u203A", callback_data: callbacks.next });
        rows.push(nav);
    }
    rows.push([{ text: "\u2190 Back", callback_data: callbacks.back }]);
    return InlineKeyboard.from(rows);
}
export function buildSearchKeyboard(ids, paging) {
    const rows = [];
    for (const id of ids.slice(0, 8)) {
        rows.push([{ text: `\u{1F9ED} ${id.slice(0, 30)}`, callback_data: boundedCallback("s:", id) }]);
    }
    if (paging !== undefined && (paging.previous !== undefined || paging.next !== undefined)) {
        const nav = [];
        if (paging.previous !== undefined)
            nav.push({ text: "\u2039 Prev", callback_data: paging.previous });
        if (paging.next !== undefined)
            nav.push({ text: "More \u203A", callback_data: paging.next });
        rows.push(nav);
    }
    rows.push([{ text: "\u{1F50D} New search", callback_data: "m:search" }, { text: "\u2190 Sessions", callback_data: "m:sessions" }]);
    return InlineKeyboard.from(rows);
}
export function buildSessionsKeyboard(items, options = {}) {
    const rows = [];
    const top = [];
    if (options.projectsCb !== undefined) {
        top.push({ text: `\u{1F504} \u9879\u76EE (${options.projectCount ?? 0})`, callback_data: options.projectsCb });
    }
    top.push({ text: "\u2728 New session", callback_data: "m:new" }, { text: "\u23F9 Stop", callback_data: "m:stop" });
    rows.push(top.slice(0, 3));
    for (const item of items.slice(0, 10)) {
        const label = item.title && item.title.trim() !== "" ? item.title : item.id;
        const suffix = item.title && item.title.trim() !== "" ? ` \u00B7 ${item.id.slice(0, 10)}` : "";
        const marker = item.running === true ? "\u25B6 " : "";
        const row = [
            { text: `\u{1F9ED} ${marker}${label.slice(0, 22)}${suffix}`.slice(0, 48), callback_data: boundedCallback("s:", item.id) },
        ];
        if (item.archiveCb !== undefined)
            row.push({ text: "\u5F52\u6863", callback_data: item.archiveCb });
        if (item.deleteCb !== undefined)
            row.push({ text: "\u5220\u9664", callback_data: item.deleteCb });
        rows.push(row);
    }
    const paging = options.paging;
    if (paging !== undefined && (paging.previous !== undefined || paging.next !== undefined)) {
        const nav = [];
        if (paging.previous !== undefined)
            nav.push({ text: "\u2039 Prev", callback_data: paging.previous });
        if (paging.next !== undefined)
            nav.push({ text: "More \u203A", callback_data: paging.next });
        rows.push(nav);
    }
    rows.push([{ text: "\u2190 Back", callback_data: options.back ?? "m:back" }]);
    return InlineKeyboard.from(rows);
}
/** Project switcher for the grouped Sessions card: running projects first
 * (the caller orders them), then paging and back. */
export function buildSessionProjectsKeyboard(items, options) {
    const rows = [];
    if (options.all !== undefined) {
        rows.push([{ text: "\u{1F310} \u5168\u90E8\u4F1A\u8BDD", callback_data: options.all }]);
    }
    for (const item of items.slice(0, 12)) {
        const status = item.running > 0 ? ` \u00B7 \u25B6${item.running}` : "";
        rows.push([{ text: `\u{1F4C1} ${item.label.slice(0, 26)}${status} \u00B7 \u5171${item.total}`.slice(0, 64), callback_data: item.cb }]);
    }
    if (options.paging !== undefined && (options.paging.previous !== undefined || options.paging.next !== undefined)) {
        const nav = [];
        if (options.paging.previous !== undefined)
            nav.push({ text: "\u2039 Prev", callback_data: options.paging.previous });
        if (options.paging.next !== undefined)
            nav.push({ text: "More \u203A", callback_data: options.paging.next });
        rows.push(nav);
    }
    rows.push([{ text: "\u2190 Back", callback_data: options.back }]);
    return InlineKeyboard.from(rows);
}
export function buildHistoryKeyboard(sessionId, older) {
    const rows = [];
    if (older !== undefined)
        rows.push([{ text: "\u23EA Load older", callback_data: older }]);
    rows.push([{ text: "\u2190 Session", callback_data: boundedCallback("s:", sessionId) }]);
    return InlineKeyboard.from(rows);
}
export function buildSessionDetailKeyboard(id, archived, back = "m:sessions") {
    // Byte-safe action payloads (audit RE-9): the id is percent-encoded and
    // trimmed so every `s:<id>:<action>` button fits Telegram's 64-BYTE
    // callback_data cap — a UTF-16 code-unit slice could still exceed it.
    const cb = (action) => boundedCallback("s:", id, `:${action}`);
    const kb = new InlineKeyboard();
    kb.row().text("\u{1F3AF} Use", cb("use"));
    kb.row().text("\u{1F4DC} History", cb("history")).text("\u270F Rename", cb("rename"));
    kb.row().text("\u{1F500} Fork", cb("fork")).text(archived ? "\u{1F4E5} Archived" : "\u{1F5C4} Archive", cb("archive"));
    kb.row().text("\u{1F4CE} Model", cb("model")).text("\u231B Queue", cb("queue"));
    kb.row().text("\u{1F3AF} Steer", cb("steer")).text("\u{1F4E6} Log", cb("log"));
    kb.row().text("\u23F9 Stop", cb("stop")).text("\u{1F5D1} Delete", cb("delete"));
    return kb.row().text("\u2190 Sessions", back);
}
export function buildWorkspaceKeyboard(items) {
    const kb = new InlineKeyboard();
    for (const item of items.slice(0, 20)) {
        kb.text(`\u{1F5C2} ${item.title.slice(0, 30)}`, boundedCallback("w:", item.id)).row();
    }
    return kb.row().text("\u2795 Create", "w:create").text("\u2190 Back", "m:back");
}
export function buildWorkspaceDetailKeyboard(id, actions) {
    // Byte-safe action payloads (audit RE-9), same convention as the session
    // detail card.
    const cb = (action) => boundedCallback("w:", id, `:${action}`);
    const kb = new InlineKeyboard();
    if (actions?.use !== undefined)
        kb.row().text("\u2705 \u4F7F\u7528\u6B64\u9879\u76EE", actions.use);
    if (actions?.sessions !== undefined)
        kb.row().text("\u{1F9ED} \u4F1A\u8BDD", actions.sessions);
    kb.row().text("\u270F Rename", cb("rename")).text("\u{1F5D1} Delete", cb("delete"));
    kb.row().text("\u2B06 Move up", cb("up")).text("\u2193 Move down", cb("down"));
    kb.row().text("\u{1F4CC} Pin session first", cb("pin"));
    return kb.row().text("\u2190 Workspaces", "m:workspaces");
}
/** ForceReply keyboard for step-by-step text prompts: Telegram opens the
 * reply input automatically, which is much friendlier on a phone than asking
 * the user to find and quote a message manually. */
export function inputPromptKeyboard(placeholder) {
    return { force_reply: true, input_field_placeholder: placeholder.slice(0, 64) };
}
export function buildQueueKeyboard(items) {
    const rows = [];
    for (const item of items.slice(0, 24)) {
        const label = item.index === undefined ? item.itemId.slice(0, 8) : `#${item.index + 1}`;
        const kind = item.kind === "next-turn" ? "turn" : "step";
        // Byte-safe action payloads (audit RE-9): the q: parser is decode-aware
        // (composite `session:item` ids ride through percent-encoded), so these
        // go through the encoder unconditionally; ids without escapable
        // characters come out byte-identical to raw.
        // Editing text on a phone is the worst part of the queue UX. Instead of
        // asking for a reply-edited replacement, this card only offers delete
        // (then resend your message) and, for next-turn items, run-now.
        const row = [
            { text: `\u{1F5D1} Delete ${label} \u00B7 ${kind}`, callback_data: encodedCallback("q:", item.itemId, ":r") },
        ];
        if (item.kind === "next-turn")
            row.push({ text: `\u26A1 Run ${label} now`, callback_data: encodedCallback("q:", item.itemId, ":s") });
        rows.push(row);
    }
    rows.push([{ text: "\u2190 Back", callback_data: "m:back" }]);
    return InlineKeyboard.from(rows);
}
export function buildModelsKeyboard(groups, providersCb, currentProviderId) {
    const kb = new InlineKeyboard();
    for (const group of groups.slice(0, 20)) {
        // The current provider carries a check mark so the overview card shows
        // the selection at a glance, not only in the top-line string (#47).
        const marker = group.id === currentProviderId ? "\u2705 " : "";
        kb.text(`${marker}\u{1F4E1} ${group.name.slice(0, 30)}`, encodedCallback("mo:", group.id)).row();
    }
    if (providersCb !== undefined)
        kb.row().text("\u{1F6F0}\uFE0F Providers", providersCb);
    return kb.row().text("\u{1F50D} Discover models", "m:discover").text("\u2190 Back", "m:back");
}
/** Standalone Providers view (llm.providers): one row per provider plus back
 * to the Models card. Tapping a provider opens its model list. */
export function buildProvidersKeyboard(rows) {
    const kb = new InlineKeyboard();
    for (const row of rows.slice(0, 20)) {
        kb.text(row.label.slice(0, 48), row.cb).row();
    }
    return kb.row().text("\u2190 Models", "m:models").text("\u2190 Back", "m:back");
}
/** New-session preset picker (web session.create's agentPreset): one
 * full-width default button plus a row per preset. */
export function buildNewSessionKeyboard(defaultCb, presets) {
    const kb = new InlineKeyboard().text("\u2728 Use default preset", defaultCb);
    for (const preset of presets.slice(0, 12)) {
        kb.row().text(`\u{1F3AD} ${preset.isDefault ? "\u2B50 " : ""}${preset.id.slice(0, 32)}`, preset.cb);
    }
    return kb.row().text("\u2716 Close", "m:close");
}
export function buildModelDetailKeyboard(models, thinking, paging) {
    const rows = [];
    for (const model of models.slice(0, 12)) {
        rows.push([{ text: `${model.name.slice(0, 40)}${model.id === model.name ? "" : ` \u00B7 ${model.id.slice(0, 20)}`}`.slice(0, 60), callback_data: model.cb }]);
    }
    if (paging !== undefined && (paging.previous !== undefined || paging.next !== undefined)) {
        const nav = [];
        if (paging.previous !== undefined)
            nav.push({ text: "\u2039 Prev", callback_data: paging.previous });
        if (paging.next !== undefined)
            nav.push({ text: "More \u203A", callback_data: paging.next });
        rows.push(nav);
    }
    if (thinking !== undefined)
        rows.push([{ text: `\u{1F9E0} Thinking \u00B7 ${thinking.label}`.slice(0, 64), callback_data: thinking.cb }]);
    rows.push([{ text: "\u2190 Providers", callback_data: "m:models" }]);
    return InlineKeyboard.from(rows);
}
/** Reasoning-effort picker: the fixed codex-telegram-bot levels
 * (minimal/low/medium/high/max), backend-independent. */
export function buildThinkingKeyboard(options, current) {
    const rows = [];
    for (const option of options) {
        const checked = option.id === current;
        rows.push([{ text: `${checked ? "\u2705" : "\u25CB"} ${option.name.slice(0, 40)}`, callback_data: option.cb }]);
    }
    rows.push([{ text: "\u2190 Back", callback_data: "m:back" }]);
    return InlineKeyboard.from(rows);
}
export function buildGoalsKeyboard(hasGoal, callbacks, paused = false) {
    const kb = new InlineKeyboard();
    if (hasGoal) {
        const actions = [];
        if (callbacks.edit !== undefined)
            actions.push({ text: "\u270F Edit", callback_data: callbacks.edit });
        if (callbacks.toggle !== undefined) {
            actions.push({ text: paused ? "\u25B6 Resume" : "\u23F8 Pause", callback_data: callbacks.toggle });
        }
        if (actions.length > 0)
            kb.row(...actions.slice(0, 2));
        if (callbacks.clear !== undefined)
            kb.row().text("\u{1F5D1} Clear goal", callbacks.clear);
    }
    // No goal = display-only: starting a goal is the `/goal <objective>` command.
    return kb.row().text("\u2190 Back", "m:back");
}
export function buildSkillsKeyboard() {
    return new InlineKeyboard().row().text("\u2190 Back", "m:back");
}
export function buildSubagentsKeyboard(entries) {
    const kb = new InlineKeyboard();
    for (const entry of entries.slice(0, 20)) {
        kb.text(`\u{1F916} ${entry.id.slice(0, 30)}`, entry.cb).row();
    }
    return kb.row().text("\u2190 Back", "m:back");
}
export function buildSubagentDetailKeyboard(callbacks) {
    const kb = new InlineKeyboard();
    const actions = [];
    if (callbacks.prompt !== undefined)
        actions.push({ text: "\u{1F4E8} Prompt", callback_data: callbacks.prompt });
    if (callbacks.interrupt !== undefined)
        actions.push({ text: "\u23F9 Interrupt", callback_data: callbacks.interrupt });
    actions.push({ text: "\u{1F4DC} History", callback_data: callbacks.history });
    kb.row(...actions.slice(0, 3));
    return kb.row().text("\u2190 Subagents", "m:subagents");
}
export function buildPresetsKeyboard(entries) {
    const kb = new InlineKeyboard();
    for (const entry of entries.slice(0, 20)) {
        kb.text(`${entry.id.slice(0, 34)}${entry.id.length > 34 ? "\u2026" : ""}`, entry.cb).row();
    }
    return kb.row().text("\u2190 Back", "m:back");
}
export function buildPresetDetailKeyboard(callbacks) {
    return new InlineKeyboard()
        .row()
        .text("\u{1F3AD} Select", callbacks.select)
        .text("\u{1F4C4} Read", callbacks.read)
        .row()
        .text("\u2728 New with this preset", callbacks.create)
        .row()
        .text("\u{1F4CB} Copy", callbacks.copy)
        .text("\u{1F5D1} Remove", callbacks.remove)
        .row()
        .text("\u2B50 Set default", callbacks.default)
        .row()
        .text("\u{1F4C2} Open document", callbacks.open)
        .row()
        .text("\u2190 Presets", "m:presets");
}
export function buildSettingsKeyboard(namespaces) {
    const kb = new InlineKeyboard();
    for (const ns of namespaces.slice(0, 20)) {
        kb.text(ns.slice(0, 40), encodedCallback("set:", ns)).row();
    }
    return kb.row().text("\u2190 Back", "m:back");
}
export function buildCredentialsKeyboard(refs) {
    const kb = new InlineKeyboard();
    for (const row of (refs ?? []).slice(0, 12)) {
        kb.text(`\u{1F511} ${row.ref.slice(0, 40)}`, row.cb).row();
    }
    return kb.row().text("\u{1F511} Describe ref", "m:cred-describe").text("\u2190 Back", "m:back");
}
export function buildHostKeyboard() {
    const kb = new InlineKeyboard();
    kb.row().text("\u{1F4C2} Browse cwd", "h:browse");
    kb.row().text("\u{1F4C1} Mkdir", "h:mkdir");
    return kb.row().text("\u2190 Back", "m:back");
}
export function buildDynamicCordisKeyboard() {
    return new InlineKeyboard().row().text("\u2190 Back", "m:back");
}
/** Issue #50: per-plugin lifecycle actions plus the Add entry. Long ids stay
 * out of the 64-byte callback limit — callers pass minted tokens. */
export function buildPluginLifecycleKeyboard(rows) {
    const keyboard = new InlineKeyboard().text("\u2795 Add plugin", "p:add");
    for (const row of rows) {
        const label = row.pluginId.length > 24 ? `${row.pluginId.slice(0, 23)}\u2026` : row.pluginId;
        keyboard.row().text(`${row.running ? "\u23F8 Stop" : "\u25B6 Run"} ${label}`, row.running ? row.callbacks.stop : row.callbacks.run);
        keyboard.text("\u{1F5D1} Remove", row.callbacks.remove);
    }
    return keyboard.row().text("\u2190 Back", "m:back");
}
export function buildCapabilitiesKeyboard() {
    return new InlineKeyboard().row().text("\u2190 Back", "m:back");
}
//# sourceMappingURL=keyboard.js.map