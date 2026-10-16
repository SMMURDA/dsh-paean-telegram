import { SessionId } from "@deepseek-ai/dsh-session";
export function agentsOf(ctx) {
    // The real `ctx.agents` is an `AgentRegistry`; we only consume the stable
    // structural subset below so this adapter never hard-couples to that class.
    return (ctx.agents ?? undefined);
}
export function sessionTitleService(ctx) {
    return ctx.get("sessionTitle");
}
function persistenceOf(ctx) {
    return ctx.get("sessionPersistence");
}
/**
 * Read one session-like value's event log under either host shape.
 *
 * dsh exposes the log through `Session.snapshotEvents()`; earlier releases
 * exposed a plain `events` array. Reading `.events` alone returned the method
 * itself on the current host, so every fold threw `session.events is not
 * iterable` and the Sessions card failed to load. Both shapes are accepted so
 * one build serves old and new hosts.
 */
export function sessionEvents(session) {
    if (session === null || typeof session !== "object")
        return [];
    const holder = session;
    if (Array.isArray(holder.events))
        return holder.events;
    if (typeof holder.snapshotEvents === "function") {
        try {
            const materialized = holder.snapshotEvents.call(session);
            if (Array.isArray(materialized))
                return materialized;
        }
        catch {
            /* an unreadable log degrades to empty instead of failing the whole card */
        }
    }
    return [];
}
/** Whether a session-like value exposes any readable event log at all. */
export function hasEventLog(session) {
    if (session === null || typeof session !== "object")
        return false;
    const holder = session;
    return Array.isArray(holder.events) || typeof holder.snapshotEvents === "function";
}
/** Event timestamp: `time` on current dsh, `at` on the legacy array shape. */
export function eventTime(event) {
    if (event === undefined || event === null)
        return undefined;
    const holder = event;
    const raw = holder.time ?? holder.at;
    return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}
/**
 * Normalize `persistence.list()` rows. Current dsh returns
 * `{ header: { id, cwd }, revision }` snapshots; legacy seams returned
 * `{ id, cwd }` headers. Rows without a usable id are dropped so a malformed
 * entry cannot collapse the whole roster under one "undefined" key.
 */
function persistedRows(rows) {
    const out = [];
    for (const entry of rows) {
        if (entry === null || typeof entry !== "object")
            continue;
        const value = entry;
        const header = value.header ?? value;
        const id = header.id;
        if (typeof id !== "string" && typeof id !== "number")
            continue;
        const revision = value.revision ?? value.mtimeMs ?? value.mtime;
        out.push({
            id: SessionId(String(id)),
            cwd: typeof header.cwd === "string" ? header.cwd : undefined,
            key: typeof revision === "string" || typeof revision === "number" ? String(revision) : undefined,
        });
    }
    return out;
}
/**
 * Whole stored log for one cold session. Current dsh reads it through
 * `open(id, 'read')` → `handle.read()` (no arguments = the rest of the log);
 * the legacy seam served JSONL `content` or parsed `events` from `readRaw`.
 * Returns `undefined` when neither seam can serve this session.
 */
async function readPersistedEvents(persistence, id) {
    if (typeof persistence.open === "function") {
        const handle = await persistence.open(id, "read");
        try {
            const slice = await handle.read();
            return Array.isArray(slice?.events) ? slice.events : [];
        }
        finally {
            try {
                await handle.close();
            }
            catch {
                /* a release failure must not hide a log that was already read */
            }
        }
    }
    if (typeof persistence.readRaw === "function") {
        const raw = await persistence.readRaw(id);
        if (raw === undefined)
            return undefined;
        return raw.events ?? (typeof raw.content === "string" ? parseRawEvents(raw.content) : []);
    }
    return undefined;
}
export function sessionsOf(ctx) {
    return ctx.get("sessions");
}
function liveSessions(ctx) {
    const map = new Map();
    const store = sessionsOf(ctx);
    if (!store)
        return map;
    for (const session of store.list())
        map.set(session.id, session);
    return map;
}
export function sessionById(ctx, id) {
    const session = sessionsOf(ctx)?.get(SessionId(id));
    return session;
}
function titleFor(ctx, session) {
    const titles = sessionTitleService(ctx);
    try {
        const snapshot = titles?.get(session);
        if (snapshot?.title)
            return snapshot.title;
    }
    catch {
        /* title service may not own this session */
    }
    // Durable titles are `session/title` events (latest wins), same as the
    // web's foldSessionTitle projection. This is how cold sessions keep names.
    // No first-message fallback: the caller falls back to the cwd basename so
    // Telegram shows exactly the web display-title chain.
    const events = sessionEvents(session);
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type !== "session/title")
            continue;
        const title = event.data?.title;
        if (typeof title === "string" && title.trim() !== "")
            return title.trim();
    }
    return undefined;
}
/** Parse the JSONL text of a cold log back into structural events. */
function parseRawEvents(content) {
    const events = [];
    for (const line of content.split("\n")) {
        if (line.trim() === "")
            continue;
        try {
            const value = JSON.parse(line);
            if (typeof value.type !== "string" || typeof value.seq !== "number")
                continue;
            events.push({
                seq: value.seq,
                type: value.type,
                ...(typeof value.time === "number" ? { time: value.time } : {}),
                ...(typeof value.at === "number" ? { at: value.at } : {}),
                ...(typeof value.data === "object" && value.data !== null ? { data: value.data } : {}),
            });
        }
        catch {
            /* a torn tail line must not hide the titles that precede it */
        }
    }
    return events;
}
/**
 * Events for one session: the live log while resident in memory, else the
 * persisted log (read through an opened read handle on current dsh, or the
 * legacy `readRaw` seam). Returns `undefined` when no source can serve this
 * session.
 */
