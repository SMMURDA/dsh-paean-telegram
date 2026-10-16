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
export declare const MENU_BTN = "\u2630 Menu";
export declare const NEW_BTN = "\u2728 New";
export declare const COMPACT_BTN = "\uD83E\uDDF9 Compact";
export declare const MODELS_BTN = "\uD83E\uDDE9 Models";
export declare const PLUGINS_BTN = "\uD83D\uDD0C Plugins";
export declare const MODE_BTN = "\uD83C\uDFAD Mode";
export declare const SESSIONS_BTN = "\uD83E\uDDED Sessions";
export declare const STATUS_BTN = "\uD83D\uDCCA Status";
export declare const QUEUE_BTN = "\u231B Queue";
export declare const QUEUE_BTN_PREFIX = "\u231B Queue \u00B7 ";
export declare const GOAL_BTN = "\uD83C\uDFAF Goal";
export declare const TODO_BTN = "\uD83D\uDCCB Todos";
export declare const TODO_BTN_PREFIX = "\uD83D\uDCCB Todos \u00B7 ";
/** Kept so clients with stale bars still dispatch; no longer rendered on the bar. */
export declare const PRESETS_BTN = "\uD83C\uDFAD Presets";
export declare const THINKING_BTN = "\uD83E\uDDE0 Thinking";
/** Bar label for the reasoning picker (unified name; THINKING_BTN kept for
 * stale client bars). */
export declare const REASONING_BTN = "\uD83E\uDDE0 Reasoning";
/** Abort the current turn only; `/stop` is the command that closes the session. */
export declare const ABORT_BTN = "\u23F9 Abort";
/** Legacy bar label from older clients; still dispatches to abort. */
export declare const STOP_BTN = "\u23F9 Stop";
/** Collapses the whole bar to a single return button (more chat history visible). */
export declare const COLLAPSE_BTN = "\uD83D\uDDDC\uFE0F \u6536\u8D77";
/** The one button left on a collapsed bar; tapping it restores the full bar. */
export declare const RETURN_BTN = "\u8FD4\u56DE";
/** Stale client bars from earlier builds keep these labels working. */
export declare const LEGACY_COLLAPSE_BTN = "\uD83D\uDE48 \u6536\u8D77";
export declare const LEGACY_RETURN_BTN = "\uD83D\uDD19 \u8FD4\u56DE";
export declare const BAR_LABELS: readonly string[];
/** Queue button label with a live count embedded (`⌛ Queue · 3`). */
export declare function queueBarLabel(queueCount: number): string;
/** Todo button label with the remaining count embedded (`📋 Todos · 3`). */
export declare function todoBarLabel(todoCount: number): string;
/** Build `<prefix><url-encoded value><suffix>` bounded to Telegram's 64-BYTE
 * callback_data limit by trimming the raw value before encoding, so the
 * result is always valid percent-encoding (never truncated mid-sequence).
 * `suffix` (e.g. `:use`) is appended verbatim after its bytes are reserved
 * from the budget, so action-bearing payloads stay byte-safe too. */
export declare function encodedCallback(prefix: string, value: string, suffix?: string): string;
/** Byte-safe callback_data for ids read back VERBATIM by colon-splitting
 * parsers (`s:`, `w:`): a value that already fits Telegram's 64-byte cap
 * passes through unchanged — colons included, so `data.split(":")` keeps
 * resolving ids exactly as before — and only an oversized value falls back
 * to the percent-encoded trimmed form (audit RE-9: a UTF-16 code-unit slice
 * could still exceed the byte budget and 400 the whole card). */
export declare function boundedCallback(prefix: string, value: string, suffix?: string): string;
/** Decode a callback payload that should be percent-encoded. Legacy cards or
 * providers whose ids contain a literal `%` are decoded best-effort; a
 * malformed sequence must return the raw value instead of killing the tap. */
export declare function decodeCallbackValue(value: string): string;
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
export declare function buildBarKeyboard(queueCount?: number, todoCount?: number): Keyboard;
/** Collapsed bar: only the return button, so the chat itself gets the screen. */
export declare function buildCollapsedBarKeyboard(): Keyboard;
/** Map inbound bar-button text back to its canonical label. The Queue
 * button's text changes as the live count is embedded (`⌛ Queue · 7`), so
 * exact BAR_LABELS matching alone would drop those taps. */
export declare function normalizeBarLabel(text: string): string | undefined;
export interface MenuItem {
    label: string;
    cb: string;
    /** Full-width row; otherwise items pair two-per-row. */
    full?: boolean;
}
/** Dense paginated menu (codex-bridge style): primary items full-width,
 * the rest paired two-per-row, then prev/page/next + close. */
export declare function buildMenuPage(items: readonly MenuItem[], page: number, total: number): InlineKeyboard;
/** Single "back to menu" row for domain cards that only need one action. */
export declare function buildBackKeyboard(): InlineKeyboard;
/** Two-button confirmation row for destructive actions. */
export declare function buildConfirmKeyboard(callbacks: {
    confirm: string;
    cancel: string;
}): InlineKeyboard;
export interface ProjectRow {
    label: string;
    cb: string;
}
export interface ProjectActions {
    up?: string;
    home?: string;
    root?: string;
    use?: string;
    close?: string;
    menu?: string;
    newFolder?: string;
    quick?: readonly ProjectRow[];
    paging?: readonly {
        text: string;
        cb: string;
    }[];
    /** Breadcrumb segment buttons (host.listDirectory navigation), rendered
     * right below the Up/Home/Root row. */
    breadcrumb?: readonly ProjectRow[];
}
/** Folder picker: nav row (Up/Home/Root) + quick workspace paths, then
 * directory entries two per row, then Use/Close. Pure builder — callback
 * payloads are pre-encoded by index.ts. */
