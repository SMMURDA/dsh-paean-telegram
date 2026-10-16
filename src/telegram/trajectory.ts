/**
 * Trajectory renderer (issue #32): the Web "轨迹" view is a turn-grouped
 * ledger (request header/model, tool calls with args and results, thinking,
 * per-turn outcome and duration) — not the flat `[seq] role text` event dump
 * `/history` used to print. This module renders `readTrajectory`'s data as
 * Telegram HTML lines shared by the History card and the `/history` command.
 *
 * Typography follows the shared design language (./ui.ts): one bold header,
 * bold turn labels with monospace models, thin rules between turns, and an
 * expandable blockquote folding the overflow of long tool loops (Bot API
 * blockquote[expandable] — collapsed by default, tap to unfold).
 */
import { escapeHtml, truncate } from "./html.js";
import { DOT, bold, divider, headerLine, mono } from "./ui.js";
import type { TrajectoryResult, TrajectoryStep, TrajectoryTurn } from "../harness/adapters/sessions.js";

const STEP_ICONS: Record<TrajectoryStep["kind"], string> = {
  user: "\u{1F464}",
  assistant: "\u{1F916}",
  reasoning: "\u{1F9E0}",
  "tool-call": "\u{1F527}",
  "tool-result": "\u{1F4E5}",
};

/** A turn shows at most this many steps before folding the rest into an
 * expandable quote — a runaway tool loop must not blow Telegram's 4096-char
 * message ceiling. */
export const TRAJECTORY_MAX_STEPS_PER_TURN = 8;

/** At most this many overflow steps render inside the expandable quote; the
 * rest collapse into a counter line so even a thousand-step loop stays
 * bounded. */
export const TRAJECTORY_MAX_FOLDED_STEPS = 20;

/** Joined-output ceiling for the whole page (#TL-1): the per-turn fold above
 * bounds STEP COUNTS, not bytes — escapeHtml can grow one 120-char step line
 * to ~723 chars (`&quot;` is 6 units per input char), so six paged turns of
 * quote-heavy tool output still exceeds Telegram's 4096 send/edit ceiling.
 * The History card hot-reloads in place, so an overlong page made the edit
 * lane fail fast and re-send the whole page on every turn/end. Body emission
 * stops at this budget (header adds ≤~250 chars) and the rest folds into a
 * "+N more step(s)" counter, keeping every render one editable bubble. */
export const TRAJECTORY_MAX_CHARS = 3700;

/** Reserved headroom for that closing counter line (its real length is ≤21). */
const MORE_TAIL_RESERVE = "\u2026 +99999 more step(s)".length;

/** Tool-call argument keys worth showing verbatim, in priority order: the
 * web trajectory surfaces the semantic argument (`read <path>`), not raw
 * JSON. */
const TOOL_ARG_KEYS = ["path", "cmd", "command", "query", "url", "file", "pattern", "id", "name", "objective"] as const;

/** Fold every whitespace run (including newlines) into one space — a step is
 * a single ledger line; multi-line text blew up the turn layout (#history). */
function foldWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `read {"path":"…"}` → `read …`: parse the JSON argument blob and show the
 * meaningful value instead of raw JSON. Unknown shapes fall back to compact
 * JSON; unparseable text falls back to the folded original. */
export function formatToolCallText(text: string): string {
  const folded = foldWhitespace(text);
  const match = folded.match(/^(\S+)\s+(\{.+\})$/);
  if (!match) return folded;
  const [, name, json] = match;
  try {
    const args = JSON.parse(json) as Record<string, unknown>;
    for (const key of TOOL_ARG_KEYS) {
      const value = args[key];
      if (typeof value === "string" && value.trim() !== "") return `${name} ${foldWhitespace(value)}`;
    }
    return `${name} ${JSON.stringify(args)}`;
  } catch {
    return folded;
  }
}

function outcomeIcon(outcome: string | undefined): string {
  if (outcome === undefined) return "\u23F3"; // still running (no turn/end)
  if (outcome.startsWith("error")) return "\u274C";
  if (outcome === "completed") return "\u2705";
  return "\u2699\uFE0F";
}

/** Header for one turn: `▸ Turn 3 · deepseek/chat · ✅ completed · ⏱ 12s`.
 * The model comes from the turn's request/header (the web trajectory's model
 * line); `changes` (header reason) is appended when the provider recorded one. */
function turnHeaderLine(turn: TrajectoryTurn): string {
  const label = turn.index === 0 ? "Prelude" : `Turn ${turn.index}`;
  const parts = [`\u25B8 ${bold(label)}`];
  if (turn.model !== undefined) parts.push(mono(truncate(turn.model, 40)));
  // Outcome text is host-supplied and otherwise unbounded (error folds can
  // carry whole messages); truncate pre-escape so one turn header can never
  // eat the page budget on its own (#TL-1).
  parts.push(`${outcomeIcon(turn.outcome)} ${escapeHtml(truncate(turn.outcome ?? "running", 60))}`);
  if (turn.seconds !== undefined) parts.push(`\u23F1\uFE0F ${turn.seconds}s`);
  const line = parts.join(DOT);
  return turn.changes === undefined ? line : `${line} ${DOT}${escapeHtml(truncate(turn.changes, 40))}`;
}