async function loadSessionEvents(ctx, sessionId) {
    const session = sessionById(ctx, sessionId);
    if (session)
        return sessionEvents(session);
    const persistence = persistenceOf(ctx);
    if (!persistence)
        return undefined;
    return readPersistedEvents(persistence, SessionId(sessionId)).catch(() => undefined);
}
function scanMeta(events) {
    let blank = true;
    let lastPromptAt;
    for (const event of events) {
        if (event.type === "turn/start")
            blank = false;
        if (event.type === "user/message") {
            blank = false;
            // Contract is a number, but host seams have delivered strings — a blind
            // cast leaked NaN into relTime/<tg-time> downstream (DTL audit). Keep
            // lastPromptAt a true number or undefined.
            const at = (eventTime(event) ?? event.data?.createdAt);
            if (typeof at === "number" && Number.isFinite(at))
                lastPromptAt = at;
        }
    }
    return { blank, lastPromptAt, eventCount: events.length };
}
/**
 * Per-ctx cache over parsed cold logs (review 🔵-3): every Sessions-card open
 * AND every panel refresh used to pay N sequential reads + full parses for the
 * whole persisted roster. Cache validity per id is keyed by the row's change
 * token — dsh's opaque `revision`, or a legacy mtime — and falls back to id
 * alone, in which case correctness rides on the roster signature above: any
 * list change drops the whole cache. That is safe because cold logs are
 * append-only with no live writer: a session only stops being live through
 * agent disposal, and while it IS live its detail comes from the in-memory
 * branch (never cached).
 */
