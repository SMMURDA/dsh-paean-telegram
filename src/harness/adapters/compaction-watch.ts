/**
 * Context-pressure compaction watcher (issue #8).
 *
 * The dsh profile has no dedicated `context_tokens` service in rc.6, so the
 * watcher reads the authoritative durable sources: `request/context` gives the
 * model context window and each stream's `usage` gives the latest request
 * input size. On step end it compares the ratio against `compact.threshold`
 * and either compacts (auto) or asks once (ask); a successful compaction is
 * announced from the durable compaction/summary + compaction/end pair.
 */
import type { Context } from "@deepseek-ai/cordis";
import { sessionEvents } from "./session-read.js";

export interface CompactionUsage {
  used?: number;
  window?: number;
  ratio?: number;
}

export interface CompactionWatcherDeps {
  ctx: Context;
  log: (message: string, error?: unknown) => void;
  chatIdForAgent(agentId: string): number | undefined;
  threshold(): number;
  policy(): "auto" | "ask" | "never";
  cooldownMs(): number;
  /** Ask the user (one inline card per session until answered/compacted). */
  askApproval(chatId: number, sessionId: string, usage: CompactionUsage): void;
  notify(chatId: number, text: string): void;
  now?: () => number;
}

interface EventLike {
  type?: string;
  data?: {
    contextWindow?: number;
    chunk?: { type?: string; usage?: TokenUsageLike };
    usage?: TokenUsageLike;
    shadowedTokenCount?: number;
    summary?: readonly { type?: string; text?: string }[];
    error?: string;
  };
}

interface TokenUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface SessionState {
  used?: number;
  window?: number;
  lastTriggerAt?: number;
  pendingApproval: boolean;
  triggered: boolean;
  summary?: { text: string; shadowedTokenCount: number };
}

interface AgentLike {
  id: unknown;
  session?: unknown;
  options?: { provider?: string; model?: string };
}

export interface ContextUsageSource {
  /** Legacy seam (unit tests): the log handed over directly. */
  events?: readonly EventLike[];
  /** Real agent: the log lives on its session. */
  session?: unknown;
  options?: { provider?: string; model?: string };
}

/** Pure threshold predicate: triggers once per cooldown window. */
export function shouldCompact(used: number, window: number, threshold: number, lastTriggerAt: number | undefined, now: number, cooldownMs: number): boolean {
  if (!(used > 0) || !(window > 0) || threshold <= 0 || threshold >= 1) return false;
  if (used / window < threshold) return false;
  return lastTriggerAt === undefined || now - lastTriggerAt >= cooldownMs;
}

/** Read the latest durable context facts for one live agent. */
export function contextUsageOf(agent: AgentLike | undefined): CompactionUsage {
  const source = agent as unknown as ContextUsageSource | undefined;
  // The live agent carries its log on `agent.session` (the log moved from the
  // agent to its Session in dsh 0.2); a seam may still hand events over
  // directly.
  const events = Array.isArray(source?.events)
    ? source.events
    : (sessionEvents(source?.session) as unknown as readonly EventLike[]);
  let used: number | undefined;
  let window: number | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "request/context" && event.data?.contextWindow !== undefined && window === undefined) {
      window = event.data.contextWindow;
    }
    // Usage arrives as a stream chunk on legacy runs and as the settled
    // assistant message on current dsh; both carry the same TokenUsage.
    if (used === undefined && (event?.type === "assistant/chunk" || event?.type === "assistant/message")) {
      const usage = event.data?.chunk?.type === "usage" ? event.data.chunk.usage : event.data?.usage;
      if (usage !== undefined) {
        used = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
      }
    }
    if (used !== undefined && window !== undefined) break;
  }
  return {
    ...(used === undefined ? {} : { used }),
    ...(window === undefined ? {} : { window }),
    ...(used !== undefined && window !== undefined && window > 0 ? { ratio: used / window } : {}),
  };
}

export class CompactionWatcher {
  private readonly states = new Map<string, SessionState>();
  private dispose: (() => void) | undefined;
  private disposeSession: (() => void) | undefined;

  constructor(private readonly deps: CompactionWatcherDeps) {}

