import { sessionEvents } from "./session-read.js";
/** Pure threshold predicate: triggers once per cooldown window. */
export function shouldCompact(used, window, threshold, lastTriggerAt, now, cooldownMs) {
    if (!(used > 0) || !(window > 0) || threshold <= 0 || threshold >= 1)
        return false;
    if (used / window < threshold)
        return false;
    return lastTriggerAt === undefined || now - lastTriggerAt >= cooldownMs;
}
/** Read the latest durable context facts for one live agent. */
export function contextUsageOf(agent) {
    const source = agent;
    // The live agent carries its log on `agent.session` (the log moved from the
    // agent to its Session in dsh 0.2); a seam may still hand events over
    // directly.
    const events = Array.isArray(source?.events)
        ? source.events
        : sessionEvents(source?.session);
    let used;
    let window;
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
        if (used !== undefined && window !== undefined)
            break;
    }
    return {
        ...(used === undefined ? {} : { used }),
        ...(window === undefined ? {} : { window }),
        ...(used !== undefined && window !== undefined && window > 0 ? { ratio: used / window } : {}),
    };
}
export class CompactionWatcher {
    deps;
    states = new Map();
    dispose;
    disposeSession;
    constructor(deps) {
        this.deps = deps;
    }
    attach() {
        const on = this.deps.ctx.on.bind(this.deps.ctx);
        this.dispose = on("session/event", (...args) => {
            const session = args[0];
            const event = args[1];
            this.record(String(session.id), event);
        });
        // LOOP_AUDIT #8: sessions that never emit compaction/end must not leave a
        // watcher state behind forever.
        this.disposeSession = on("session/disposed", (...args) => {
            const session = args[0];
            if (session?.id !== undefined)
                this.states.delete(String(session.id));
        });
    }
    detach() {
        this.dispose?.();
        this.dispose = undefined;
        this.disposeSession?.();
        this.disposeSession = undefined;
        this.states.clear();
    }
    /** User answered the approval card: compact on the next idle boundary. */
    approve(sessionId) {
        const state = this.states.get(sessionId);
        if (!state)
            return;
        state.pendingApproval = false;
        this.runAuto(sessionId, state);
    }
    snooze(sessionId) {
        const state = this.states.get(sessionId);
        if (state)
            state.pendingApproval = false;
    }
    record(sessionId, event) {
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
            if (!state)
                return;
            const chatId = this.deps.chatIdForAgent(sessionId);
            if (state.triggered && chatId !== undefined && event.data?.error === undefined && state.summary !== undefined) {
                const tokens = `~${state.summary.shadowedTokenCount} tokens`;
                const summary = state.summary.text === "" ? "" : `\nSummary: ${state.summary.text}`;
                this.deps.notify(chatId, `\u{1F4DD} Context compacted ${tokens}${summary}`);
            }
            this.states.delete(sessionId);
            return;
        }
        if (type !== "request/context" && type !== "assistant/chunk" && type !== "step/end" && type !== "turn/end")
            return;
        const state = this.state(sessionId);
        if (event.data?.contextWindow !== undefined)
            state.window = event.data.contextWindow;
        if (type === "assistant/chunk") {
            const usage = event.data?.chunk?.type === "usage" ? event.data.chunk.usage : event.data?.usage;
            if (usage !== undefined) {
                state.used = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
            }
        }
        if (type !== "step/end" && type !== "turn/end")
            return;
        const policy = this.deps.policy();
        if (policy === "never")
            return;
        const now = this.deps.now?.() ?? Date.now();
        if (state.used === undefined || state.window === undefined)
            return;
        if (!shouldCompact(state.used, state.window, this.deps.threshold(), state.lastTriggerAt, now, this.deps.cooldownMs()))
            return;
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
    agentFor(sessionId) {
        return this.deps.ctx.agents?.get(sessionId);
    }
    state(sessionId) {
        let state = this.states.get(sessionId);
        if (!state) {
            state = { pendingApproval: false, triggered: false };
            this.states.set(sessionId, state);
        }
        return state;
    }
    runAuto(sessionId, state) {
        const compaction = this.deps.ctx.compaction;
        const agent = this.agentFor(sessionId);
        if (!compaction || !agent) {
            this.deps.log("context compaction unavailable", { sessionId, hasCompaction: compaction !== undefined, hasAgent: agent !== undefined });
            return;
        }
        state.triggered = true;
        const signal = new AbortController().signal;
        void compaction.compactIfNeeded(agent, "pressure", signal).catch((err) => {
            this.deps.log("auto compaction FAILED", err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err));
        });
    }
}
//# sourceMappingURL=compaction-watch.js.map