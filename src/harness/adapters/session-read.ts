/**
 * Read-only session queries: list (live + persisted roster), search, flat
 * history windows, and turn-grouped trajectory views — mirroring the web
 * ApiProxy `sessions` domain over the host seams (`ctx.sessions`,
 * `ctx.sessionTitle`, `ctx.sessionPersistence`).
 *
 * This module is also the dependency root of the sessions family: the
 * structural event/session shapes and the `ctx` seam accessors shared with
 * session-lifecycle.ts live here and are exported within the family only
 * (the public barrel in sessions.ts re-exports just the query API).
 */
import type { Context } from "@deepseek-ai/cordis";
import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionDetail } from "./session-render.js";

/** One event as read from a live or persisted session log (structural). */
export interface SessionEventLike {
  seq: number;
  type: string;
  /** Event timestamp on current dsh (`SessionEvent.time`). */
  time?: number;
  /** Legacy timestamp field: seams written before the `time` rename. */
  at?: number;
  data?: Record<string, unknown>;
}

export interface SessionLike {
  id: SessionId;
  /** Legacy shape: releases before dsh 0.2 exposed the log as an array. */
  events?: readonly SessionEventLike[];
  /** Current dsh `Session`: the log is materialized through this method. */
  snapshotEvents?: () => readonly SessionEventLike[];
  header?: { cwd?: string };
}

export interface SessionTitleServiceLike {
  get(session: SessionLike): { title: string; eventSeq: number } | undefined;
  rename(session: SessionLike, title: string): { title: string; eventSeq: number };
}

export interface AgentLike {
  id: SessionId;
  session: SessionLike;
  options?: { provider?: string; model?: string };
  status?: string;
}

/**
 * One persisted-roster row, normalized across persistence shapes. Current dsh
 * `sessionPersistence.list()` returns snapshots (`{ header, revision, … }`);
 * legacy seams returned `{ id, cwd }` headers directly.
 */
interface PersistedRow {
  id: SessionId;
  cwd?: string;
  /** Cache token for this row: dsh's opaque revision, else a legacy mtime. */
  key: string | undefined;
}

/** Read handle as exposed by current dsh `sessionPersistence.open()`. */
interface PersistenceReadHandleLike {
  read(offset?: number, length?: number): Promise<{ events?: readonly SessionEventLike[] }>;
  close(): Promise<void>;
}

interface PersistenceLike {
  /** Snapshot rows (current dsh) or flat `{ id, cwd }` headers (legacy seam). */
  list(signal?: AbortSignal): Promise<readonly unknown[]>;
  /** Current dsh: read a stored log through an opened read handle. */
  open?(id: SessionId, access: "read", signal?: AbortSignal): Promise<PersistenceReadHandleLike>;
  /** Legacy seam: `readRaw` returned `{ content }` JSONL text or parsed `events`. */
  readRaw?(id: SessionId, signal?: AbortSignal): Promise<{ content?: string; events?: readonly SessionEventLike[] } | undefined>;
}

export function agentsOf(ctx: Context) {
  // The real `ctx.agents` is an `AgentRegistry`; we only consume the stable
  // structural subset below so this adapter never hard-couples to that class.
  return (ctx.agents ?? undefined) as unknown as
    | {
        list(): AgentLike[];
        get(id: SessionId): AgentLike | undefined;
        create(options: {
          sessionId: SessionId;
          meta?: { cwd?: string; agentPreset?: string };
          agentOptions?: { provider?: string; model?: string };
          setup?: (agentCtx: Context) => Promise<void>;
        }): Promise<AgentHandle>;
        resume(options: { resumeSessionId: SessionId; agentOptions?: { provider?: string; model?: string } }): Promise<AgentHandle>;
      }
    | undefined;
}

export function sessionTitleService(ctx: Context): SessionTitleServiceLike | undefined {
  return ctx.get("sessionTitle") as SessionTitleServiceLike | undefined;
}

