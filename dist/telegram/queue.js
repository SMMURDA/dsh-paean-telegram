/**
 * Outbound send pipeline: per-chat FIFO serialization plus a global sliding
 * window rate limit (Telegram caps a bot at ~30 messages/second globally and
 * ~1/second per chat). Retries honor `retry_after` for 429 responses,
 * verbatim up to MAX_RETRY_AFTER_MS (TR-1): sleeping less than the server
 * mandated wait just re-429s into a burned attempt budget.
 *
 * Nothing here blocks the dsh agent loop: callers always get a promise, and
 * every operation is queued fire-and-forget style.
 */
import { serializePerKey } from "./serialize-per-key.js";
/** Retry base delay used wherever a consumer does not configure one
 * explicitly (audit R3-3: the default literal lives in exactly one place). */
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;
/** Absolute ceiling for SERVER-mandated 429 waits (TR-1). The value is
 * honored verbatim up to here — clipping below it guarantees another 429,
 * and once the attempt budget burns down, a message that one longer nap
 * would have delivered gets thrown away. 120s only stops a pathological
 * number (the Bot API documents retry_after up to 3600s) from parking a
 * chat lane for an hour; the per-chat FIFO lane is idle while sleeping, so
 * the cost of waiting is bounded by the caller's own timeout. */
export const MAX_RETRY_AFTER_MS = 120_000;
/** Ceiling for the exponential-backoff GUESS used when Telegram gives no
 * `retry_after` guidance. Deliberately NOT applied to server values. */
const MAX_BACKOFF_MS = 30_000;
function isRateLimited(err) {
    return typeof err === "object" && err !== null && err.error_code === 429;
}
function retryAfterMs(err) {
    if (!isRateLimited(err))
        return undefined;
    const seconds = err.parameters?.retry_after;
    return typeof seconds === "number" ? seconds * 1000 : undefined;
}
/** Only transient failures deserve a retry. A Telegram error code tells us
 * authoritatively: 429 (rate limit) and 5xx are transient, every other 4xx is
 * a permanent payload/permission problem that a retry can never fix. Without
 * an error code we retry only recognizable transport failures (network
 * TypeError or our own API timeout), never arbitrary Errors.
 *
 * Exported (TR-1) so the transport's edit/markup lanes classify errors with
 * the SAME predicate the queue retries on: an error swallowed as a permanent
 * `false` here must never be one the queue would have retried. */
export function isRetryable(err) {
    if (err !== null && typeof err === "object") {
        const code = err.error_code;
        if (typeof code === "number")
            return code === 429 || code >= 500;
        if (err.name === "AbortError")
            return false;
    }
    if (err instanceof TypeError)
        return true;
    return err instanceof Error && err.message.startsWith("telegram api timeout after ");
}
function positiveNumber(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
function nonNegativeNumber(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
export class SendQueue {
    maxPerWindow;
    windowMs;
    retryAttempts;
    retryBaseDelayMs;
    sleep;
    now;
    stamps = [];
    chains = new Map();
    queued = 0;
    active = 0;
    constructor(options = {}) {
        // `takeSlot` spins until `stamps.length < maxPerWindow`; a non-positive
        // window/budget would make that condition mathematically unreachable.
        // Clamp here so a misconfigured queue degrades instead of hanging forever.
        this.maxPerWindow = positiveNumber(options.maxPerWindow, 20);
        this.windowMs = positiveNumber(options.windowMs, 1000);
        this.retryAttempts = nonNegativeNumber(options.retry?.attempts, 3);
        this.retryBaseDelayMs = nonNegativeNumber(options.retry?.baseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS);
        this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.now = options.now ?? Date.now;
    }
    /** Hot-update the limiter while in-flight sends keep flowing. */
    configure(options) {
        if (options.maxPerWindow !== undefined)
            this.maxPerWindow = positiveNumber(options.maxPerWindow, this.maxPerWindow);
        if (options.windowMs !== undefined)
            this.windowMs = positiveNumber(options.windowMs, this.windowMs);
        if (options.retry?.attempts !== undefined)
            this.retryAttempts = nonNegativeNumber(options.retry.attempts, this.retryAttempts);
        if (options.retry?.baseDelayMs !== undefined)
            this.retryBaseDelayMs = nonNegativeNumber(options.retry.baseDelayMs, this.retryBaseDelayMs);
    }
    /** Wait until the global sliding window admits one more send. */
    async takeSlot() {
        for (;;) {
            const cutoff = this.now() - this.windowMs;
            while (this.stamps.length > 0 && this.stamps[0] <= cutoff)
                this.stamps.shift();
            if (this.stamps.length < this.maxPerWindow) {
                this.stamps.push(this.now());
                return;
            }
            await this.sleep(Math.max(1, this.stamps[0] + this.windowMs - this.now()));
        }
    }
    /** Serialize per chat, then rate-limit globally, then run with retries. */
    push(key, fn) {
        this.queued += 1;
        return serializePerKey(this.chains, key, () => this.execute(fn));
    }
    async execute(fn) {
        this.queued -= 1;
        this.active += 1;
        let attempt = 0;
        try {
            for (;;) {
                await this.takeSlot();
                try {
                    return await fn();
                }
                catch (err) {
                    attempt += 1;
                    if (attempt > this.retryAttempts || !isRetryable(err))
                        throw err;
                    // A server retry_after is law (TR-1): honored verbatim under the
                    // absolute ceiling, never clipped below it — guessing shorter than
                    // the mandated wait just lands another 429 and burns the budget.
                    // Only the no-guidance exponential guess keeps the 30s cap.
                    const serverWaitMs = retryAfterMs(err);
                    await this.sleep(serverWaitMs !== undefined
                        ? Math.min(serverWaitMs, MAX_RETRY_AFTER_MS)
                        : Math.min(this.retryBaseDelayMs * 2 ** (attempt - 1), MAX_BACKOFF_MS));
                }
            }
        }
        finally {
            this.active -= 1;
        }
    }
    /** Ops not yet started plus ops in flight. */
    pendingCount() {
        return this.queued + this.active;
    }
}
//# sourceMappingURL=queue.js.map