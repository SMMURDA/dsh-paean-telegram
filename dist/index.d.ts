/**
 * dsh-telegram: a native Telegram bridge for DeepSeek Harness.
 *
 * Assembly only — every capability lives in its own module:
 *   telegram/  : transport, queues, keyboards, panels (no dsh imports)
 *   harness/   : adapters + bridge (no grammy imports besides types)
 *
 * v0.2 wiring adds every web-exposed domain (sessions/workspace/goals/
 * feedback/skills/subagents/presets/settings/credentials/llm/host/commands/
 * jobs/downloads/plugins/dynamicCordis/approvals/questions) as a Telegram card.
 */
import type { Context } from "@deepseek-ai/cordis";
import { renderStatsStrip } from "./harness/adapters/status.js";
export declare const name = "dsh-telegram";
export declare const version = "0.4.0";
export declare const inject: string[];
/** Keepalive decision (#48): a live agent's own status is authoritative —
 * the sticky running-turn flag goes stale when a turn/end event is lost,
 * which used to re-arm the typing loop forever. The flag is only trusted
 * when no live agent can answer, and the rearm budget caps that stale path.
 * A genuinely running agent is never budget-killed: turns legitimately
 * outlast a few windows, so the budget must not fire before the agent check.
 * Lives in core/chat-hub.ts (yellow-1 step 3); re-exported so the public
 * dist/index.js contract (test/issue-47-48.test.mjs) is unchanged. */
export { typingKeepaliveActive } from "./core/chat-hub.js";
/** Terminal loop cleanup for one chat (#48) lives in core/chat-hub.ts and is
 * destructured from the hub above; the live-feed seam arrives as a dep. */
export { renderStatsStrip };
export declare function apply(ctx: Context, loaderConfig?: unknown): void | Promise<void>;