function persistenceOf(ctx: Context): PersistenceLike | undefined {
  return ctx.get("sessionPersistence") as PersistenceLike | undefined;
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
export function sessionEvents(session: unknown): readonly SessionEventLike[] {
  if (session === null || typeof session !== "object") return [];
  const holder = session as { events?: unknown; snapshotEvents?: unknown };
  if (Array.isArray(holder.events)) return holder.events as readonly SessionEventLike[];
  if (typeof holder.snapshotEvents === "function") {
    try {
      const materialized = (holder.snapshotEvents as () => unknown).call(session);
      if (Array.isArray(materialized)) return materialized as readonly SessionEventLike[];
    } catch {
      /* an unreadable log degrades to empty instead of failing the whole card */
    }
  }
  return [];
}

/** Whether a session-like value exposes any readable event log at all. */
export function hasEventLog(session: unknown): boolean {
  if (session === null || typeof session !== "object") return false;
  const holder = session as { events?: unknown; snapshotEvents?: unknown };
  return Array.isArray(holder.events) || typeof holder.snapshotEvents === "function";
}

/** Event timestamp: `time` on current dsh, `at` on the legacy array shape. */
export function eventTime(event: SessionEventLike | undefined): number | undefined {
  if (event === undefined || event === null) return undefined;
  const holder = event as { time?: unknown; at?: unknown };
  const raw = holder.time ?? holder.at;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/**
 * Normalize `persistence.list()` rows. Current dsh returns
 * `{ header: { id, cwd }, revision }` snapshots; legacy seams returned
 * `{ id, cwd }` headers. Rows without a usable id are dropped so a malformed
 * entry cannot collapse the whole roster under one "undefined" key.
 */
function persistedRows(rows: readonly unknown[]): PersistedRow[] {
  const out: PersistedRow[] = [];
  for (const entry of rows) {
    if (entry === null || typeof entry !== "object") continue;
    const value = entry as {
      id?: unknown;
      cwd?: unknown;
      header?: { id?: unknown; cwd?: unknown };
      revision?: unknown;
      mtimeMs?: unknown;
      mtime?: unknown;
    };
    const header = value.header ?? value;
    const id = header.id;
    if (typeof id !== "string" && typeof id !== "number") continue;
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
async function readPersistedEvents(persistence: PersistenceLike, id: SessionId): Promise<readonly SessionEventLike[] | undefined> {
  if (typeof persistence.open === "function") {
    const handle = await persistence.open(id, "read");
    try {
      const slice = await handle.read();
      return Array.isArray(slice?.events) ? slice.events : [];
    } finally {
      try {
        await handle.close();
      } catch {
        /* a release failure must not hide a log that was already read */
      }
    }
  }
  if (typeof persistence.readRaw === "function") {
    const raw = await persistence.readRaw(id);
    if (raw === undefined) return undefined;
    return raw.events ?? (typeof raw.content === "string" ? parseRawEvents(raw.content) : []);
  }
  return undefined;
}

export function sessionsOf(ctx: Context) {
  return ctx.get("sessions") as
    | {
        list(): SessionLike[];
        get(id: SessionId): SessionLike | undefined;
        fork(id: SessionId, boundary: number | undefined, childId: SessionId): SessionLike;
      }
    | undefined;
}

function liveSessions(ctx: Context): Map<string, SessionLike> {
  const map = new Map<string, SessionLike>();
  const store = sessionsOf(ctx);
  if (!store) return map;
  for (const session of store.list()) map.set(session.id, session as unknown as SessionLike);
  return map;
}

export function sessionById(ctx: Context, id: string): SessionLike | undefined {
  const session = sessionsOf(ctx)?.get(SessionId(id));
  return session as unknown as SessionLike | undefined;
}

function titleFor(ctx: Context, session: SessionLike): string | undefined {
  const titles = sessionTitleService(ctx);
  try {
    const snapshot = titles?.get(session);
    if (snapshot?.title) return snapshot.title;
  } catch {
    /* title service may not own this session */
  }
  // Durable titles are `session/title` events (latest wins), same as the
  // web's foldSessionTitle projection. This is how cold sessions keep names.
  // No first-message fallback: the caller falls back to the cwd basename so
  // Telegram shows exactly the web display-title chain.
  const events = sessionEvents(session);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "session/title") continue;
    const title = (event.data as { title?: unknown } | undefined)?.title;
    if (typeof title === "string" && title.trim() !== "") return title.trim();
  }
  return undefined;
}

/** Parse the JSONL text of a cold log back into structural events. */
function parseRawEvents(content: string): SessionEventLike[] {
  const events: SessionEventLike[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line) as {
        seq?: unknown;
        type?: unknown;
        at?: unknown;
        time?: unknown;
        data?: unknown;
      };
      if (typeof value.type !== "string" || typeof value.seq !== "number") continue;
      events.push({
        seq: value.seq,
        type: value.type,
        ...(typeof value.time === "number" ? { time: value.time } : {}),
        ...(typeof value.at === "number" ? { at: value.at } : {}),
        ...(typeof value.data === "object" && value.data !== null ? { data: value.data as Record<string, unknown> } : {}),
      });
    } catch {
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
async function loadSessionEvents(ctx: Context, sessionId: string): Promise<readonly SessionEventLike[] | undefined> {
  const session = sessionById(ctx, sessionId);
  if (session) return sessionEvents(session);
  const persistence = persistenceOf(ctx);
  if (!persistence) return undefined;
  return readPersistedEvents(persistence, SessionId(sessionId)).catch(() => undefined);
}

function scanMeta(events: readonly SessionEventLike[]): { blank: boolean; lastPromptAt?: number; eventCount: number } {
  let blank = true;
  let lastPromptAt: number | undefined;
  for (const event of events) {
    if (event.type === "turn/start") blank = false;
    if (event.type === "user/message") {
      blank = false;
      // Contract is a number, but host seams have delivered strings — a blind
      // cast leaked NaN into relTime/<tg-time> downstream (DTL audit). Keep
      // lastPromptAt a true number or undefined.
      const at = (eventTime(event) ?? event.data?.createdAt) as unknown;
      if (typeof at === "number" && Number.isFinite(at)) lastPromptAt = at;
    }
  }
  return { blank, lastPromptAt, eventCount: events.length };
}

/** Expensive derivations of one cold log (parsed events → summary metadata +
 * durable title). Only these are cached per session id between panel
 * refreshes; everything assembled around them (cwd from the fresh header,
 * archived flag from the registry, live/running constants) is recomputed so
 * registry changes still show up immediately. */
interface ColdDetailCore {
  title?: string;
  blank: boolean;
  lastPromptAt?: number;
  eventCount: number;
}

interface ColdDetailCache {
  /** Roster signature the entries were filled under: any list change drops
   * the whole cache (the documented invalidation rule). */
  signature: string;
  byId: Map<string, { key: string | undefined; core: ColdDetailCore }>;
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
const coldDetailCaches = new WeakMap<object, ColdDetailCache>();

/** Assemble the cold {@link SessionDetail} from a (possibly cached) core. */
function coldDetail(id: string, cwd: string | undefined, core: ColdDetailCore, archived: ReadonlySet<string>): SessionDetail {
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
export async function listSessionDetails(ctx: Context): Promise<SessionDetail[]> {
  const live = liveSessions(ctx);
  const archived = new Set(archivedSessionIds(ctx));
  const entries = new Map<string, SessionDetail>();
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
        : { signature, byId: new Map<string, { key: string | undefined; core: ColdDetailCore }>() };
      coldDetailCaches.set(ctx, cache);
      // A session that is live NOW must not keep a cold-cache entry: its log
      // may have grown while resident (resume → work → dispose), and once it
      // goes cold again the next build must re-read instead of serving the
      // pre-live snapshot. Per-id drop only — never fold live ids into the
      // roster signature, or a permanently-live session would keep the whole
      // cache evicted.
      for (const id of live.keys()) cache.byId.delete(id);
      const pending: PersistedRow[] = [];
      for (const row of rows) {
        const id = String(row.id);
        if (entries.has(id)) continue;
        const cached = cache.byId.get(id);
        if (cached !== undefined && cached.key === row.key) {
          entries.set(id, coldDetail(id, row.cwd, cached.core, archived));
          continue;
        }
        pending.push(row);
      }
      let cursor = 0;
      const loadCold = async (row: PersistedRow): Promise<void> => {
        const id = String(row.id);
        try {
          let events: readonly SessionEventLike[] | undefined;
          try {
            events = await readPersistedEvents(persistence, row.id);
          } catch {
            /* a broken cold log must not hide the rest of the roster */
          }
          if (events === undefined) return;
          const session: SessionLike = { id: row.id, events };
          const meta = scanMeta(events);
          const core: ColdDetailCore = {
            title: titleFor(ctx, session),
            blank: meta.blank,
            lastPromptAt: meta.lastPromptAt,
            eventCount: meta.eventCount,
          };
          cache.byId.set(id, { key: row.key, core });
          entries.set(id, coldDetail(id, row.cwd, core, archived));
        } catch {
          /* defensive: one broken entry must not fail the whole roster */
        }
      };
      // Bounded-concurrency cold reads instead of N sequential read+parse
      // passes. Completion order cannot affect output: the sort below is a
      // total order (unique ids), so the roster comes out byte-identical.
      await Promise.all(Array.from({ length: Math.min(COLD_READ_CONCURRENCY, pending.length) }, async () => {
        while (cursor < pending.length) {
          const header = pending[cursor]!;
          cursor += 1;
          await loadCold(header);
        }
      }));
    } catch {
      /* persistence listing failure degrades to the live roster */
    }
  }
  // Web session.list order: most recently prompted first (`updatedAt desc`),
  // with never-prompted sessions at the bottom in stable id order.
  return [...entries.values()].sort((a, b) => (b.lastPromptAt ?? -Infinity) - (a.lastPromptAt ?? -Infinity) || a.id.localeCompare(b.id));
}

function archivedSessionIds(ctx: Context): string[] {
  const registry = ctx.get("workspaceRegistry") as { archivedSessionIds?: readonly string[] } | undefined;
  return [...(registry?.archivedSessionIds ?? [])].map(String);
}

export function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type?: string; text?: string } => typeof block === "object" && block !== null && (block as { type?: string }).type === "text")
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
function assistantTextOf(event: SessionEventLike): string {
  const data = event.data as { message?: { content?: unknown }; content?: unknown } | undefined;
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
function toolResultTextOf(event: SessionEventLike): string {
  const data = event.data as { message?: { content?: unknown }; output?: unknown } | undefined;
  const raw = data?.message?.content;
  const blocks = Array.isArray(raw) ? raw : raw !== undefined && raw !== null ? [raw] : [];
  const parts: string[] = [];
  for (const block of blocks) {
    const inner = (block as { content?: unknown } | undefined)?.content;
    if (Array.isArray(inner)) parts.push(textOfContent(inner));
    else if (typeof inner === "string" && inner.trim() !== "") parts.push(inner);
  }
  const text = parts.join(" ").trim();
  return text !== "" ? text : String(data?.output ?? "").trim();
}

function snippetOf(event: SessionEventLike): string | undefined {
  if (event.type === "user/message" || event.type === "assistant/message") {
    // SR-1: user data IS the UserMessage (flat content); assistant prose is
    // wrapped under data.message (see assistantTextOf).
    const text = event.type === "user/message"
      ? textOfContent((event.data as { content?: unknown } | undefined)?.content)
      : assistantTextOf(event);
    if (text) return text;
  }
  if (event.type === "tool/call") {
    const data = event.data as { name?: unknown; arguments?: unknown; args?: unknown } | undefined;
    const name = typeof data?.name === "string" && data.name !== "" ? data.name : "tool";
    const raw = data?.arguments ?? data?.args;
    let detail = "";
    if (typeof raw === "string" && raw.trim() !== "") detail = ` ${raw.trim()}`;
    else if (raw !== undefined) detail = ` ${JSON.stringify(raw)}`;
    return `\u{1F6E0}\uFE0F ${name}${detail}`;
  }
  if (event.type === "tool/result") {
    const text = toolResultTextOf(event);
    if (text.trim()) return text.trim();
  }
  return undefined;
}

export interface SearchHit {
  sessionId: string;
  seq: number;
  type: string;
  snippet: string;
  live: boolean;
}

/** session.search: scan live logs + persisted logs, web-style snippet cap 240. */
export async function searchSessions(ctx: Context, query: string, limit = 20): Promise<SearchHit[]> {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const hits: SearchHit[] = [];
  const pushHits = (id: string, events: readonly SessionEventLike[], live: boolean) => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const snippet = snippetOf(events[i]);
      if (!snippet || !snippet.toLowerCase().includes(needle)) continue;
      hits.push({ sessionId: id, seq: events[i].seq, type: events[i].type, snippet: snippet.slice(0, 240), live });
      if (hits.length >= limit) return;
    }
  };
  const live = liveSessions(ctx); // one roster snapshot for both scan phases (was computed twice)
  for (const [id, session] of live) {
    if (hits.length >= limit) break; // stop scanning once full — the check used to sit OUTSIDE the live loop
    pushHits(id, sessionEvents(session), true);
  }
  if (hits.length >= limit) return hits;
  const persistence = persistenceOf(ctx);
  if (persistence) {
    try {
      for (const row of persistedRows(await persistence.list())) {
        if (hits.length >= limit) break; // hoisted BEFORE the read so a full hit list skips the next log entirely
        const id = String(row.id);
        if (live.has(id)) continue;
        try {
          const events = await loadSessionEvents(ctx, id);
          if (events !== undefined) pushHits(id, events, false);
        } catch {
          /* skip unreadable logs */
        }
      }
    } catch {
      /* degrade to live hits */
    }
  }
  return hits;
}

