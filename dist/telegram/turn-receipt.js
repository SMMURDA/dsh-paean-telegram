import { renderStatsLine } from "../harness/adapters/status.js";
import { safePrefix } from "./html.js";
import { DOT, bold, metaJoin } from "./ui.js";
/** Compact receipt (issue #21): ONE line of the five user-facing
 * metrics — duration, thoughts, tools, turns/steps, cache hit. Token billing
 * and performance segments stay internal; editText hit rate is logged by the
 * renderer instead of being shown to the user. */
export function renderTurnReceipt(receipt) {
    const seconds = Math.max(1, Math.round(receipt.durationMs / 1000));
    // Design language: the outcome/objective leads in bold, quiet metrics trail.
    // The objective is user text under parse_mode HTML — escape it (a `<` in a
    // goal would otherwise fail the receipt send with HTTP 400).
    const parts = [
        receipt.goalObjective === undefined
            ? metaJoin(`\u2699\uFE0F ${bold("\u5B8C\u6210")}`, `\u23F1\uFE0F ${seconds}s`)
            : metaJoin(`\u2705 ${bold(safePrefix(receipt.goalObjective, 60))}`, `\u23F1\uFE0F ${seconds}s`),
    ];
    if ((receipt.reasoningSteps ?? 0) > 0)
        parts.push(`\u{1F9E0} ${receipt.reasoningSteps} \u6B21\u601D\u8003`);
    if ((receipt.toolCalls ?? 0) > 0)
        parts.push(`\u{1F6E0}\uFE0F ${receipt.toolCalls} \u6B21\u5DE5\u5177`);
    const statsSegments = receipt.sessionStats === undefined ? [] : (renderStatsLine(receipt.sessionStats)?.split(" | ") ?? []);
    if (statsSegments[0] !== undefined)
        parts.push(statsSegments[0]);
    const billed = (receipt.tokens?.uncachedInputTokens ?? 0) + (receipt.tokens?.cacheReadTokens ?? 0) + (receipt.tokens?.cacheWriteTokens ?? 0);
    const cached = receipt.tokens?.cacheReadTokens ?? 0;
    if (billed > 0 && cached > 0)
        parts.push(`\u{1F4BE} \u547D\u4E2D ${Math.round((cached / billed) * 100)}%`);
    return parts.join(DOT);
}
//# sourceMappingURL=turn-receipt.js.map