const coldDetailCaches = new WeakMap();
/** Assemble the cold {@link SessionDetail} from a (possibly cached) core. */
function coldDetail(id, cwd, core, archived) {
    return {
        id,
        cwd,
        live: false,
        running: false,
        title: core.title,
        blank: core.blank,
        lastPromptAt: core.lastPromptAt,
        eventCount: core.eventCount,
        archived: archived.has(id),
    };
}
/** Max cold-log reads in flight during one roster build (review 🔵-3). */
const COLD_READ_CONCURRENCY = 4;
/** session.list: live + persisted sessions with web-style summary metadata. */
export async function listSessionDetails(ctx) {
    const live = liveSessions(ctx);
    const archived = new Set(archivedSessionIds(ctx));
    const entries = new Map();
    for (const [id, session] of live) {
        const meta = scanMeta(sessionEvents(session));
        entries.set(id, {
            id,
            cwd: session.header?.cwd,
            live: true,
            running: agentsOf(ctx)?.get(SessionId(id))?.status === "running",
            title: titleFor(ctx, session),
            blank: meta.blank,
            lastPromptAt: meta.lastPromptAt,
            eventCount: meta.eventCount,
            archived: archived.has(id),
        });
    }
    const persistence = persistenceOf(ctx);
    if (persistence) {
        try {
            const rows = persistedRows(await persistence.list());
            // Cache scope: per ctx, invalidated wholesale whenever the persisted
            // roster changes (see ColdDetailCache).
            const signature = rows.map((row) => String(row.id)).join("\n");
            const previous = coldDetailCaches.get(ctx);
            const cache = previous !== undefined && previous.signature === signature
                ? previous
                : { signature, byId: new Map() };
            coldDetailCaches.set(ctx, cache);
            // A session that is live NOW must not keep a cold-cache entry: its log
            // may have grown while resident (resume → work → dispose), and once it
            // goes cold again the next build must re-read instead of serving the
            // pre-live snapshot. Per-id drop only — never fold live ids into the
            // roster signature, or a permanently-live session would keep the whole
            // cache evicted.
            for (const id of live.keys())
                cache.byId.delete(id);
            const pending = [];
            for (const row of rows) {
                const id = String(row.id);
                if (entries.has(id))
                    continue;
                const cached = cache.byId.get(id);
                if (cached !== undefined && cached.key === row.key) {
                    entries.set(id, coldDetail(id, row.cwd, cached.core, archived));
                    continue;
                }
                pending.push(row);
            }
            let cursor = 0;
            const loadCold = async (row) => {
                const id = String(row.id);
                try {
                    let events;
                    try {
                        events = await readPersistedEvents(persistence, row.id);
                    }
                    catch {
                        /* a broken cold log must not hide the rest of the roster */
                    }
                    if (events === undefined)
                        return;
                    const session = { id: row.id, events };
                    const meta = scanMeta(events);
                    const core = {
                        title: titleFor(ctx, session),
                        blank: meta.blank,
                        lastPromptAt: meta.lastPromptAt,
                        eventCount: meta.eventCount,
                    };
                    cache.byId.set(id, { key: row.key, core });
                    entries.set(id, coldDetail(id, row.cwd, core, archived));
                }
                catch {
                    /* defensive: one broken entry must not fail the whole roster */
                }
            };
            // Bounded-concurrency cold reads instead of N sequential read+parse
            // passes. Completion order cannot affect output: the sort below is a
            // total order (unique ids), so the roster comes out byte-identical.
            await Promise.all(Array.from({ length: Math.min(COLD_READ_CONCURRENCY, pending.length) }, async () => {
                while (cursor < pending.length) {
                    const header = pending[cursor];
                    cursor += 1;
                    await loadCold(header);
                }
            }));
        }
        catch {
            /* persistence listing failure degrades to the live roster */
        }
    }
    // Web session.list order: most recently prompted first (`updatedAt desc`),
    // with never-prompted sessions at the bottom in stable id order.
    return [...entries.values()].sort((a, b) => (b.lastPromptAt ?? -Infinity) - (a.lastPromptAt ?? -Infinity) || a.id.localeCompare(b.id));
}
function archivedSessionIds(ctx) {
    const registry = ctx.get("workspaceRegistry");
    return [...(registry?.archivedSessionIds ?? [])].map(String);
}
export function textOfContent(content) {
    if (!Array.isArray(content))
        return "";
    return content
        .filter((block) => typeof block === "object" && block !== null && block.type === "text")
        .map((block) => block.text ?? "")
        .join(" ")
        .trim();
}
// SR-1: the two message envelopes differ. Canonical `user/message` data IS
// the UserMessage itself (flat `content`), but canonical `assistant/message`
// data wraps the message — `{ turn, step, message: AssistantMessage, usage? }`
// (@deepseek-ai/dsh-session SessionEventMap) — so reading `data.content` there
// made assistant prose invisible to /search and blank in /history. The flat
// read below survives ONLY as a documented legacy fallback for pre-canonical
// log shapes.
function assistantTextOf(event) {
    const data = event.data;
    return textOfContent(data?.message?.content) || textOfContent(data?.content);
}
/**
 * SR-1: canonical `tool/result` payloads carry no `output` field — the text
 * rides the ToolResultMessage chain `data.message.content[n].content` (the
 * `[ToolResultBlock]` tuple whose ContentBlock entries hold the model-facing
 * text; @deepseek-ai/dsh-session SessionEventMap + @deepseek-ai/dsh-llm
 * types.d.ts). Defensive over writer shapes: the block list may arrive as an
 * array or a lone block, and inner content as blocks or plain text. Flat
 * `data.output` remains only as a documented legacy fallback.
 */
