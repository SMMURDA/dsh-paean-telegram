/**
 * HTML formatting helpers. User/agent content is ALWAYS escaped before it is
 * wrapped, so a message can never inject markup we did not intend.
 *
 * `splitText` is HTML-aware: Telegram rejects malformed HTML (HTTP 400), so a
 * long message must never be cut inside a tag or leave a tag unclosed. Plain
 * text keeps the historical newline/space/hard-split behavior byte-for-byte.
 */
export declare function escapeHtml(value: string): string;
export declare function bold(value: string): string;
export declare function code(value: string): string;
export declare function link(label: string, href: string): string;
export declare function plain(value: string): string;
/** Code-point-safe prefix that never splits a surrogate pair. No ellipsis is
 * added; callers that want one (truncate) append it themselves. */
export declare function safePrefix(value: string, max: number): string;
export declare function truncate(value: string, max: number): string;
/**
 * Split a payload into Telegram-safe parts. Newlines are the preferred
 * boundary; an overlong single line is hard-split at the last space within
 * the limit (or exactly at the limit when it has no spaces at all). HTML
 * parts are additionally rebalanced: a tag that would span the cut is closed
 * at the end of the first part and reopened at the start of the next one, so
 * every part parses on its own.
 */
export declare function splitText(text: string, max: number): string[];
