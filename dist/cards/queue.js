import { listQueue } from "../harness/adapters/sessions.js";
import { statusSnapshot } from "../harness/adapters/status.js";
import { plain, truncate } from "../telegram/html.js";
import { DOT, bold, headerLine, metaJoin } from "../telegram/ui.js";
import { buildQueueKeyboard } from "../telegram/keyboard.js";
/** Render one numbered queue preview line. Pure so the text and button windows
 * can be tested side by side (QC-1). */
export function renderQueuePreviewLine(item, index) {
    const kind = item.target === "next-turn" ? "turn" : "step";
    const preview = item.text.trim().replace(/\s+/g, " ") || "(no text)";
    return `#${index + 1} ${DOT}${kind} ${DOT} ${plain(truncate(preview, 60))}`;
}
/** Build the queue card. Called once by index.ts; the card closes over the
 * shared deps like the previous module-scope closure did over index.ts
 * singletons. */
export function createQueueCards(deps) {
    const { state, requireCtx, currentAgent, boundAgentId, progressFor, openCard } = deps;
    async function openQueueCard(chatId) {
        const ctx = requireCtx();
        const agent = currentAgent(chatId);
        const snapshot = statusSnapshot(ctx, boundAgentId(chatId), false);
        const items = agent ? listQueue(ctx, agent.id) : [];
        const progress = progressFor(chatId);
        // Design language: bold header with quiet inbox/outbox meta, then the live
        // goal line (bold objective + metrics), then the numbered inbox items.
        const lines = [
            headerLine("\u{1F4E8}", "Queue", `inbox ${snapshot.queue}`, `outbox ${state.transport?.pending() ?? 0}`),
            "",
        ];
        if (progress !== undefined) {
            const seconds = Math.max(1, Math.round(progress.elapsedMs / 1000));
            lines.push(metaJoin(`\u{1F3AF} ${bold(truncate(progress.objective, 40))}`, `step ${progress.step}`, `tools ${progress.tools}`, progress.currentTool !== undefined ? `now ${plain(truncate(progress.currentTool, 24))}` : undefined, `\u23F1\uFE0F ${seconds}s`, progress.todosDone > 0 && progress.todosTotal > progress.todosDone
                ? `ETA ~${Math.max(1, Math.round((progress.elapsedMs / progress.todosDone) * (progress.todosTotal - progress.todosDone) / 1000))}s`
                : undefined));
        }
        items.slice(0, 24).forEach((item, index) => lines.push(renderQueuePreviewLine(item, index)));
        if (items.length === 0) {
            lines.push("(nothing pending)", "", "\u{1F4A1} Send two messages in a row and the second queues; every entry has \u270F/\u{1F5D1}/\u26A1 buttons.");
        }
        else {
            lines.push("", "\u270F Edit \u00B7 \u{1F5D1} Delete \u00B7 \u26A1 Run now (next turn only) \u2014 use the buttons below");
        }
        await openCard(chatId, lines.join("\n"), buildQueueKeyboard(items.map((item, index) => ({ itemId: item.itemId, kind: item.target, index }))));
    }
    return { openQueueCard };
}
//# sourceMappingURL=queue.js.map