function toolResultTextOf(event) {
    const data = event.data;
    const raw = data?.message?.content;
    const blocks = Array.isArray(raw) ? raw : raw !== undefined && raw !== null ? [raw] : [];
    const parts = [];
    for (const block of blocks) {
        const inner = block?.content;
        if (Array.isArray(inner))
            parts.push(textOfContent(inner));
        else if (typeof inner === "string" && inner.trim() !== "")
            parts.push(inner);
    }
    const text = parts.join(" ").trim();
    return text !== "" ? text : String(data?.output ?? "").trim();
}
function snippetOf(event) {
    if (event.type === "user/message" || event.type === "assistant/message") {
        // SR-1: user data IS the UserMessage (flat content); assistant prose is
        // wrapped under data.message (see assistantTextOf).
        const text = event.type === "user/message"
            ? textOfContent(event.data?.content)
            : assistantTextOf(event);
        if (text)
            return text;
    }
    if (event.type === "tool/call") {
        const data = event.data;
        const name = typeof data?.name === "string" && data.name !== "" ? data.name : "tool";
        const raw = data?.arguments ?? data?.args;
        let detail = "";
        if (typeof raw === "string" && raw.trim() !== "")
            detail = ` ${raw.trim()}`;
        else if (raw !== undefined)
            detail = ` ${JSON.stringify(raw)}`;
        return `\u{1F6E0}\uFE0F ${name}${detail}`;
    }
    if (event.type === "tool/result") {
        const text = toolResultTextOf(event);
        if (text.trim())
            return text.trim();
    }
    return undefined;
}
/** session.search: scan live logs + persisted logs, web-style snippet cap 240. */
export async function searchSessions(ctx, query, limit = 20) {
    const needle = query.toLowerCase();
    if (!needle)
        return [];
    const hits = [];
    const pushHits = (id, events, live) => {
        for (let i = events.length - 1; i >= 0; i -= 1) {
            const snippet = snippetOf(events[i]);
            if (!snippet || !snippet.toLowerCase().includes(needle))
                continue;
            hits.push({ sessionId: id, seq: events[i].seq, type: events[i].type, snippet: snippet.slice(0, 240), live });
            if (hits.length >= limit)
                return;
        }
    };
    const live = liveSessions(ctx); // one roster snapshot for both scan phases (was computed twice)
    for (const [id, session] of live) {
        if (hits.length >= limit)
            break; // stop scanning once full — the check used to sit OUTSIDE the live loop
        pushHits(id, sessionEvents(session), true);
    }
    if (hits.length >= limit)
        return hits;
    const persistence = persistenceOf(ctx);
    if (persistence) {
        try {
            for (const row of persistedRows(await persistence.list())) {
                if (hits.length >= limit)
                    break; // hoisted BEFORE the read so a full hit list skips the next log entirely
                const id = String(row.id);
                if (live.has(id))
                    continue;
                try {
                    const events = await loadSessionEvents(ctx, id);
                    if (events !== undefined)
                        pushHits(id, events, false);
                }
                catch {
                    /* skip unreadable logs */
                }
            }
        }
        catch {
            /* degrade to live hits */
        }
    }
    return hits;
}
/** session.history: read a flat window of events (legacy; prefer readTrajectory). */
export async function readHistory(ctx, sessionId, limit = 20, beforeSeq) {
    const events = (await loadSessionEvents(ctx, sessionId)) ?? [];
    const end = beforeSeq === undefined ? events.length : events.findIndex((e) => e.seq >= beforeSeq);
    const start = Math.max(0, (end === -1 ? events.length : end) - limit);
    const out = [];
    for (const event of events.slice(start, end === -1 ? undefined : end)) {
        const text = snippetOf(event) ?? "";
        let role = event.type;
        if (event.type === "user/message")
            role = "user";
        else if (event.type === "assistant/message")
            role = "assistant";
        else if (event.type === "tool/call")
            role = "tool-call";
        else if (event.type === "tool/result")
            role = "tool-result";
        out.push({ seq: event.seq, type: event.type, role, text: text.slice(0, 400) });
    }
    return out;
}
/** session.trajectory: turn-grouped structured view (issue #32). */
export async function readTrajectory(ctx, sessionId, maxTurns = 6, beforeSeq) {
    const events = (await loadSessionEvents(ctx, sessionId)) ?? [];
    if (events.length === 0)
        return { turns: [], hasMore: false };
    // Build turns: one turn spans turn/start .. turn/end. Events before the
    // first turn/start form a headless "prelude" turn.
    const rawTurns = [];
    let openStart;
    for (let i = 0; i < events.length; i += 1) {
        if (events[i].type === "turn/start") {
            if (openStart !== undefined)
                rawTurns.push({ start: openStart, end: i, startSeq: events[openStart].seq, endSeq: undefined, headless: false });
            openStart = i;
        }
        else if (events[i].type === "turn/end") {
            if (openStart !== undefined) {
                rawTurns.push({ start: openStart, end: i + 1, startSeq: events[openStart].seq, endSeq: events[i].seq, headless: false });
                openStart = undefined;
            }
        }
    }
    if (openStart !== undefined)
        rawTurns.push({ start: openStart, end: events.length, startSeq: events[openStart].seq, endSeq: undefined, headless: false });
    // Prelude: events before the first turn/start or turn/end.
    const firstAnchor = rawTurns.length > 0 ? rawTurns[0].start : events.length;
    if (firstAnchor > 0) {
        rawTurns.unshift({ start: 0, end: firstAnchor, startSeq: events[0].seq, endSeq: undefined, headless: true });
    }
    // Paging: take the last `maxTurns` turns whose startSeq < beforeSeq.
    if (beforeSeq !== undefined) {
        const cutoff = rawTurns.findIndex((t) => t.startSeq >= beforeSeq);
        if (cutoff !== -1)
            rawTurns.splice(cutoff);
    }
    const hasMore = rawTurns.length > maxTurns;
    const page = hasMore ? rawTurns.slice(rawTurns.length - maxTurns) : rawTurns;
    const nextBefore = page.length > 0 ? page[0].startSeq : undefined;
    // Build TrajectoryTurn objects. Turn numbers count real turns only (the
    // headless prelude is not Turn 1) and stay stable across paged windows.
    const turns = [];
    const offset = rawTurns.length - page.length;
    const headlessBefore = offset > 0 && rawTurns[0]?.headless === true ? 1 : 0;
    let turnIndex = offset - headlessBefore;
    for (const raw of page) {
        if (!raw.headless)
            turnIndex += 1;
        const steps = [];
        let model;
        let changes;
        let outcome;
        let seconds;
        const startAt = eventTime(events[raw.start]);
        // rawTurns records the closing turn/end index whenever endSeq is set
        // (`end: i + 1` beside `endSeq: events[i].seq`), so the end timestamp
        // reads by index — the old events.find() was an O(n) seq scan per turn
        // (review 🔵-5). The find() fallback only fires if that invariant above
        // ever changes, keeping the old behavior as a safety net.
        let endAt;
        if (raw.endSeq !== undefined) {
            const closed = events[raw.end - 1];
            endAt = closed !== undefined && closed.seq === raw.endSeq ? eventTime(closed) : eventTime(events.find((e) => e.seq === raw.endSeq));
        }
        if (startAt !== undefined && endAt !== undefined)
            seconds = Math.round((endAt - startAt) / 1000);
        for (let i = raw.start; i < raw.end; i += 1) {
            const event = events[i];
            if (event.type === "request/header") {
                const header = event.data?.header;
                model = header?.config?.provider !== undefined && header.config.model !== undefined
                    ? `${header.config.provider}/${header.config.model}`
                    : undefined;
                changes = event.data?.reason ?? changes;
            }
            else if (event.type === "turn/end") {
                const reason = event.data?.reason;
                if (reason?.kind === "error") {
                    outcome = `error: ${reason.error?.message?.slice(0, 50) ?? "unknown"}`;
                }
                else {
                    outcome = reason?.kind ?? "completed";
                }
            }
            else if (event.type === "user/message") {
                const text = textOfContent(event.data?.content);
                if (text)
                    steps.push({ seq: event.seq, kind: "user", text: text.slice(0, 200) });
            }
            else if (event.type === "assistant/message") {
                const content = event.data?.message?.content;
                if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block.type === "reasoning" && block.text) {
                            steps.push({ seq: event.seq, kind: "reasoning", text: block.text.slice(0, 200) });
                        }
                        else if (block.type === "text" && block.text) {
                            steps.push({ seq: event.seq, kind: "assistant", text: block.text.slice(0, 200) });
                        }
                    }
                }
            }
            else if (event.type === "tool/call") {
                const data = event.data;
                const name = typeof data?.name === "string" && data.name !== "" ? data.name : "tool";
                const raw = data?.arguments ?? data?.args;
                let detail = "";
                if (typeof raw === "string" && raw.trim() !== "")
                    detail = ` ${raw.trim().slice(0, 80)}`;
                else if (raw !== undefined)
                    detail = ` ${JSON.stringify(raw).slice(0, 80)}`;
                steps.push({ seq: event.seq, kind: "tool-call", text: `${name}${detail}` });
            }
            else if (event.type === "tool/result") {
                // SR-1: same envelope rule as snippetOf — the text lives on the
                // ToolResultMessage chain, not a flat `output` field.
                const text = toolResultTextOf(event);
                if (text.trim())
                    steps.push({ seq: event.seq, kind: "tool-result", text: text.trim().slice(0, 120) });
            }
        }
        if (raw.headless) {
            turns.push({ startSeq: raw.startSeq, endSeq: raw.endSeq, index: 0, steps });
        }
        else {
            turns.push({ startSeq: raw.startSeq, endSeq: raw.endSeq, index: turnIndex, seconds, outcome, model, changes, steps });
        }
    }
    return { turns, hasMore, nextBefore };
}
//# sourceMappingURL=session-read.js.map