export declare function buildProjectKeyboard(dirs: readonly ProjectRow[], actions: ProjectActions): InlineKeyboard;
export declare const CALLBACK_RE: RegExp;
export interface SessionsPaging {
    previous?: string;
    next?: string;
}
/** Generic pagination row for text-heavy cards plus a back button. */
export declare function buildPagingKeyboard(callbacks: {
    previous?: string;
    next?: string;
    back: string;
}): InlineKeyboard;
export declare function buildSearchKeyboard(ids: readonly string[], paging?: SessionsPaging): InlineKeyboard;
export interface SessionsKeyboardOptions {
    /** Project count for the switcher button; the button is omitted without a callback. */
    projectCount?: number;
    /** Token callback that opens the project switcher. */
    projectsCb?: string;
    paging?: SessionsPaging;
    back?: string;
}
export declare function buildSessionsKeyboard(items: readonly {
    id: string;
    title?: string;
    running?: boolean;
    archiveCb?: string;
    deleteCb?: string;
}[], options?: SessionsKeyboardOptions): InlineKeyboard;
export interface SessionProjectRow {
    label: string;
    running: number;
    total: number;
    cb: string;
}
export interface SessionProjectsKeyboardOptions {
    /** Optional "all sessions" flat-view callback. */
    all?: string;
    paging?: SessionsPaging;
    back: string;
}
/** Project switcher for the grouped Sessions card: running projects first
 * (the caller orders them), then paging and back. */
export declare function buildSessionProjectsKeyboard(items: readonly SessionProjectRow[], options: SessionProjectsKeyboardOptions): InlineKeyboard;
export declare function buildHistoryKeyboard(sessionId: string, older?: string): InlineKeyboard;
export declare function buildSessionDetailKeyboard(id: string, archived: boolean, back?: string): InlineKeyboard;
export declare function buildWorkspaceKeyboard(items: readonly {
    id: string;
    title: string;
}[]): InlineKeyboard;
export declare function buildWorkspaceDetailKeyboard(id: string, actions?: {
    use?: string;
    sessions?: string;
}): InlineKeyboard;
export interface QueueRow {
    itemId: string;
    kind: "next-turn" | "next-step";
    /** 0-based position in the combined inbox list; rendered as `#1`, `#2`, … */
    index?: number;
}
/** ForceReply keyboard for step-by-step text prompts: Telegram opens the
 * reply input automatically, which is much friendlier on a phone than asking
 * the user to find and quote a message manually. */
export declare function inputPromptKeyboard(placeholder: string): {
    force_reply: true;
    input_field_placeholder: string;
};
export declare function buildQueueKeyboard(items: readonly QueueRow[]): InlineKeyboard;
export declare function buildModelsKeyboard(groups: readonly {
    id: string;
    name: string;
}[], providersCb?: string, currentProviderId?: string): InlineKeyboard;
/** Standalone Providers view (llm.providers): one row per provider plus back
 * to the Models card. Tapping a provider opens its model list. */
export declare function buildProvidersKeyboard(rows: readonly {
    label: string;
    cb: string;
}[]): InlineKeyboard;
/** New-session preset picker (web session.create's agentPreset): one
 * full-width default button plus a row per preset. */
export declare function buildNewSessionKeyboard(defaultCb: string, presets: readonly {
    id: string;
    isDefault: boolean;
    cb: string;
}[]): InlineKeyboard;
export interface ModelPaging {
    previous?: string;
    next?: string;
}
export declare function buildModelDetailKeyboard(models: readonly {
    id: string;
    name: string;
    cb: string;
}[], thinking?: {
    label: string;
    cb: string;
}, paging?: ModelPaging): InlineKeyboard;
/** Reasoning-effort picker: the fixed codex-telegram-bot levels
 * (minimal/low/medium/high/max), backend-independent. */
export declare function buildThinkingKeyboard(options: readonly {
    id: string;
    name: string;
    cb: string;
}[], current?: string): InlineKeyboard;
export declare function buildGoalsKeyboard(hasGoal: boolean, callbacks: {
    edit?: string;
    toggle?: string;
    clear?: string;
}, paused?: boolean): InlineKeyboard;
export declare function buildSkillsKeyboard(): InlineKeyboard;
export declare function buildSubagentsKeyboard(entries: readonly {
    id: string;
    cb: string;
}[]): InlineKeyboard;
export declare function buildSubagentDetailKeyboard(callbacks: {
    prompt?: string;
    interrupt?: string;
    history: string;
}): InlineKeyboard;
export declare function buildPresetsKeyboard(entries: readonly {
    id: string;
    cb: string;
}[]): InlineKeyboard;
export declare function buildPresetDetailKeyboard(callbacks: {
    select: string;
    read: string;
    create: string;
    copy: string;
    remove: string;
    open: string;
    default: string;
}): InlineKeyboard;
export declare function buildSettingsKeyboard(namespaces: readonly string[]): InlineKeyboard;
export declare function buildCredentialsKeyboard(refs?: readonly {
    ref: string;
    cb: string;
}[]): InlineKeyboard;
export declare function buildHostKeyboard(): InlineKeyboard;
export declare function buildDynamicCordisKeyboard(): InlineKeyboard;
export interface PluginRow {
    pluginId: string;
    running: boolean;
    callbacks: {
        run: string;
        stop: string;
        remove: string;
    };
}
/** Issue #50: per-plugin lifecycle actions plus the Add entry. Long ids stay
 * out of the 64-byte callback limit — callers pass minted tokens. */
export declare function buildPluginLifecycleKeyboard(rows: readonly PluginRow[]): InlineKeyboard;
export declare function buildCapabilitiesKeyboard(): InlineKeyboard;
