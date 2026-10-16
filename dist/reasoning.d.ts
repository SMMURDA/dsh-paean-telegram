/**
 * Reasoning effort — a per-chat preference that steers how much deliberation
 * the agent applies. Mirrors codex-telegram-bot: implemented as a concise
 * directive prepended to inbound messages so it works regardless of
 * backend-specific knobs (dsh providers without reasoning metadata reject
 * the official reasoningEffort route with UNSUPPORTED_REASONING_EFFORT).
 */
export declare const REASONING_EFFORTS: readonly ["minimal", "low", "medium", "high", "max"];
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export declare const REASONING_DEFAULT: ReasoningEffort;
export declare function isReasoningEffort(value: unknown): value is ReasoningEffort;
export declare function reasoningDirective(effort: ReasoningEffort): string;
export declare function reasoningLabel(effort: ReasoningEffort): string;