function stepLine(step: TrajectoryStep): string {
  // Single-line ledger entries: newlines in assistant messages and tool
  // results used to blow up the turn list (#history rendering).
  const text = step.kind === "tool-call" ? formatToolCallText(step.text) : foldWhitespace(step.text);
  return `  ${STEP_ICONS[step.kind]} ${escapeHtml(truncate(text, 120))}`;
}

/** Thin divider between turns for visual hierarchy. */
const TURN_DIVIDER = divider(16);

/** Fold the steps beyond the visible window into an expandable quote: the
 * card stays scannable while every step remains one tap away. The quote is
 * capped (TRAJECTORY_MAX_FOLDED_STEPS lines) so a runaway loop cannot exceed
 * the 4096-char ceiling. */
function foldedStepsLine(hidden: readonly TrajectoryStep[]): string {
  const shown = hidden.slice(0, TRAJECTORY_MAX_FOLDED_STEPS).map(stepLine);
  if (hidden.length > TRAJECTORY_MAX_FOLDED_STEPS) {
    shown.push(`  \u2026 ${hidden.length - TRAJECTORY_MAX_FOLDED_STEPS} more step(s)`);
  }
  return `<blockquote expandable>${shown.join("\n")}</blockquote>`;
}

/** Render the paged trajectory as HTML lines (header line first). Body lines
 * are emitted under TRAJECTORY_MAX_CHARS (#TL-1); sub-limit pages render
 * byte-identically to the old unbounded walk. */
export function renderTrajectoryLines(sessionId: string, result: TrajectoryResult): string[] {
  const count = result.turns.length;
  const turnsLabel = `${count} turn${count === 1 ? "" : "s"}${result.hasMore ? "+" : ""}`;
  const headerBlock = [headerLine("\u{1F4DC}", "Trajectory", mono(truncate(sessionId, 32)), turnsLabel), ""];
  if (count === 0) {
    return [...headerBlock, "(no events)"];
  }
  const out: string[] = [];
  let used = headerBlock.join("\n").length;
  let hiddenSteps = 0;
  let renderedTurns = 0;
  // Conservative fit check (+1 per line for the joining newline; off by at
  // most one char on the very first body line). push() applies the same
  // accounting, so a passing fits() guarantees the pushes land.
  const fits = (lines: readonly string[]): boolean => {
    let extra = MORE_TAIL_RESERVE;
    for (const line of lines) extra += 1 + line.length;
    return used + extra <= TRAJECTORY_MAX_CHARS;
  };
  const push = (line: string): boolean => {
    if (!fits([line])) return false;
    used += 1 + line.length;
    out.push(line);
    return true;
  };
  /** Steps left unseen from turn `from` onward — the counter's "+N". */
  const stepsFrom = (turns: readonly TrajectoryTurn[], from: number): number =>
    turns.slice(from).reduce((sum, turn) => sum + turn.steps.length, 0);

  for (let turnIndex = 0; turnIndex < result.turns.length; turnIndex += 1) {
    const turn = result.turns[turnIndex]!;
    // Empty turns are noise: a Prelude with no steps rendered a pointless
    // `(no steps)` placeholder — skip them entirely (#history rendering).
    if (turn.steps.length === 0) continue;
    // All-or-nothing head group: a divider must never strand behind a
    // refused header at the budget edge.
    const head = renderedTurns > 0 ? [TURN_DIVIDER, turnHeaderLine(turn)] : [turnHeaderLine(turn)];
    if (!fits(head)) {
      hiddenSteps += stepsFrom(result.turns, turnIndex);
      break;
    }
    for (const line of head) push(line);
    renderedTurns += 1;
    const visible = turn.steps.slice(0, TRAJECTORY_MAX_STEPS_PER_TURN);
    let cutAt = -1;
    for (let index = 0; index < visible.length; index += 1) {
      if (!push(stepLine(visible[index]!))) {
        // steps[index..] covers both the unshown visible window and the
        // folded tail of THIS turn, plus every later turn.
        cutAt = index;
        hiddenSteps += turn.steps.length - index + stepsFrom(result.turns, turnIndex + 1);
        break;
      }
    }
    if (cutAt !== -1) break;
    if (turn.steps.length > visible.length) {
      // The blockquote renders as one indivisible line: refusing it sends
      // its folded steps to the counter rather than half-rendering a quote.
      if (!push(foldedStepsLine(turn.steps.slice(visible.length)))) {
        hiddenSteps += turn.steps.length - visible.length + stepsFrom(result.turns, turnIndex + 1);
        break;
      }
    }
  }
  if (hiddenSteps > 0) out.push(`\u2026 +${hiddenSteps} more step(s)`);
  else if (renderedTurns === 0) out.push("(no steps)");
  return [...headerBlock, ...out];
}
