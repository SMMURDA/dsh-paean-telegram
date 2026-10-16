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
/** Retry base delay used wherever a consumer does not configure one
 * explicitly (audit R3-3: the default literal lives in exactly one place). */
export declare const DEFAULT_RETRY_BASE_DELAY_MS = 500;
/** Absolute ceiling for SERVER-mandated 429 waits (TR-1). The value is
 * honored verbatim up to here — clipping below it guarantees another 429,
 * and once the attempt budget burns down, a message that one longer nap
 * would have delivered gets thrown away. 120s only stops a pathological
 * number (the Bot API documents retry_after up to 3600s) from parking a
 * chat lane for an hour; the per-chat FIFO lane is idle while sleeping, so
 * the cost of waiting is bounded by the caller's own timeout. */
export declare const MAX_RETRY_AFTER_MS = 120000;
export interface QueueOptions {
    /** Max sends allowed per window. */
    maxPerWindow?: number;
    /** Window length in ms. */
    windowMs?: number;
    retry?: {
        attempts: number;
        baseDelayMs: number;
    };
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
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
export declare function isRetryable(err: unknown): boolean;
export declare class SendQueue {
    private maxPerWindow;
    private windowMs;
    private retryAttempts;
    private retryBaseDelayMs;
    private readonly sleep;
    private readonly now;
    private readonly stamps;
    private readonly chains;
    private queued;
    private active;
    constructor(options?: QueueOptions);
    /** Hot-update the limiter while in-flight sends keep flowing. */
    configure(options: QueueOptions): void;
    /** Wait until the global sliding window admits one more send. */
    takeSlot(): Promise<void>;
    /** Serialize per chat, then rate-limit globally, then run with retries. */
    push<T>(key: number | string, fn: () => Promise<T>): Promise<T>;
    private execute;
    /** Ops not yet started plus ops in flight. */
    pendingCount(): number;
}
