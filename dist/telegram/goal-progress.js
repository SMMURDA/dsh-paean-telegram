import { safeWrap } from "./safe.js";
import { escapeHtml, safePrefix } from "./html.js";
import { bold, metaJoin, progressBar } from "./ui.js";
import { renderTurnReceipt } from "./turn-receipt.js";
const EDIT_THROTTLE_MS = 250;
/** Long tools can be silent for a while: heartbeat every 30s so the elapsed
 * timer keeps moving and the user sees the task is alive (issue #18). Shared
 * with the streaming feed's activity-card heartbeat. */
export const LIVENESS_HEARTBEAT_MS = 30_000;
function bar(done, total) {
    return progressBar(done, total);
}
export class GoalProgressFeed {
    deps;
    running = new Map();
    dispose;
    constructor(deps) {
        this.deps = deps;
    }
    attach(ctx) {
        this.dispose = ctx.on("session/event", (...args) => {
            const session = args[0];
            const event = args[1];
            const chatId = this.deps.chatIdForAgent(String(session.id));
            if (chatId === undefined)
                return;
            this.record(chatId, event);
        });
    }
    detach() {
        this.dispose?.();
        this.dispose = undefined;
        for (const draft of this.running.values()) {
            if (draft.timer !== undefined)
                clearTimeout(draft.timer);
            if (draft.heartbeatTimer !== undefined)
                clearTimeout(draft.heartbeatTimer);
        }
        this.running.clear();
    }
    snapshot(chatId) {
        const running = this.running.get(chatId);
        if (!running)
            return undefined;
        const todos = this.deps.todosFor(chatId);
        return {
            objective: running.objective,
            turn: running.turn,
            step: running.step,
            tools: running.tools,
            currentTool: running.currentTool,
            elapsedMs: Date.now() - running.startedAt,
            todosDone: todos.filter((todo) => todo.status === "completed").length,
            todosTotal: todos.length,
        };
    }
    record(chatId, event) {
        const type = event.type;
        if (type === "turn/start") {
            const goal = this.deps.goalFor(chatId);
            if (goal === undefined || this.deps.liveRendererActive() || this.deps.pendingInbound(chatId))
                return;
            const previous = this.running.get(chatId);
            if (previous?.timer !== undefined)
                clearTimeout(previous.timer);
            const draft = {
                objective: goal.objective,
                turn: event.data?.turn ?? 0,
                step: 0,
                tools: 0,
                startedAt: Date.now(),
                uncachedInputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                finalized: false,
            };
            this.running.set(chatId, draft);
            this.sendCard(chatId, draft);
            if (this.deps.notifyOnLongTask?.() !== false)
                this.armHeartbeat(chatId, draft);
            return;
        }
        const draft = this.running.get(chatId);
        if (!draft || draft.finalized)
            return;
        if (type === "step/start") {
            draft.step = event.data?.step ?? draft.step;
            this.schedule(chatId, draft);
            return;
        }
        if (type === "tool/call") {
            draft.tools += 1;
            draft.currentTool = typeof event.data?.name === "string" ? event.data.name : undefined;
            this.schedule(chatId, draft);
            return;
        }
        if (type === "todo/write") {
            this.schedule(chatId, draft);
            return;
        }
        if (type === "assistant/chunk") {
            const usage = event.data?.chunk?.type === "usage" ? event.data.chunk.usage : event.data?.usage;
            if (usage !== undefined) {
                draft.uncachedInputTokens += usage.inputTokens ?? 0;
                draft.outputTokens += usage.outputTokens ?? 0;
                draft.cacheReadTokens += usage.cacheReadTokens ?? 0;
                draft.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
            }
            return;
        }
        if (type === "turn/end") {
            draft.finalized = true;
            if (draft.timer !== undefined) {
                clearTimeout(draft.timer);
                draft.timer = undefined;
            }
            if (draft.heartbeatTimer !== undefined) {
                clearTimeout(draft.heartbeatTimer);
                draft.heartbeatTimer = undefined;
            }
            this.finalize(chatId, draft);
            this.running.delete(chatId);
        }
    }
    renderRunning(chatId, draft) {
        const todos = this.deps.todosFor(chatId);
        const total = todos.length;
        const done = todos.filter((todo) => todo.status === "completed").length;
        const seconds = Math.max(1, Math.round((Date.now() - draft.startedAt) / 1000));
        // Design language: bold objective header; the objective is USER text and
        // this card is sent with parse_mode HTML — it must be escaped or a single
        // `<` in the goal would fail the whole send (HTTP 400).
        const lines = [`\u{1F3AF} ${bold(safePrefix(draft.objective, 60))}`, ""];
        if (total > 0)
            lines.push(metaJoin(`${bar(done, total)}`, `todo ${done}/${total}`));
        lines.push(metaJoin(`step ${draft.step}`, `tools ${draft.tools}`, `\u23F1\uFE0F ${seconds}s`));
        if (draft.currentTool !== undefined)
            lines.push(`\u{1F6E0}\uFE0F ${escapeHtml(draft.currentTool)}`);
        return lines.join("\n");
    }
    schedule(chatId, draft) {
        if (draft.timer !== undefined)
            return;
        draft.timer = setTimeout(() => {
            draft.timer = undefined;
            this.editCard(chatId, draft, this.renderRunning(chatId, draft));
        }, EDIT_THROTTLE_MS);
    }
    /** Periodic liveness edit: even with no new session events the card's
     * elapsed timer advances, so a long silent tool never looks frozen. */
    armHeartbeat(chatId, draft) {
        if (draft.heartbeatTimer !== undefined)
            return;
        draft.heartbeatTimer = setTimeout(() => {
            draft.heartbeatTimer = undefined;
            if (this.running.get(chatId) !== draft || draft.finalized)
                return;
            this.editCard(chatId, draft, this.renderRunning(chatId, draft));
            this.armHeartbeat(chatId, draft);
        }, LIVENESS_HEARTBEAT_MS);
        // Liveness only: never keep an otherwise-idle process alive.
        draft.heartbeatTimer.unref?.();
    }
    sendCard(chatId, draft) {
        const pending = this.deps.ops.send(chatId, this.renderRunning(chatId, draft), { parse_mode: "HTML" });
        draft.sending = pending;
        void safeWrap(`goal-progress-send(${chatId})`, () => pending.then((id) => {
            if (id !== undefined)
                draft.messageId = id;
            return id !== undefined;
        }), this.deps.log).then((sent) => {
            // Audit RE-6: only clear THIS turn's entry. A newer turn/start may have
            // replaced the draft while our send was still in flight; deleting it by
            // chatId alone would kill the new card/receipt/recovery state (same
            // identity check the streaming feed applies to its failure callbacks).
            if (sent !== true && this.running.get(chatId) === draft) {
                draft.sending = undefined;
                this.running.delete(chatId);
            }
        });
    }
    editCard(chatId, draft, text) {
        if (draft.messageId === undefined)
            return;
        void safeWrap(`goal-progress-edit(${chatId})`, () => this.deps.ops.edit(chatId, draft.messageId, text, { parse_mode: "HTML" }), this.deps.log);
    }
    finalize(chatId, draft) {
        const receipt = renderTurnReceipt({
            durationMs: Date.now() - draft.startedAt,
            toolCalls: draft.tools,
            reasoningSteps: 0,
            tokens: draft,
            sessionStats: this.deps.statusStats(chatId),
            goalObjective: draft.objective,
        });
        const settle = (messageId) => {
            if (messageId === undefined)
                return;
            void safeWrap(`goal-progress-finalize(${chatId})`, () => this.deps.ops.edit(chatId, messageId, receipt, { parse_mode: "HTML" }), this.deps.log);
        };
        if (draft.messageId !== undefined)
            settle(draft.messageId);
        else if (draft.sending !== undefined)
            void safeWrap(`goal-progress-finalize-pending(${chatId})`, () => draft.sending.then(settle), this.deps.log);
        // Completion push (issue #18): a silent in-place edit is easy to miss,
        // so goal turns also deliver one fresh receipt message with notifications.
        if (this.deps.notifyOnComplete?.() !== false) {
            void safeWrap(`goal-progress-completion(${chatId})`, () => this.deps.ops.send(chatId, receipt, {
                parse_mode: "HTML",
                disable_notification: false,
            }), this.deps.log);
        }
    }
}
//# sourceMappingURL=goal-progress.js.map