export interface HistoryItem {
  seq: number;
  type: string;
  role: string;
  text: string;
}

/** session.history: read a flat window of events (legacy; prefer readTrajectory). */
export async function readHistory(ctx: Context, sessionId: string, limit = 20, beforeSeq?: number): Promise<HistoryItem[]> {
  const events = (await loadSessionEvents(ctx, sessionId)) ?? [];
  const end = beforeSeq === undefined ? events.length : events.findIndex((e) => e.seq >= beforeSeq);
  const start = Math.max(0, (end === -1 ? events.length : end) - limit);
  const out: HistoryItem[] = [];
  for (const event of events.slice(start, end === -1 ? undefined : end)) {
    const text = snippetOf(event) ?? "";
    let role = event.type;
    if (event.type === "user/message") role = "user";
    else if (event.type === "assistant/message") role = "assistant";
    else if (event.type === "tool/call") role = "tool-call";
    else if (event.type === "tool/result") role = "tool-result";
    out.push({ seq: event.seq, type: event.type, role, text: text.slice(0, 400) });
  }
  return out;
}

export interface TrajectoryStep {
  seq: number;
  kind: "user" | "assistant" | "reasoning" | "tool-call" | "tool-result";
  text: string;
}

export interface TrajectoryTurn {
  startSeq: number;
  endSeq?: number;
  index: number;
  seconds?: number;
  outcome?: string;
  model?: string;
  changes?: string;
  steps: TrajectoryStep[];
}

