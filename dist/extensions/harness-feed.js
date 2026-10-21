import { escapeHtml, splitText, truncate } from "../telegram/html.js";
import { markdownTablePreBlock, markdownToHtml } from "../telegram/markdown.js";
import { safeWrap } from "../telegram/safe.js";
import { renderTurnReceipt } from "../telegram/turn-receipt.js";
// Shared heartbeat constant (telegram/goal-progress is the lower layer).
import { LIVENESS_HEARTBEAT_MS } from "../telegram/goal-progress.js";
import { extractLocalImageRefs } from "../media/image-refs.js";
/** Visible activity rows (frozen think lines + tool rows); older rows scroll off. */
const MAX_LINES = 8;
/** Frozen think line cap (web ReasoningRow keeps one summary line). */
const THINK_MAX_CHARS = 120;
/** Live think tail cap — a little wider so the flowing line reads naturally. */
const THINK_LIVE_MAX_CHARS = 160;
/** Compact-row caps for tool titles/details. */
const TOOL_TITLE_CHARS = 80;
const TOOL_DETAIL_CHARS = 90;
/**
 * Per-message edit throttle. The retired openclaw draft ran at 200ms and
 * fought Telegram's per-chat budget all the way into multi-minute 429
 * penalties; web streams freely because DOM writes are free. Two slots at
 * 1s each keep the typewriter feel inside the transport's sliding window.
 */
const EDIT_THROTTLE_MS = 1000;
/** After a failed edit, retry the SAME message with exponential backoff. */
const EDIT_RETRY_BASE_MS = 1500;
const EDIT_RETRY_MAX_MS = 30_000;
/** Only abandon a message after this many consecutive edit failures. */
const MAX_EDIT_FAILURES = 5;
/** Heartbeat budget per activity card (#48): 60 beats x 30s = 30 min hard cap. */
const MAX_HEARTBEATS = 60;
const NO_REPLY_REMINDER = "\u231B The turn ended without a telegram_reply \u2014 use the telegram_reply tool or reply yourself.";
/**
 * Telegram's hard per-message cap — the transport default (#HF-2 A). The
 * transport REFUSES any edit above it without an API round trip (guaranteed
 * "message is too long" 400) while the SEND path splits via splitText, so an
 * uncapped answer body used to mean: edits burn the retry budget on 400s and
 * the final delivery dies with only the degraded warning left behind.
 */
const TRANSPORT_MAX_MESSAGE_LENGTH = 4096;
/** Marker shown above a tail-window-truncated streaming edit (HF-2 A): the
 * live bubble keeps showing the NEWEST prose; the full text still lands at
 * settlement through the splitting send path. */
const ANSWER_TAIL_MARK = "<i>\u22EF \u2702 full answer lands when the turn ends</i>\n";
function toolsRegistry(host) {
    try {
        const ctx = host.requireCtx();
        const tools = ctx.get?.("tools");
        return tools !== undefined && typeof tools.get === "function" ? tools : undefined;
    }
    catch {
        return undefined;
    }
}
/** Presenters through the harness registry; any throw soft-falls to
 * undefined exactly like api-proxy viewFor (the generic card covers misses). */
function callViewFor(host, name, args) {
    try {
        return toolsRegistry(host)?.get(name, host.currentAgent())?.presentCall?.(args);
    }
    catch {
        return undefined;
    }
}
function resultViewFor(host, name, args, result) {
    try {
        return toolsRegistry(host)?.get(name, host.currentAgent())?.presentResult?.(args, result);
    }
    catch {
        return undefined;
    }
}
/* ------------------------------------------------------------------ */
/* View → compact Telegram row rendering                               */
/* ------------------------------------------------------------------ */
function safeJson(value) {
    try {
        return JSON.stringify(value) ?? "";
    }
    catch {
        return "";
    }
}
/** Presenter titles are user-visible text under parse_mode HTML callers —
 * flatten non-strings defensively (escaped downstream). */
