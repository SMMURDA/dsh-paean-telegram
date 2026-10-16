import type { TrajectoryResult } from "../harness/adapters/sessions.js";
/** A turn shows at most this many steps before folding the rest into an
 * expandable quote — a runaway tool loop must not blow Telegram's 4096-char
 * message ceiling. */
export declare const TRAJECTORY_MAX_STEPS_PER_TURN = 8;
/** At most this many overflow steps render inside the expandable quote; the
 * rest collapse into a counter line so even a thousand-step loop stays
 * bounded. */
export declare const TRAJECTORY_MAX_FOLDED_STEPS = 20;
/** Joined-output ceiling for the whole page (#TL-1): the per-turn fold above
 * bounds STEP COUNTS, not bytes — escapeHtml can grow one 120-char step line
 * to ~723 chars (`&quot;` is 6 units per input char), so six paged turns of
 * quote-heavy tool output still exceeds Telegram's 4096 send/edit ceiling.
 * The History card hot-reloads in place, so an overlong page made the edit
 * lane fail fast and re-send the whole page on every turn/end. Body emission
 * stops at this budget (header adds ≤~250 chars) and the rest folds into a
 * "+N more step(s)" counter, keeping every render one editable bubble. */
export declare const TRAJECTORY_MAX_CHARS = 3700;
/** `read {"path":"…"}` → `read …`: parse the JSON argument blob and show the
 * meaningful value instead of raw JSON. Unknown shapes fall back to compact
 * JSON; unparseable text falls back to the folded original. */
export declare function formatToolCallText(text: string): string;
/** Render the paged trajectory as HTML lines (header line first). Body lines
 * are emitted under TRAJECTORY_MAX_CHARS (#TL-1); sub-limit pages render
 * byte-identically to the old unbounded walk. */
export declare function renderTrajectoryLines(sessionId: string, result: TrajectoryResult): string[];
