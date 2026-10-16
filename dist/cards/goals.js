import { getGoal } from "../harness/adapters/goals.js";
import { listTodos } from "../harness/adapters/todos.js";
import { plain, truncate } from "../telegram/html.js";
import { bold, headerLine, metaJoin, relTime } from "../telegram/ui.js";
import { renderTodosCard } from "../telegram/todos-card.js";
import { safeWrap } from "../telegram/safe.js";
import { buildBackKeyboard, buildGoalsKeyboard } from "../telegram/keyboard.js";
/** Build the todos/goals cards and the per-chat Todos refresh loop. Called
 * once by index.ts; every card closes over the shared deps like the previous
 * module-scope closures did over index.ts singletons. */
export function createGoalCards(deps) {
    const { requireTransport, requireCtx, currentAgent, ephemeral, uiOps, activeCardRenderers, openCard, token, log, uiSend } = deps;
    /** Per-chat 5-second refresh loops for the live Todos card (issue #14). */
    const TODO_CARD_REFRESH_MS = 5000;
    const todoCardTimers = new Map();
    /** Refresh the open Todos card in place through the UI control lane. */
    async function refreshTodosCard(chatId) {
        const t = requireTransport();
        const agent = currentAgent(chatId);
        const todos = agent === undefined ? [] : listTodos(requireCtx(), agent.id);
        await ephemeral.replace(chatId, uiOps(t), renderTodosCard(todos, agent !== undefined), {
            parse_mode: "HTML",
            reply_markup: buildBackKeyboard(),
        });
    }
    /** Stop the per-chat Todos auto-refresh loop (reopen, card switch, teardown). */
    function stopTodoCardRefresh(chatId) {
        const timer = todoCardTimers.get(chatId);
        if (timer === undefined)
            return;
        clearInterval(timer);
        todoCardTimers.delete(chatId);
    }
    /** Start the 5s auto-refresh. The loop checks that the SAME renderer is still
     * the active card; Back/Close/any other card replaces it and stops the loop
     * on the next tick, so a stale timer can never write over another card. */
    function startTodoCardRefresh(chatId, refresh) {
        stopTodoCardRefresh(chatId);
        const timer = setInterval(() => {
            if (activeCardRenderers.get(chatId) !== refresh) {
                stopTodoCardRefresh(chatId);
                return;
            }
            void safeWrap(`todos-refresh(${chatId})`, () => refresh(), log);
        }, TODO_CARD_REFRESH_MS);
        todoCardTimers.set(chatId, timer);
    }
    async function openTodosCard(chatId) {
        const t0 = Date.now();
        log(`openTodosCard start chatId=${chatId}`);
        stopTodoCardRefresh(chatId);
        try {
            const agent = currentAgent(chatId);
            const todos = agent === undefined ? [] : listTodos(requireCtx(), agent.id);
            log(`openTodosCard agent=${agent?.id ?? "none"} todos=${todos.length} took=${Date.now() - t0}ms`);
            const refresh = () => refreshTodosCard(chatId);
            await openCard(chatId, renderTodosCard(todos, agent !== undefined), buildBackKeyboard(), refresh);
            // Start only after the card actually opened; `openCard` has already
            // registered `refresh` as the active renderer for this chat.
            startTodoCardRefresh(chatId, refresh);
        }
        catch (err) {
            log("openTodosCard FAILED", err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err));
            await uiSend(chatId, `\u274C Failed to load todo list: ${plain(truncate(err instanceof Error ? err.message : String(err), 120))}`, { parse_mode: "HTML" });
        }
    }
    async function openGoalsCard(chatId) {
        const agent = currentAgent(chatId);
        // Design language: bold header, then the objective itself as the bold
        // content line, quiet kv strip beneath (phase/activation/rounds, rev/time).
        const lines = [];
        let hasGoal = false;
        let paused = false;
        if (agent) {
            const goal = getGoal(requireCtx(), agent.id);
            if (goal) {
                hasGoal = true;
                paused = goal.phase === "paused";
                lines.push(headerLine("\u{1F3AF}", "Goal", paused ? "\u23F8 paused" : undefined), "");
                lines.push(bold(truncate(goal.objective, 120)));
                lines.push(metaJoin(`phase ${goal.phase}`, `activation ${goal.activation}`, `rounds ${goal.roundsStarted}${goal.maxGoalRounds !== undefined ? `/${goal.maxGoalRounds}` : ""}`));
                lines.push(metaJoin(`rev ${goal.revision}`, `created ${relTime(goal.createdAt)}`));
            }
            else {
                lines.push(headerLine("\u{1F3AF}", "Goal"), "", "(no current goal)");
            }
        }
        else {
            lines.push(headerLine("\u{1F3AF}", "Goal"), "", "No live agent \u2014 goals are per-agent.");
        }
        const goalPayload = agent ? { action: "goal", agentId: agent.id } : { action: "goal", agentId: "" };
        const callbacks = {
            ...(hasGoal ? {
                edit: token({ ...goalPayload, op: "edit" }, chatId),
                toggle: token({ ...goalPayload, op: paused ? "resume" : "pause" }, chatId),
                clear: token({ ...goalPayload, op: "clear" }, chatId),
            } : {}),
        };
        lines.push("", "Start: /goal &lt;objective&gt; [maxRounds]");
        if (hasGoal)
            lines.push("Edit: /goaledit &lt;objective&gt; [maxRounds] \u00B7 Clear: /goalclear");
        await openCard(chatId, lines.join("\n"), buildGoalsKeyboard(hasGoal, callbacks, paused));
    }
    return { todoCardTimers, stopTodoCardRefresh, openTodosCard, openGoalsCard };
}
//# sourceMappingURL=goals.js.map