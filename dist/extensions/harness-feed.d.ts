/**
 * dsh-harness-feed: native DeepSeek Harness streaming output (replaces the
 * openclaw-style draft).
 *
 * It no longer imitates openclaw's single flowing draft; it reuses the
 * harness's own output pipeline — the same three-layer mechanism as the web
 * side (api-proxy → ui-conversation):
 *
 * 1. Same event source: `ctx.on("session/event")`, routed by chat binding.
 * 2. Same assistant block folding semantics (web ui-conversation
 *    conversation-nodes/assistant.ts): `assistant/chunk`'s block-start /
 *    text-delta / reasoning-delta / block-end fold into per-(step, index)
 *    blocks — at the same folding granularity as the web (one fold = one
 *    assistant message = one LLM step), because chunk.index restarts at 0 on
 *    every step of an agentic turn, so a bare index would let a later step
 *    overwrite earlier prose (HF-1); a text block is the body, a reasoning
 *    block is Think; multi-step prose is concatenated into the same ANSWER
 *    bubble in (step, index) order.
 * 3. Same tool presentation vocabulary: `ctx.tools.get(name, scope).presentCall /
 *    presentResult` produce ToolCallView / ToolResultView (generic / terminal /
 *    diff / search / read / web cards), with a soft fallback to generic when a
 *    presenter fails — matching api-proxy viewFor. No more hand-maintained
 *    emoji table + JSON dump.
 *
 * Rendering semantics align with the web chat view:
 * - Think row = ReasoningRow: shows the newest line while running, freezes on
 *   the first line once the turn ends;
 * - tool row = compact tool card: the pending title comes from presentCall,
 *   the completed suffix from presentResult (exit code / match count / source
 *   count…);
 * - body = the assistant text block streaming typewriter-style (the web's
 *   markdown bubble); turn/end treats the committed assistant/message as the
 *   authoritative final text — the old openclaw draft delivered the body only
 *   after the turn ended, while here it is readable as it is generated, like
 *   the web.
 *
 * Turn layout: an ACTIVITY card (Think + tool rows, collapsing into a receipt
 * or an empty-state notice at the end) + an ANSWER message (streamed body,
 * finally kept in the chat). The openclaw-era reliability mechanisms
 * (placeholder adoption #12/#23, downgrade notices #13/#33, diff edits #15,
 * heartbeat budget #48, the Abort stop valve, errored-turn receipt
 * suppression #37) are all preserved.
 *
 * HF-2 lifecycle addendum: for answers above the transport's single-message
 * limit, streaming edits only the tail window (with a truncation marker) and
 * turn/end retracts the bubble and delivers the whole text through host.send's
 * splitText path; an in-flight "…" placeholder is settled late by turn/end
 * (adopted in place), and a placeholder that never landed is deleted instead
 * of staying in the chat forever; the session/event listener unsubscribes at
 * teardown, so a hot remount cannot stack listeners and duplicate rendering.
 *
 * HF-3 lifecycle fix: `outbound.liveFeed=false` turns off rendering only, not
 * the lifecycle — turn/start / turn/end registration and settlement run
 * unconditionally (turning the switch off mid-turn used to leave zombie cards
 * behind: the heartbeat kept editing up to MAX_HEARTBEATS and entries were
 * reclaimed only by the next turn/start; off at the start and on before the
 * end conjured a "🤷 Empty response" out of nowhere). Rendering side effects
 * are gated uniformly by a turn-level canRender snapshot (sticky: re-enabling
 * mid-turn does not revive expired rendering for that turn, and the core
 * forwarder owns delivery); an errored turn no longer collapses into a success
 * receipt (#37: on failure the summary is suppressed outright and the
 * placeholder takes the delete path, letting the core's classified failure
 * message stand on its own); freezing a committed reasoning line always queues
 * one activity refresh frame (block-end clears liveThinkRaw, so the frozen
 * first line would otherwise wait for an unrelated event to reach the screen).
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ExtensionHost } from "./types.js";
/** Cordis dependency: the main dsh-telegram plugin's provided bridge host.
 * The loader waits for this service and hands it over as `ctx.telegram`. */
export declare const inject: string[];
export declare function unmountHarnessFeed(): void;
export declare function apply(ctx: Context, _config?: unknown): void;
/**
 * Mount the harness-native streaming feed onto a bridge host. Built-in entry
 * used by index.ts; idempotent while active.
 */
export declare function mountHarnessFeed(host: ExtensionHost, ctx: Context): void;