  attach(): void {
    const on = this.deps.ctx.on.bind(this.deps.ctx) as (name: string, listener: (...args: unknown[]) => void) => () => void;
    this.dispose = on("session/event", (...args: unknown[]) => {
      const session = args[0] as { id: unknown };
      const event = args[1] as EventLike;
      this.record(String(session.id), event);
    });
    // LOOP_AUDIT #8: sessions that never emit compaction/end must not leave a
    // watcher state behind forever.
    this.disposeSession = on("session/disposed", (...args: unknown[]) => {
      const session = args[0] as { id?: unknown } | undefined;
      if (session?.id !== undefined) this.states.delete(String(session.id));
    });
  }

  detach(): void {
    this.dispose?.();
    this.dispose = undefined;
    this.disposeSession?.();
    this.disposeSession = undefined;
    this.states.clear();
  }

  /** User answered the approval card: compact on the next idle boundary. */
  approve(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    state.pendingApproval = false;
    this.runAuto(sessionId, state);
  }

  snooze(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (state) state.pendingApproval = false;
  }

  private record(sessionId: string, event: EventLike): void {
    const type = event.type;
    if (type === "compaction/summary") {
      const state = this.state(sessionId);
      const text = (event.data?.summary ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text ?? "")
        .join(" ")
        .trim();
      state.summary = { text: text.slice(0, 300), shadowedTokenCount: event.data?.shadowedTokenCount ?? 0 };
      return;
    }
    if (type === "compaction/end") {
      const state = this.states.get(sessionId);
      if (!state) return;
      const chatId = this.deps.chatIdForAgent(sessionId);
      if (state.triggered && chatId !== undefined && event.data?.error === undefined && state.summary !== undefined) {
        const tokens = `~${state.summary.shadowedTokenCount} tokens`;
        const summary = state.summary.text === "" ? "" : `\nSummary: ${state.summary.text}`;
        this.deps.notify(chatId, `\u{1F4DD} Context compacted ${tokens}${summary}`);
      }
      this.states.delete(sessionId);
      return;
    }
    if (type !== "request/context" && type !== "assistant/chunk" && type !== "step/end" && type !== "turn/end") return;
    const state = this.state(sessionId);
    if (event.data?.contextWindow !== undefined) state.window = event.data.contextWindow;
    if (type === "assistant/chunk") {
      const usage = event.data?.chunk?.type === "usage" ? event.data.chunk.usage : event.data?.usage;
      if (usage !== undefined) {
        state.used = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
      }
    }
    if (type !== "step/end" && type !== "turn/end") return;
    const policy = this.deps.policy();
    if (policy === "never") return;
    const now = this.deps.now?.() ?? Date.now();
    if (state.used === undefined || state.window === undefined) return;
    if (!shouldCompact(state.used, state.window, this.deps.threshold(), state.lastTriggerAt, now, this.deps.cooldownMs())) return;
    if (policy === "ask") {
      const chatId = this.deps.chatIdForAgent(sessionId);
      // Arm the ask only once a bound chat can actually receive the card: an
      // unbound session must neither leave pendingApproval stuck (it would
      // block every later step/end evaluation forever) nor burn the cooldown
      // window on a question nobody will ever see.
      if (chatId === undefined) {
        this.deps.log("context compaction ask skipped: no chat is bound to the session", { sessionId });
        return;
      }
      if (!state.pendingApproval) {
        state.pendingApproval = true;
        state.lastTriggerAt = now;
        this.deps.askApproval(chatId, sessionId, contextUsageOf(this.agentFor(sessionId)));
      }
      return;
    }
    state.lastTriggerAt = now;
    this.runAuto(sessionId, state);
  }

  private agentFor(sessionId: string): AgentLike | undefined {
    return (this.deps.ctx.agents?.get(sessionId as never) as unknown as AgentLike | undefined);
  }

  private state(sessionId: string): SessionState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { pendingApproval: false, triggered: false };
      this.states.set(sessionId, state);
    }
    return state;
  }

  private runAuto(sessionId: string, state: SessionState): void {
    const compaction = (this.deps.ctx as unknown as { compaction?: { compactIfNeeded(agent: unknown, trigger: "pressure" | "context-overflow", signal: AbortSignal): Promise<unknown> } }).compaction;
    const agent = this.agentFor(sessionId);
    if (!compaction || !agent) {
      this.deps.log("context compaction unavailable", { sessionId, hasCompaction: compaction !== undefined, hasAgent: agent !== undefined });
      return;
    }
    state.triggered = true;
    const signal = new AbortController().signal;
    void compaction.compactIfNeeded(agent, "pressure", signal).catch((err: unknown) => {
      this.deps.log("auto compaction FAILED", err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err));
    });
  }
}