function flatText(value) {
    if (typeof value === "string")
        return value;
    if (value === undefined || value === null)
        return "";
    return safeJson(value);
}
function clipChars(text, max) {
    const chars = Array.from(text);
    return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}\u2026`;
}
/** Pending-state icon by card kind — coarse categories only; presenter titles
 * carry the specifics instead of a hand-maintained name→emoji table. */
function callIcon(view) {
    if (view === undefined || view.card === "generic") {
        if (view !== undefined && view.kind === "search")
            return "\u{1F50D}";
        if (view !== undefined && view.kind === "read")
            return "\u{1F4C4}";
        if (view !== undefined && view.kind === "fetch")
            return "\u{1F310}";
        return "\u{1F527}";
    }
    switch (view.card) {
        case "terminal":
            return "\u25B8"; // ▸ shell
        case "diff":
            return "\u270E"; // ✎ file mutation
        default:
            return "\u{1F527}";
    }
}
/** Completed-state suffix from the harness result view — exit codes, match
 * counts, source counts, HTTP status: the same signals the web cards show. */
function resultSuffix(view) {
    if (view === undefined)
        return undefined;
    switch (view.card) {
        case "terminal":
            if (view.exitCode !== undefined)
                return `exit ${view.exitCode}`;
            if (view.signal !== undefined)
                return String(view.signal);
            return undefined;
        case "search":
            return view.shape === "matches"
                ? `${view.total} matches${view.truncated ? " \u00B7 truncated" : ""}`
                : `${view.total} paths${view.truncated ? " \u00B7 truncated" : ""}`;
        case "web":
            return view.kind === "search"
                ? `${view.sources.length} sources${view.truncated ? " \u00B7 truncated" : ""}`
                : `HTTP ${view.statusCode}`;
        case "read": {
            const path = flatText(view.path);
            return path === "" ? undefined : clipChars(`${path}:${view.offset}`, TOOL_DETAIL_CHARS);
        }
        default:
            return undefined; // diff paths already show on the pending row
    }
}
/** One compact tool row. Pending rows show the harness call view's title and
 * salient input; completed rows swap the status icon and add the result
 * view's suffix signal (exit code / match count / source count / status). */
function renderToolRow(name, args, view, done, suffix) {
    let title = name;
    let detail = "";
    if (view === undefined) {
        // Generic soft-fall mirrors the web's default card (title = tool name,
        // raw args as the salient input).
        detail = typeof args === "string" ? args.trim() : args === undefined || args === null ? "" : safeJson(args);
    }
    else if (view.card === "terminal") {
        title = flatText(view.title);
        detail = view.cwd === undefined ? "" : String(view.cwd);
    }
    else if (view.card === "diff") {
        title = flatText(view.title);
        detail = view.diffs[0]?.path ?? "";
    }
    else {
        title = flatText(view.title) || name;
        detail =
            view.rawInput === undefined || view.rawInput === null
                ? ""
                : typeof view.rawInput === "string"
                    ? view.rawInput
                    : safeJson(view.rawInput);
    }
    if (detail === "{}" || detail === "null")
        detail = "";
    const icon = done === true ? "\u2713" : done === false ? "\u2717" : callIcon(view);
    const parts = [`<b>${icon} ${escapeHtml(clipChars(title, TOOL_TITLE_CHARS))}</b>`];
    if (detail !== "")
        parts.push(`<code>${escapeHtml(clipChars(detail, TOOL_DETAIL_CHARS))}</code>`);
    if (suffix !== undefined && suffix !== "")
        parts.push(escapeHtml(suffix));
    else if (done === undefined)
        parts.push("<i>running</i>");
    else if (done === false)
        parts.push("<i>failed</i>");
    return parts.join(" ");
}
/* ------------------------------------------------------------------ */
/* Think line rendering (web ReasoningRow semantics)                    */
/* ------------------------------------------------------------------ */
const THINKING_TAG_RE = /<\s*(\/?)\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>/gi;
const THINKING_HEADER_RE = /^\s*(?:>\s*)?(?:Reasoning:\s*(?:\r?\n|\r)\s*|Thinking\.{0,3}\s*(?:\r?\n|\r)\s*(?:\r?\n|\r)\s*)/i;
/** Thinking lines stay plain italic text without markdown noise. */
function stripThinkingMarkdown(text) {
    return text
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/#{1,6}\s+/g, "")
        .replace(/^>\s+/gm, "");
}
function normalizeReasoning(text) {
    const stripped = (text ?? "").replace(THINKING_TAG_RE, "");
    return stripThinkingMarkdown(stripped)
        .replace(THINKING_HEADER_RE, "")
        .replace(/[ \t]+/g, " ")
        .trim();
}
/** Latest non-empty line while running (ReasoningRow.latestLine). */
function latestLine(text) {
    const visible = normalizeReasoning(text);
    if (visible === "")
        return "";
    const newline = visible.lastIndexOf("\n");
    return (newline === -1 ? visible : visible.slice(newline + 1)).trim();
}
/** First line when frozen (ReasoningRow.firstLine). */
function firstLine(text) {
    const visible = normalizeReasoning(text);
    if (visible === "")
        return "";
    const newline = visible.indexOf("\n");
    return (newline === -1 ? visible : visible.slice(0, newline)).trim();
}
function thinkHtml(running, raw) {
    // A reasoning snapshot that is a GFM table renders as an aligned
    // monospace block instead of leaking raw pipes (issue #26).
    const stripped = (raw ?? "").replace(THINKING_TAG_RE, "");
    const table = markdownTablePreBlock(stripped);
    if (table !== undefined)
        return `\u{1F9E0} ${table}`;
    const line = running ? latestLine(raw) : firstLine(raw);
    if (line === "")
        return "";
    return `\u{1F9E0} <i>${escapeHtml(clipChars(line, running ? THINK_LIVE_MAX_CHARS : THINK_MAX_CHARS))}</i>`;
}
function freshFeed(carried, canRender = true) {
    return {
        blocks: new Map(),
        lines: [],
        liveThinkRaw: "",
        reasoningSteps: 0,
        toolCalls: 0,
        step: 0,
        startedAt: Date.now(),
        dirtyActivity: false,
        dirtyAnswer: false,
        editAttempts: 0,
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        editSucceeded: 0,
        activityEditFails: 0,
        answerEditFails: 0,
        heartbeats: 0,
        canRender,
        ...(carried?.activityId === undefined ? {} : { activityId: carried.activityId }),
        ...(carried?.activitySending === undefined ? {} : { activitySending: carried.activitySending }),
        ...(carried?.placeholderFailed === true ? { placeholderFailed: true } : {}),
    };
}
/**
 * Concatenated prose across ALL steps' text blocks in (step, index) order
 * (web assistantText: folding is per assistant message = per step, while the
 * single Telegram bubble carries the whole turn — HF-1). Reasoning and
 * tool-call blocks contribute nothing.
 */
function answerText(feed) {
    return [...feed.blocks.values()]
        .sort((a, b) => a.step - b.step || a.index - b.index)
        .map((block) => (block.kind === "text" ? block.text : ""))
        .join("");
}
/** The limit the transport actually enforces, read live from config so
 * `/config set outbound.maxMessageLength` keeps the feed honest (#HF-2 A).
 * Anything non-numeric falls back to the transport default — test hosts stub
 * the config getter with `true`, which must degrade to 4096, not NaN. */
function maxMessageLength(host) {
    const configured = host.getConfigPath?.("outbound.maxMessageLength");
    return typeof configured === "number" && Number.isFinite(configured) && configured >= 512
        ? Math.floor(configured)
        : TRANSPORT_MAX_MESSAGE_LENGTH;
}
/**
 * Tail window for streaming edits of an oversized answer (#HF-2 A): the last
 * splitText part is a balanced HTML fragment under the budget (splitText
 * closes and reopens tags around the cut), so the truncated bubble never
 * leaks a half-open tag while staying under the transport's refuse-over
 * edit threshold.
 */
function tailWindowHtml(html, max) {
    const budget = max - ANSWER_TAIL_MARK.length;
    if (budget <= 0)
        return html.slice(0, max); // degenerate config; raw cut beats looping
    const parts = splitText(html, budget);
    return `${ANSWER_TAIL_MARK}${parts[parts.length - 1] ?? ""}`;
}
/* ------------------------------------------------------------------ */
/* Mount                                                               */
/* ------------------------------------------------------------------ */
/** Cordis dependency: the main dsh-telegram plugin's provided bridge host.
 * The loader waits for this service and hands it over as `ctx.telegram`. */
export const inject = ["telegram"];
/** Module-level mount guard: the feed may be mounted EITHER built-in by
 * index.ts OR through a loader entry importing this module — both paths share
 * this module instance, so double mounting is a no-op instead of producing
 * two competing drafts per chat. */
let activeHost;
/** Teardown body of the ACTIVE mount. */
let teardownActive;
export function unmountHarnessFeed() {
    const teardown = teardownActive;
    teardownActive = undefined;
    teardown?.();
}
export function apply(ctx, _config) {
    const host = ctx.telegram;
    if (host === undefined)
        return;
    mountHarnessFeed(host, ctx);
}
/**
 * Mount the harness-native streaming feed onto a bridge host. Built-in entry
 * used by index.ts; idempotent while active.
 */
export function mountHarnessFeed(host, ctx) {
    if (activeHost === host)
        return;
    if (activeHost !== undefined)
        unmountHarnessFeed();
    activeHost = host;
    console.error("[dsh-telegram] harness streaming feed mounted");
    let disposed = false;
    const chats = new Map();
    /** Committed assistant message per chat (authoritative final prose). */
    const answers = new Map();
    /**
     * Answer-placeholder sends that turn/end has CLAIMED for in-place
     * settlement (HF-2 B): while the "…" send is still in flight, settlement
     * defers on it, so a late landing must be edited into the final answer —
     * not mistaken for an orphan and deleted.
     */
    const claimedAnswerSends = new WeakSet();
    /**
     * One chat's live turn: folded harness state plus the two Telegram message
     * slots (activity card + streaming answer) with their throttled-edit
     * machinery.
     */
    class Turn {
        chatId;
        feed;
        constructor(chatId, carried, canRender = true) {
            this.chatId = chatId;
            this.feed = freshFeed(carried, canRender);
        }
        /** Live ownership = chats entry + not aborted (#48) + rendering allowed
         * (HF-3 A). Every render path funnels through here, so a liveFeed toggle
         * strands nothing: timers armed before the toggle may still fire once,
         * but every flush/schedule behind this check no-ops. */
        owned() {
            return chats.get(this.chatId) === this && this.feed.stopped !== true && this.feed.canRender;
        }
        /* ---- ACTIVITY card ---- */
        renderActivity(liveness = false) {
            const feed = this.feed;
            const lines = [this.titleFor(liveness)];
            for (const entry of feed.lines.slice(-MAX_LINES))
                lines.push(entry.html);
            const liveThink = thinkHtml(true, feed.liveThinkRaw);
            if (liveThink !== "")
                lines.push(liveThink);
            return lines.join("\n");
        }
        activityFlush(force = false, liveness = false) {
            const feed = this.feed;
            if (!this.owned())
                return;
            const messageId = feed.activityId;
            if (messageId === undefined)
                return;
            const body = this.renderActivity(liveness);
            if (!force && !feed.dirtyActivity)
                return;
            feed.dirtyActivity = false;
            // Diff check (#15): Telegram rejects "message is not modified" edits.
            // The forced retry path bypasses the diff on purpose.
            if (!force && body === feed.activityLastHtml)
                return;
            feed.editAttempts += 1;
            void safeWrap("harness-activity-edit", () => host.editMessage(this.chatId, messageId, body, { parse_mode: "HTML" })).then((edited) => {
                if (chats.get(this.chatId) !== this)
                    return;
                if (edited === true) {
                    feed.activityLastHtml = body;
                    feed.activityEditFails = 0;
                    feed.editSucceeded += 1;
                    if (feed.activityRetryTimer !== undefined) {
                        clearTimeout(feed.activityRetryTimer);
                        feed.activityRetryTimer = undefined;
                    }
                    return;
                }
                this.editFailed("activity");
            });
        }
        activitySchedule() {
            const feed = this.feed;
            if (!this.owned())
                return;
            feed.dirtyActivity = true;
            // Fresh content supersedes an older frame's retry.
            if (feed.activityRetryTimer !== undefined) {
                clearTimeout(feed.activityRetryTimer);
                feed.activityRetryTimer = undefined;
            }
            if (feed.activityTimer !== undefined)
                return;
            feed.activityTimer = setTimeout(() => {
                feed.activityTimer = undefined;
                this.activityFlush(false);
            }, EDIT_THROTTLE_MS);
        }
        /* ---- ANSWER message ---- */
        renderAnswer() {
            const text = answerText(this.feed);
            if (text.trim() === "")
                return undefined;
            return markdownToHtml(text);
        }
        answerFlush(force = false) {
            const feed = this.feed;
            if (!this.owned())
                return;
            const messageId = feed.answerId;
            if (messageId === undefined)
                return;
            const rendered = this.renderAnswer();
            if (rendered === undefined)
                return;
            // HF-2 A: never hand the transport a guaranteed-400 payload. The live
            // bubble streams a tail window behind a marker; settlement delivers the
            // complete text through the splitting send path. This capping IS the
            // retry-budget protection: without it every frame of a long answer
            // failed fast false and burned an edit-failure backoff round.
            const limit = maxMessageLength(host);
            const body = rendered.length > limit ? tailWindowHtml(rendered, limit) : rendered;
            if (!force && !feed.dirtyAnswer)
                return;
            feed.dirtyAnswer = false;
            if (!force && body === feed.answerLastHtml)
                return;
            feed.editAttempts += 1;
            void safeWrap("harness-answer-edit", () => host.editMessage(this.chatId, messageId, body, { parse_mode: "HTML" })).then((edited) => {
                if (chats.get(this.chatId) !== this)
                    return;
                if (edited === true) {
                    feed.answerLastHtml = body;
                    feed.answerEditFails = 0;
                    feed.editSucceeded += 1;
                    if (feed.answerRetryTimer !== undefined) {
                        clearTimeout(feed.answerRetryTimer);
                        feed.answerRetryTimer = undefined;
                    }
                    return;
                }
                // HF-2 A belt-and-braces: if the payload is STILL over the
                // transport's live limit (the configured max shrank mid-turn),
                // retries are guaranteed 400s — skip them; settlement re-routes.
                if (body.length > maxMessageLength(host)) {
                    console.error("[dsh-telegram] harness-answer-edit oversized", `chatId=${this.chatId} len=${body.length}`);
                    return;
                }
                this.editFailed("answer");
            });
        }
        answerSchedule() {
            const feed = this.feed;
            if (!this.owned())
                return;
            feed.dirtyAnswer = true;
            if (feed.answerRetryTimer !== undefined) {
                clearTimeout(feed.answerRetryTimer);
                feed.answerRetryTimer = undefined;
            }
            if (feed.answerTimer !== undefined)
                return;
            feed.answerTimer = setTimeout(() => {
                feed.answerTimer = undefined;
                this.answerFlush(false);
            }, EDIT_THROTTLE_MS);
        }
        /* ---- shared failure/backoff ---- */
        editFailed(slot) {
            const feed = this.feed;
            const failsKey = slot === "activity" ? "activityEditFails" : "answerEditFails";
            const retryKey = slot === "activity" ? "activityRetryTimer" : "answerRetryTimer";
            feed[failsKey] += 1;
            console.error("[dsh-telegram] harness-edit FAILED", `slot=${slot} chatId=${this.chatId} fails=${feed[failsKey]}`);
            if (feed[failsKey] > MAX_EDIT_FAILURES) {
                // Keep the SAME messageId (#23): announce once, never re-spawn
                // placeholders. New content may still try the retained message.
                feed[failsKey] = 0;
                if (slot === "activity" && feed.fallbackSent !== true) {
                    feed.fallbackSent = true;
                    console.error("[dsh-telegram] harness-activity-edit abandoned", `chatId=${this.chatId}`);
                    void safeWrap("harness-stalled-fallback", () => host.send(this.chatId, "\u26A0\uFE0F Agent is running, but live progress cannot be delivered right now \u2014 use /history to see details.", { parse_mode: "HTML" }));
                }
                return;
            }
            if (feed[retryKey] === undefined) {
                const delay = Math.min(EDIT_RETRY_MAX_MS, EDIT_RETRY_BASE_MS * 2 ** (feed[failsKey] - 1));
                feed[retryKey] = setTimeout(() => {
                    feed[retryKey] = undefined;
                    if (slot === "activity")
                        this.activityFlush(true);
                    else
                        this.answerFlush(true);
                }, delay);
            }
        }
        titleFor(liveness) {
            const feed = this.feed;
            const goal = host.goalForChat?.(this.chatId);
            if (goal === undefined) {
                return liveness
                    ? `\u2699\uFE0F Working \u00B7 \u23F1\uFE0F ${Math.max(1, Math.round((Date.now() - feed.startedAt) / 1000))}s`
                    : "\u2699\uFE0F Working\u2026";
            }
            const base = `\u{1F4CA} ${escapeHtml(truncate(goal.objective, 48))} \u00B7 step ${feed.step}`;
            return liveness ? `${base} \u00B7 \u23F1\uFE0F ${Math.max(1, Math.round((Date.now() - feed.startedAt) / 1000))}s` : base;
        }
        clearTimers() {
            const feed = this.feed;
            for (const timer of [feed.activityTimer, feed.activityRetryTimer, feed.heartbeatTimer, feed.answerTimer, feed.answerRetryTimer]) {
                if (timer !== undefined)
                    clearTimeout(timer);
            }
            feed.activityTimer = undefined;
            feed.activityRetryTimer = undefined;
            feed.heartbeatTimer = undefined;
            feed.answerTimer = undefined;
            feed.answerRetryTimer = undefined;
        }
        /** Placeholder adoption (#12/#23): whoever owns the chat when the send
         * lands adopts the id; orphans after disposal are deleted. */
        watchSend(slot, pending) {
            const sendingKey = slot === "activity" ? "activitySending" : "answerSending";
            const idKey = slot === "activity" ? "activityId" : "answerId";
            void safeWrap(`harness-${slot}-send`, () => pending).then((id) => {
                const current = chats.get(this.chatId);
                if (current === undefined) {
                    // Late landing with no owner turn. Activity keeps the narrower
                    // disposed-only rule: a live feed's deferred finalize may still
                    // claim the landing card. Answer bubbles are orphans whenever the
                    // turn entry is gone AND turn/end did not claim this exact send
                    // for in-place settlement (HF-2 B) — without the delete, a "…"
                    // bubble that lost the race against teardown/restart stays in the
                    // chat forever.
                    if (id !== undefined &&
                        (slot === "activity" ? disposed : !claimedAnswerSends.has(pending))) {
                        void safeWrap("harness-orphan-cleanup", () => host.deleteMessage(this.chatId, id));
                    }
                    return;
                }
                if (current.feed[sendingKey] === pending)
                    current.feed[sendingKey] = undefined;
                if (id !== undefined && current.feed[idKey] === undefined)
                    current.feed[idKey] = id;
            });
            // Release the in-flight latch even when the send rejects: a stuck latch
            // would block every future ensure* call.
            void pending.catch(() => undefined).then(() => {
                const current = chats.get(this.chatId);
                if (current !== undefined && current.feed[sendingKey] === pending)
                    current.feed[sendingKey] = undefined;
            });
        }
        ensureAnswerMessage() {
            const feed = this.feed;
            // HF-3 A: no fresh "…" bubble once the turn lost rendering permission.
            if (feed.answerId !== undefined || feed.answerSending !== undefined || feed.stopped === true || !feed.canRender)
                return;
            // The streamed answer IS the final answer's message (web: one bubble
            // streams then settles), so it quotes the inbound from birth — no
            // second message is sent at turn end.
            const inboundMessageId = host.inboundMessageId(this.chatId);
            const pending = host.send(this.chatId, "\u2026", {
                parse_mode: "HTML",
                ...(inboundMessageId === undefined ? {} : { reply_parameters: { message_id: inboundMessageId } }),
            });
            feed.answerSending = pending;
            this.watchSend("answer", pending);
        }
        armHeartbeat() {
            const feed = this.feed;
            // HF-3 A: a suspended turn never arms/rearms the liveness loop — this
            // is the zombie-heartbeat kill switch for the mid-turn toggle-off.
            if (feed.heartbeatTimer !== undefined || feed.stopped === true || !feed.canRender)
                return;
            if ((host.getConfigPath?.("notify.onLongTask") ?? true) === false)
                return;
            // Hard deadline (#48): a lost turn/end can never edit one message
            // forever — MAX_HEARTBEATS bounds one card's liveness edits.
            if (feed.heartbeats >= MAX_HEARTBEATS)
                return;
            feed.heartbeatTimer = setTimeout(() => {
                feed.heartbeatTimer = undefined;
                if (!this.owned())
                    return;
                // HF-3 A: the liveness loop re-reads the LIVE flag so a toggle-off
                // with no intervening event still dies here instead of editing a
                // zombie card every 30s until MAX_HEARTBEATS.
                if (!host.liveFeedEnabled()) {
                    this.feed.canRender = false;
                    return;
                }
                feed.heartbeats += 1;
                // Edit immediately with the elapsed title: throttling to a 1s frame
                // would strip the liveness suffix again, and 1 edit/30s is far below
                // the per-chat rate limit.
                this.activityFlush(true, true);
                this.armHeartbeat();
            }, LIVENESS_HEARTBEAT_MS);
            // Liveness convenience, never a lifecycle owner: must not keep a test
            // process (or an idle Node process) alive by itself.
            feed.heartbeatTimer?.unref?.();
        }
        /** Commit the flowing Think burst into its own frozen line (web: one
         * disclosure per reasoning block). No-op for empty bursts. */
        freezeThink() {
            const feed = this.feed;
            if (normalizeReasoning(feed.liveThinkRaw) === "") {
                feed.liveThinkRaw = "";
                return;
            }
            const html = thinkHtml(false, feed.liveThinkRaw);
            feed.reasoningSteps += 1;
            feed.liveThinkRaw = "";
            if (html !== "") {
                feed.lines.push({ kind: "think", html });
                // HF-3 C: the reasoning block-end CLEARS liveThinkRaw and reasoning
                // never moves answerText, so neither post-fold schedule condition can
                // fire — the commit must schedule its own frame, or the frozen
                // first-line snapshot waits for an unrelated event (or never renders
                // at all before turn/end collapses the card into the receipt).
                this.activitySchedule();
            }
        }
    }
    /* ---------------- chunk folding (web ui-conversation semantics) ------- */
    const foldChunk = (turn, event) => {
        const feed = turn.feed;
        const chunk = event.data?.chunk;
        const usage = chunk?.type === "usage" ? chunk.usage : event.data?.usage;
        if (usage !== undefined) {
            feed.uncachedInputTokens += usage.inputTokens ?? 0;
            feed.outputTokens += usage.outputTokens ?? 0;
            feed.cacheReadTokens += usage.cacheReadTokens ?? 0;
            feed.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
        }
        if (chunk === undefined)
            return;
        // Fold key = (step, index): the harness restarts chunk.index from 0 for
        // every LLM step, so the bare index collided across steps of an agentic
        // turn and step 1's blocks overwrote step 0's streamed prose (HF-1).
        // Events without a step field (single-step shapes) fold under step 0,
        // byte-identical to the old scheme.
        const step = typeof event.data?.step === "number" ? event.data.step : 0;
        const index = typeof chunk.index === "number" ? chunk.index : 0;
        const key = `${step}:${index}`;
        switch (chunk.type) {
            case "block-start": {
                const kind = chunk.blockType === "reasoning" ? "reasoning" : chunk.blockType === "tool-call" ? "tool-call" : "text";
                // A new reasoning burst starts a fresh flowing Think line.
                if (kind === "reasoning")
                    turn.freezeThink();
                feed.blocks.set(key, { kind, text: "", step, index });
                break;
            }
            case "text-delta":
            case "reasoning-delta": {
                const text = typeof chunk.text === "string" ? chunk.text : "";
                if (text === "")
                    break;
                let block = feed.blocks.get(key);
                if (block === undefined) {
                    block = { kind: chunk.type === "text-delta" ? "text" : "reasoning", text: "", step, index };
                    feed.blocks.set(key, block);
                }
                if (block.kind === "text" && chunk.type === "text-delta")
                    block.text += text;
                else if (block.kind === "reasoning" && chunk.type === "reasoning-delta") {
                    block.text += text;
                    feed.liveThinkRaw += text;
                }
                else {
                    // Kind mismatch (provider reordered without block-start): trust the
                    // delta's own kind, mirroring the web fold's per-chunk branching.
                    feed.blocks.set(key, { kind: chunk.type === "text-delta" ? "text" : "reasoning", text, step, index });
                    if (chunk.type === "reasoning-delta")
                        feed.liveThinkRaw += text;
                }
                break;
            }
            case "block-end": {
                // Complete blocks are authoritative snapshots (web fold semantics),
                // applied to their OWN step's block (HF-1): a late snapshot for an
                // early step must not erase later steps' prose.
                const blockType = chunk.block?.type;
                const text = typeof chunk.block?.text === "string" ? chunk.block.text : undefined;
                if ((blockType === "text" || blockType === "reasoning") && text !== undefined) {
                    feed.blocks.set(key, { kind: blockType, text, step, index });
                    if (blockType === "reasoning") {
                        if (normalizeReasoning(feed.liveThinkRaw) === "")
                            feed.liveThinkRaw = text;
                        turn.freezeThink();
                    }
                }
                break;
            }
            default:
                break;
        }
    };
    /* ---------------- tool events through harness presenters -------------- */
    const handleToolCall = (turn, data) => {
        const feed = turn.feed;
        // A tool row lands between reasoning bursts: commit the current Think
        // line so the next burst starts its own line (web: one row per block).
        turn.freezeThink();
        const name = typeof data.name === "string" && data.name !== "" ? data.name : "tool";
        const key = typeof data.callId === "string" ? data.callId : `call:${feed.toolCalls}`;
        let args;
        try {
            args = typeof data.arguments === "string" ? JSON.parse(data.arguments) : (data.arguments ?? data.input);
        }
        catch {
            // Unparseable model arguments: presenters soft-fall on the raw value.
            args = data.arguments ?? data.input;
        }
        const view = callViewFor(host, name, args);
        const existing = feed.lines.find((line) => line.kind === "tool" && line.key === key);
        if (existing !== undefined) {
            existing.name = name;
            existing.args = args;
            existing.callView = view;
            existing.html = renderToolRow(name, args, view, undefined, undefined);
        }
        else {
            feed.lines.push({ kind: "tool", key, name, args, callView: view, html: renderToolRow(name, args, view, undefined, undefined) });
            feed.toolCalls += 1;
        }
        trimLines(feed);
        turn.activitySchedule();
    };
    const handleToolResult = (turn, data) => {
        const source = data.message?.source;
        const key = typeof source?.callId === "string" ? source.callId : typeof data.callId === "string" ? data.callId : undefined;
        const resultBlock = data.message?.content?.find((block) => block.type === "tool-result");
        const isError = resultBlock !== undefined ? resultBlock.isError === true : data.isError === true;
        const line = key === undefined
            ? [...turn.feed.lines].reverse().find((candidate) => candidate.kind === "tool")
            : turn.feed.lines.find((candidate) => candidate.kind === "tool" && candidate.key === key);
        if (line === undefined || line.name === undefined)
            return;
        // Re-present through the harness result path: same presenter contract as
        // api-proxy viewFor (parsed call args + durable result projection).
        const [rawContent] = resultBlock?.content ?? [];
        const result = {
            content: (rawContent ?? []),
            isError,
            ...(data.meta === undefined ? {} : { meta: data.meta }),
        };
        const view = resultViewFor(host, line.name, line.args, result);
        const suffix = resultSuffix(view);
        // Keep the pending card's title (callView); swap status icon + suffix.
        line.html = renderToolRow(line.name, line.args, line.callView, !isError, suffix);
        turn.activitySchedule();
    };
    function trimLines(feed) {
        if (feed.lines.length <= MAX_LINES * 2)
            return;
        feed.lines.splice(0, feed.lines.length - MAX_LINES * 2);
    }
    /* ---------------- turn settlement ---------------- */
    const handleTurnEnd = (chatId, event) => {
        const turn = chats.get(chatId);
        const liveFeedOn = host.liveFeedEnabled();
        /**
         * HF-3 A: a turn whose canRender went false (flag off at turn/start) was
         * delivered by the CORE forwarder — even if the flag is back on by now.
         * Settlement here is bookkeeping only: kill the zombie heartbeat timers,
         * drop the entries, and withdraw our partial artifacts (best-effort
         * deletes — never edits, receipts, notices or competing sends) so only
         * the core's messages remain.
         * Exception: when the consumer CAPTURED the committed assistant/message
         * (the flag was back on at that instant, so the bridge routed it here and
         * skipped its own forward), this feed owns the one delivery — withdrawing
         * would silently LOSE the answer. Ordinary settlement below delivers it
         * exactly once instead.
         */
        if (turn !== undefined && !turn.feed.canRender && !answers.has(chatId)) {
            const feed = turn.feed;
            turn.clearTimers();
            if (feed.editAttempts > 0) {
                const rate = Math.round((feed.editSucceeded / feed.editAttempts) * 100);
                console.error("[dsh-telegram] harness-edit stats", `attempted=${feed.editAttempts} succeeded=${feed.editSucceeded} hit=${rate}%`);
            }
            const activityId = feed.activityId;
            if (activityId !== undefined) {
                void safeWrap("harness-feed-withdraw", () => host.deleteMessage(chatId, activityId));
            }
            const answerId = feed.answerId;
            if (answerId !== undefined) {
                // The tail-window bubble promised "full answer lands when the turn
                // ends" — with delivery re-owned by the core, retracting the stale
                // partial beats leaving a lying marker behind.
                void safeWrap("harness-feed-withdraw", () => host.deleteMessage(chatId, answerId));
            }
            const activitySending = feed.activitySending;
            if (activitySending !== undefined) {
                // Late landing: watchSend only reclaims ACTIVITY placeholders when
                // the whole extension is disposed, so claim the delete explicitly.
                void safeWrap("harness-feed-withdraw", () => activitySending.then((landed) => (landed === undefined ? undefined : host.deleteMessage(chatId, landed))));
            }
            // An in-flight answer "…" send needs no extra handling: with the chats
            // entry gone and no settlement claim, watchSend's HF-2 B orphan rule
            // deletes it on landing.
            chats.delete(chatId);
            answers.delete(chatId);
            return;
        }
        if (turn === undefined && !liveFeedOn && !answers.has(chatId)) {
            // HF-3 A: the feed never saw this turn AND the core owns the channel —
            // no empty-response notice, no reminder, no delivery from here (the
            // spurious "🤷 Empty response" class). An answer captured through the
            // consumer while the flag was still on is the exception: nobody else
            // will deliver it, so settlement continues below.
            answers.delete(chatId);
            return;
        }
        const goal = host.goalForChat?.(chatId);
        const reason = event.data?.reason;
        // HF-3 B: failure detection across the DOCUMENTED turn/end reason union
        // (@deepseek-ai/dsh-session TurnEndReasonMap) — only `completed` reads as
        // success. aborted / blocked / error / max-tokens / interrupted, plus any
        // plugin-merged variant (the map is deliberately extensible), used to slip
        // past the old kind==="error"-AND-non-empty-message check and collapse the
        // card into the SUCCESS receipt. This mirrors the agent log's own
        // accountsForClaim default: an unnameable ending over consumed input must
        // not read as success. A missing reason is a malformed envelope, not
        // evidence of success — the legacy success shape is kept for it. Errored
        // turns still surface through the core bridge's classified failure message
        // (issue #37); every other failed kind gets no core message either, so the
        // prose-less early return below is what keeps them from fabricating an
        // outcome or falsely satisfying the inbound.
        const failed = reason !== undefined && reason.kind !== "completed";
        const answer = answers.get(chatId);
        let goalReceipt;
        let emptyNotice;
        let noticeOnPlaceholder = false;
        let streamedText = "";
        if (turn !== undefined) {
            const feed = turn.feed;
            // HF-3 C: the settle-time freeze may commit one last Think line, whose
            // fix now schedules a frame — freeze BEFORE clearTimers so that frame
            // dies with the turn instead of firing a stray post-settlement edit.
            turn.freezeThink();
            turn.clearTimers();
            streamedText = answerText(feed);
            if (feed.editAttempts > 0) {
                const rate = Math.round((feed.editSucceeded / feed.editAttempts) * 100);
                console.error("[dsh-telegram] harness-edit stats", `attempted=${feed.editAttempts} succeeded=${feed.editSucceeded} hit=${rate}%`);
            }
            const sessionStats = host.statusStats();
            const hasContent = feed.reasoningSteps > 0 || feed.toolCalls > 0 || streamedText.trim() !== "";
            // HF-3 B: an errored turn must never collapse its placeholder into the
            // SUCCESS receipt (#37) — with HF-2 counting streamed prose as content,
            // a partial-prose-then-crash turn used to render "⚙️ Completed" right next
            // to the core's classified ❌ message. Chosen behavior: SUPPRESS the
            // summary on failure (placeholder takes the delete path below, one
            // outcome voice per turn) instead of adding a failure-flavored receipt;
            // turn-receipt.ts is success-shaped and out of this fix's scope.
            const summary = hasContent && !failed
                ? renderTurnReceipt({
                    durationMs: Date.now() - feed.startedAt,
                    reasoningSteps: feed.reasoningSteps,
                    toolCalls: feed.toolCalls,
                    tokens: feed,
                    sessionStats,
                    ...(goal === undefined ? {} : { goalObjective: goal.objective }),
                })
                : undefined;
            if (goal !== undefined && !failed) {
                goalReceipt =
                    summary ??
                        `\u2705 ${escapeHtml(truncate(goal.objective, 60))} \u00B7 \u23F1\uFE0F ${Math.max(1, Math.round((Date.now() - feed.startedAt) / 1000))}s`;
            }
            if (!failed && answer === undefined && summary === undefined && goalReceipt === undefined) {
                // Issue #33: zero visible output must not vanish into silence — the
                // placeholder becomes the outcome notice instead of being deleted.
                emptyNotice = `\u{1F937} Empty response \u00B7 \u23F1\uFE0F ${Math.max(1, Math.round((Date.now() - feed.startedAt) / 1000))}s`;
                noticeOnPlaceholder = true;
            }
            const finalizeCard = (messageId) => {
                if (messageId === undefined)
                    return;
                if (noticeOnPlaceholder) {
                    void safeWrap("harness-empty-response", () => host
                        .editMessage(chatId, messageId, emptyNotice, { parse_mode: "HTML" })
                        .then((edited) => (edited === true ? undefined : host.send(chatId, emptyNotice, { parse_mode: "HTML" }))));
                }
                else if (summary !== undefined) {
                    void safeWrap("harness-finalize", () => host.editMessage(chatId, messageId, summary, { parse_mode: "HTML" }));
                }
                else {
                    void safeWrap("harness-cleanup", () => host.deleteMessage(chatId, messageId));
                }
            };
            if (feed.activityId !== undefined)
                finalizeCard(feed.activityId);
            else if (feed.activitySending !== undefined) {
                // The placeholder is still in flight: finalize it when it lands.
                void safeWrap("harness-finalize-pending", () => feed.activitySending.then(finalizeCard));
            }
            chats.delete(chatId);
        }
        else if (!failed && answer === undefined) {
            // No live draft existed (turn/start dropped): zero output by definition.
            emptyNotice = "\u{1F937} Empty response";
        }
        // Final prose delivery is this plugin's job while mounted: prefer the
        // committed assistant/message, fall back to the streamed text blocks.
        answers.delete(chatId);
        const finalText = answer !== undefined && answer.text.trim() !== "" ? answer.text : streamedText;
        /**
         * HF-2 B: resolve the answer bubble settlement should own. A still
         * in-flight "…" send must land first — claiming it here also marks it for
         * watchSend, so the late landing is settled in place instead of being
         * deleted as an orphan (or duplicated by an immediate fresh send).
         */
        const streamedAnswerId = () => {
            if (turn === undefined)
                return Promise.resolve(undefined);
            if (turn.feed.answerId !== undefined)
                return Promise.resolve(turn.feed.answerId);
            const pending = turn.feed.answerSending;
            if (pending === undefined)
                return Promise.resolve(undefined);
            claimedAnswerSends.add(pending);
            return pending.catch(() => undefined);
        };
        if (noticeOnPlaceholder) {
            // The placeholder edit IS this turn's outcome: it satisfies the
            // inbound, so the reminder must not stack on top of it.
            if (host.pendingInbound(chatId))
                host.markInboundReplied(chatId);
        }
        else if (host.pendingInbound(chatId)) {
            if (finalText.trim() === "" && failed) {
                // Failed turn with no prose: the core bridge's classified failure
                // message covers the chat; the inbound stays unanswered so the core
                // reminder machinery stays honest.
                return;
            }
            const agentId = host.agentIdForChat(chatId);
            const assistantMessageId = answer?.assistantMessageId;
            const inboundMessageId = host.inboundMessageId(chatId);
            const settle = (telegramMessageId) => {
                if (telegramMessageId === undefined)
                    throw new Error("transport returned no message id");
                if (agentId !== undefined && assistantMessageId !== undefined) {
                    host.attachFeedback(chatId, telegramMessageId, agentId, assistantMessageId);
                }
                host.markInboundReplied(chatId);
            };
            const failFinal = (err) => {
                console.error("[dsh-telegram] harness-final-answer FAILED", err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err));
                void safeWrap("harness-final-answer-degraded", () => host.send(chatId, "\u26A0\uFE0F The final answer could not be delivered \u2014 the turn stays unanswered; try again or check /history.", { parse_mode: "HTML" }));
            };
            const deliverFinal = async (streamedMessageId) => {
                // Local image references (![](path)) become real photos: the prose keeps
                // its meaning and the file stops being a dead path in the chat. Every
                // step is best-effort — on any failure the original text renders as-is.
                let renderText = finalText;
                let answerImages = [];
                try {
                    // Only strip the prose when this host can actually upload: a host
                    // without the seam must keep showing the reference (old behaviour)
                    // instead of losing it.
                    if (host.sendLocalFiles !== undefined) {
                        const extracted = await extractLocalImageRefs(finalText, { workspaceRoot: host.workspaceRoot() });
                        renderText = extracted.text;
                        answerImages = extracted.images;
                    }
                }
                catch {
                    answerImages = [];
                }
                const deliverImages = () => {
                    const sendLocalFiles = host.sendLocalFiles;
                    if (answerImages.length === 0 || sendLocalFiles === undefined)
                        return;
                    void safeWrap("harness-answer-images", async () => {
                        const outcome = await sendLocalFiles(chatId, answerImages);
                        if (outcome.failed.length > 0) {
                            console.error("[dsh-telegram] final-answer images failed", outcome.failed);
                        }
                    });
                };
                const settleWithImages = (telegramMessageId) => {
                    settle(telegramMessageId);
                    deliverImages();
                };
                // The answer was nothing but image refs: send the photos instead of a
                // reminder text, and count the inbound as answered. A host without the
                // upload seam keeps the old behaviour (the reference renders as text),
                // and a failed upload still says something rather than vanishing.
                const imagesOnly = renderText.trim() === "" && answerImages.length > 0 && emptyNotice === undefined;
                if (imagesOnly && host.sendLocalFiles !== undefined) {
                    const sendLocalFiles = host.sendLocalFiles;
                    void safeWrap("harness-answer-images-only", async () => {
                        const outcome = await sendLocalFiles(chatId, answerImages);
                        if (outcome.delivered === 0) {
                            console.error("[dsh-telegram] images-only answer delivered nothing", outcome.failed);
                            await host.send(chatId, markdownToHtml(finalText), { parse_mode: "HTML" });
                        }
                    });
                    if (host.pendingInbound(chatId))
                        host.markInboundReplied(chatId);
                    return;
                }
                const finalHtml = renderText.trim() !== "" ? markdownToHtml(renderText) : undefined;
                if (streamedMessageId !== undefined && finalHtml !== undefined) {
                    if (finalHtml.length <= maxMessageLength(host)) {
                        // Web semantics: the bubble that streamed settles into the
                        // committed answer in place — no duplicate final message.
                        void safeWrap("harness-answer-finalize", () => host.editMessage(chatId, streamedMessageId, finalHtml, { parse_mode: "HTML" }))
                            .then((edited) => {
                            if (edited !== true)
                                throw new Error("final edit failed");
                            return streamedMessageId;
                        })
                            .then(settleWithImages)
                            .catch(failFinal);
                        return;
                    }
                    // HF-2 A: an over-cap final can never edit (the transport refuses
                    // it without an API call — this used to kill the whole delivery).
                    // Retract the streamed bubble and deliver the COMPLETE text through
                    // the splitting send path: full content exactly once, feedback and
                    // the inbound mark ride the first part.
                    void safeWrap("harness-answer-oversize", async () => {
                        // Best-effort retract: transport.deleteMessage rethrows EVERY
                        // error, so a bubble the user already removed (or any delete
                        // hiccup) must not take the delivery down with it — the split
                        // send below is the actual answer carrier.
                        await safeWrap("harness-answer-retract", () => host.deleteMessage(chatId, streamedMessageId));
                        const telegramMessageId = await host.send(chatId, finalHtml, {
                            parse_mode: "HTML",
                            ...(inboundMessageId === undefined ? {} : { reply_parameters: { message_id: inboundMessageId } }),
                        });
                        // A transport that resolves without a message id is still a
                        // failed delivery (#13).
                        if (telegramMessageId === undefined)
                            throw new Error("transport returned no message id");
                        return telegramMessageId;
                    })
                        .then(settleWithImages)
                        .catch(failFinal);
                    return;
                }
                const text = finalHtml ?? (emptyNotice ?? NO_REPLY_REMINDER);
                void host
                    .send(chatId, text, {
                    parse_mode: "HTML",
                    ...(inboundMessageId === undefined ? {} : { reply_parameters: { message_id: inboundMessageId } }),
                })
                    .then((telegramMessageId) => {
                    // A transport that resolves without a message id is still a failed
                    // delivery (#13).
                    if (telegramMessageId === undefined)
                        throw new Error("transport returned no message id");
                    return telegramMessageId;
                })
                    .then(settleWithImages)
                    .catch(failFinal);
            };
            // HF-2 B: an in-flight "…" answer send must LAND before settlement
            // picks its path — deciding from feed.answerId alone raced the send,
            // re-ran the fresh-send branch AND stranded the late placeholder
            // (mirrors the activity card's deferred finalize above).
            // deliverFinal is async (image extraction awaits the filesystem): a throw
            // outside its own `.then` chains must be logged, never left as an
            // unhandled rejection that would take the whole bridge down.
            void streamedAnswerId()
                .then(deliverFinal)
                .catch((err) => {
                console.error("[dsh-telegram] harness-final-answer FAILED", err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err));
            });
        }
        else if (goal !== undefined && goalReceipt !== undefined && (host.getConfigPath?.("notify.onComplete") ?? true) !== false) {
            // Goal turns have no inbound answer; push a fresh receipt (issue #18).
            void safeWrap("harness-goal-completion", () => host.send(chatId, goalReceipt, { parse_mode: "HTML", disable_notification: false }));
        }
        else if (emptyNotice !== undefined) {
            void safeWrap("harness-empty-response-push", () => host.send(chatId, emptyNotice, { parse_mode: "HTML" }));
        }
    };
    /* ---------------- event wiring ---------------- */
    host.setAssistantConsumer((chatId, text, assistantMessageId) => {
        answers.set(chatId, { text, assistantMessageId });
    });
    // Core Abort seam (#48): every timer goes dormant; the real turn/end (if it
    // still arrives) finalizes as usual.
    host.stopLiveFeed = (chatId) => {
        const turn = chats.get(chatId);
        if (turn === undefined)
            return;
        turn.clearTimers();
        turn.feed.stopped = true;
    };
    /**
     * Session/event disposer (HF-2 C): cordis listeners registered with
     * ctx.on outlive this extension's service fiber — a hot re-apply (config
     * restart rebuilds the service and remounts) used to stack another copy of
     * this listener on every mount, rendering each turn twice. Captured here
     * and unsubscribed by teardownFeed.
     */
    let offSessionEvent;
    const teardownFeed = () => {
        // Stop the event stream FIRST so no in-flight event touches half-torn
        // state below.
        offSessionEvent?.();
        offSessionEvent = undefined;
        host.stopLiveFeed = undefined;
        host.setAssistantConsumer(undefined);
        disposed = true;
        activeHost = undefined;
        teardownActive = undefined;
        for (const turn of chats.values())
            turn.clearTimers();
        chats.clear();
        answers.clear();
    };
    teardownActive = teardownFeed;
    ctx.effect(() => () => {
        if (activeHost === host)
            unmountHarnessFeed();
    });
    // Official harness event stream — the same session/event feed the web UI
    // streams from. Filtered to the bridge-bound agent; slots target the bound
    // chat.
    offSessionEvent = ctx.on("session/event", (session, event) => {
        // Per-chat routing: resolve the owner chat from the session id instead of
        // trusting the most-recently-touched chat, so two chats stream at once.
        const chatId = host.chatIdForAgent(String(session.id));
        if (chatId === undefined)
            return;
        // `outbound.liveFeed=false` disables RENDERING dynamically; the core
        // falls back to immediate forwarding while this listener stays mounted,
        // so a later `/config set outbound.liveFeed true` needs no restart.
        // HF-3 A: the flag must NOT gate the event stream itself. Returning here
        // dropped turn/start (no entry to settle) and turn/end alike: toggling
        // off MID-turn stranded a zombie card (heartbeat edits up to
        // MAX_HEARTBEATS, answer bubble never settled), and off-at-start →
        // on-before-end fired a spurious "🤷 Empty response". Lifecycle handlers
        // run regardless; rendering gates on each turn's canRender snapshot.
        const type = event.type;
        if (type === "turn/start") {
            // Drop only this chat's stale turn; another chat's live card stays. A
            // previous card's throttled edit must not fire into the new turn.
            const previous = chats.get(chatId);
            previous?.clearTimers();
            // A restarted turn reuses the previous placeholder's message id (or its
            // still-in-flight send) and the failed-send latch instead of spawning
            // another "Working…" (#23).
            const turn = new Turn(chatId, {
                activityId: previous?.feed.activityId,
                activitySending: previous?.feed.activitySending,
                placeholderFailed: previous?.feed.placeholderFailed === true ? true : undefined,
            }, 
            // HF-3 A: one sticky snapshot per turn — mid-turn flips are handled
            // by the gates, never by re-reading the flag for a running turn.
            host.liveFeedEnabled());
            chats.set(chatId, turn);
            answers.delete(chatId);
            // HF-3 A: registration happened above even while disabled; only the
            // rendering side-effects stay with the live-feed path.
            if (!turn.feed.canRender)
                return;
            if (turn.feed.activityId === undefined && turn.feed.activitySending === undefined && turn.feed.placeholderFailed !== true) {
                // Visible feedback starts with the turn itself (#12): the header-only
                // placeholder later collapses into the receipt or outcome notice.
                const pending = host.send(chatId, turn.renderActivity(), { parse_mode: "HTML" });
                turn.feed.activitySending = pending;
                turn.watchSend("activity", pending);
            }
            else if (turn.feed.activityId !== undefined) {
                turn.feed.dirtyActivity = true;
                turn.activityFlush(true);
            }
            turn.armHeartbeat();
            return;
        }
        // Final delivery must never depend on the live draft: a turn whose
        // turn/start was dropped still has to deliver its buffered answer.
        if (type === "turn/end") {
            handleTurnEnd(chatId, event);
            return;
        }
        const turn = chats.get(chatId);
        if (turn === undefined)
            return;
        // HF-3 A: canRender is a turn-start snapshot, so a mid-turn on→off flip
        // is caught here at the next event boundary: suspend immediately (kill
        // pending throttle/retry/heartbeat timers) and stay suspended — the core
        // forwarder owns the rest of this turn, and a later flip-back must not
        // resurrect stale renders.
        if (turn.feed.canRender && !host.liveFeedEnabled()) {
            turn.clearTimers();
            turn.feed.canRender = false;
        }
        // Mid-turn events keep FOLDING while disabled (cheap state
        // keeping); their activity/answer schedules and bubble sends no-op
        // through the canRender gates inside Turn.
        if (type === "step/start") {
            turn.feed.step = event.data?.step ?? turn.feed.step;
            turn.activitySchedule();
            return;
        }
        if (type === "assistant/chunk") {
            const before = answerText(turn.feed);
            foldChunk(turn, event);
            const after = answerText(turn.feed);
            if (after !== before) {
                // Prose advanced: stream the answer message live (web behavior).
                if (turn.feed.answerId === undefined && turn.feed.answerSending === undefined && after.trim() !== "") {
                    turn.ensureAnswerMessage();
                }
                turn.answerSchedule();
            }
            if (turn.feed.liveThinkRaw !== "")
                turn.activitySchedule();
            return;
        }
        if (type === "tool/call") {
            handleToolCall(turn, event.data ?? {});
            return;
        }
        if (type === "tool/result") {
            handleToolResult(turn, event.data ?? {});
            return;
        }
    });
}
//# sourceMappingURL=harness-feed.js.map