export interface TrajectoryResult {
  turns: TrajectoryTurn[];
  hasMore: boolean;
  nextBefore?: number;
}

/** session.trajectory: turn-grouped structured view (issue #32). */
export async function readTrajectory(
  ctx: Context,
  sessionId: string,
  maxTurns = 6,
  beforeSeq?: number,
): Promise<TrajectoryResult> {
  const events = (await loadSessionEvents(ctx, sessionId)) ?? [];
  if (events.length === 0) return { turns: [], hasMore: false };

  // Build turns: one turn spans turn/start .. turn/end. Events before the
  // first turn/start form a headless "prelude" turn.
  const rawTurns: { start: number; end: number; startSeq: number; endSeq?: number; headless: boolean }[] = [];
  let openStart: number | undefined;
  for (let i = 0; i < events.length; i += 1) {
    if (events[i]!.type === "turn/start") {
      if (openStart !== undefined) rawTurns.push({ start: openStart, end: i, startSeq: events[openStart]!.seq, endSeq: undefined, headless: false });
      openStart = i;
    } else if (events[i]!.type === "turn/end") {
      if (openStart !== undefined) {
        rawTurns.push({ start: openStart, end: i + 1, startSeq: events[openStart]!.seq, endSeq: events[i]!.seq, headless: false });
        openStart = undefined;
      }
    }
  }
  if (openStart !== undefined) rawTurns.push({ start: openStart, end: events.length, startSeq: events[openStart]!.seq, endSeq: undefined, headless: false });

  // Prelude: events before the first turn/start or turn/end.
  const firstAnchor = rawTurns.length > 0 ? rawTurns[0]!.start : events.length;
  if (firstAnchor > 0) {
    rawTurns.unshift({ start: 0, end: firstAnchor, startSeq: events[0]!.seq, endSeq: undefined, headless: true });
  }

  // Paging: take the last `maxTurns` turns whose startSeq < beforeSeq.
  if (beforeSeq !== undefined) {
    const cutoff = rawTurns.findIndex((t) => t.startSeq >= beforeSeq);
    if (cutoff !== -1) rawTurns.splice(cutoff);
  }
  const hasMore = rawTurns.length > maxTurns;
  const page = hasMore ? rawTurns.slice(rawTurns.length - maxTurns) : rawTurns;
  const nextBefore = page.length > 0 ? page[0]!.startSeq : undefined;

  // Build TrajectoryTurn objects. Turn numbers count real turns only (the
  // headless prelude is not Turn 1) and stay stable across paged windows.
  const turns: TrajectoryTurn[] = [];
  const offset = rawTurns.length - page.length;
  const headlessBefore = offset > 0 && rawTurns[0]?.headless === true ? 1 : 0;
  let turnIndex = offset - headlessBefore;
  for (const raw of page) {
    if (!raw.headless) turnIndex += 1;
    const steps: TrajectoryStep[] = [];
    let model: string | undefined;
    let changes: string | undefined;
    let outcome: string | undefined;
    let seconds: number | undefined;
    const startAt = eventTime(events[raw.start]);
    // rawTurns records the closing turn/end index whenever endSeq is set
    // (`end: i + 1` beside `endSeq: events[i].seq`), so the end timestamp
    // reads by index — the old events.find() was an O(n) seq scan per turn
    // (review 🔵-5). The find() fallback only fires if that invariant above
    // ever changes, keeping the old behavior as a safety net.
    let endAt: number | undefined;
    if (raw.endSeq !== undefined) {
      const closed = events[raw.end - 1];
      endAt = closed !== undefined && closed.seq === raw.endSeq ? eventTime(closed) : eventTime(events.find((e) => e.seq === raw.endSeq));
    }
    if (startAt !== undefined && endAt !== undefined) seconds = Math.round((endAt - startAt) / 1000);

    for (let i = raw.start; i < raw.end; i += 1) {
      const event = events[i]!;
      if (event.type === "request/header") {
        const header = (event.data as { header?: { config?: { provider?: string; model?: string } } } | undefined)?.header;
        model = header?.config?.provider !== undefined && header.config.model !== undefined
          ? `${header.config.provider}/${header.config.model}`
          : undefined;
        changes = (event.data as { reason?: string } | undefined)?.reason ?? changes;
      } else if (event.type === "turn/end") {
        const reason = (event.data as { reason?: { kind?: string; error?: { message?: string } } } | undefined)?.reason;
        if (reason?.kind === "error") {
          outcome = `error: ${reason.error?.message?.slice(0, 50) ?? "unknown"}`;
        } else {
          outcome = reason?.kind ?? "completed";
        }
      } else if (event.type === "user/message") {
        const text = textOfContent((event.data as { content?: unknown } | undefined)?.content);
        if (text) steps.push({ seq: event.seq, kind: "user", text: text.slice(0, 200) });
      } else if (event.type === "assistant/message") {
        const content = (event.data as { message?: { content?: readonly { type?: string; text?: string }[] } } | undefined)?.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "reasoning" && block.text) {
              steps.push({ seq: event.seq, kind: "reasoning", text: block.text.slice(0, 200) });
            } else if (block.type === "text" && block.text) {
              steps.push({ seq: event.seq, kind: "assistant", text: block.text.slice(0, 200) });
            }
          }
        }
      } else if (event.type === "tool/call") {
        const data = event.data as { name?: unknown; arguments?: unknown; args?: unknown } | undefined;
        const name = typeof data?.name === "string" && data.name !== "" ? data.name : "tool";
        const raw = data?.arguments ?? data?.args;
        let detail = "";
        if (typeof raw === "string" && raw.trim() !== "") detail = ` ${raw.trim().slice(0, 80)}`;
        else if (raw !== undefined) detail = ` ${JSON.stringify(raw).slice(0, 80)}`;
        steps.push({ seq: event.seq, kind: "tool-call", text: `${name}${detail}` });
      } else if (event.type === "tool/result") {
        // SR-1: same envelope rule as snippetOf — the text lives on the
        // ToolResultMessage chain, not a flat `output` field.
        const text = toolResultTextOf(event);
        if (text.trim()) steps.push({ seq: event.seq, kind: "tool-result", text: text.trim().slice(0, 120) });
      }
    }
    if (raw.headless) {
      turns.push({ startSeq: raw.startSeq, endSeq: raw.endSeq, index: 0, steps });
    } else {
      turns.push({ startSeq: raw.startSeq, endSeq: raw.endSeq, index: turnIndex, seconds, outcome, model, changes, steps });
    }
  }
  return { turns, hasMore, nextBefore };
}
