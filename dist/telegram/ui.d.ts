/**
 * dsh-telegram Design Language (DTL): the one typography/glyph vocabulary
 * shared by every card, receipt and progress renderer.
 *
 * Grounded in the official Bot API formatting contract
 * (https://core.telegram.org/bots/api#formatting-options):
 *
 * - HTML parse mode supports exactly these tags: b/strong, i/em, u/ins,
 *   s/strike/del, tg-spoiler, a[href], code, pre, pre>code[class=language-x],
 *   blockquote, blockquote[expandable] and tg-time date-time entities.
 * - blockquote (and its expandable variant) can never nest.
 * - Only &lt; &gt; &amp; &quot; exist as named entities; numeric entities are
 *   fine — `escapeHtml` already respects this.
 * - Messages cap at 4096 chars; the transport splitter re-balances any markup
 *   produced here across parts.
 *
 * Convention: text-level helpers (`bold`, `mono`, …) take PLAIN strings and
 * escape them; line builders (`metaJoin`, `headerLine`) take already-rendered
 * HTML fragments and only compose layout. Never feed rendered HTML into a
 * text-level helper — it would be double-escaped and show tags literally.
 */
/** Metadata separator between segments of one header/status line. */
export declare const DOT = " \u00B7 ";
/** Join metadata fragments with the mid-dot separator, dropping empties. */
export declare function metaJoin(...parts: readonly (string | undefined | false)[]): string;
export declare function bold(value: string): string;
export declare function italic(value: string): string;
/** Inline fixed-width text for ids, paths, models, counts-that-are-code. */
export declare function mono(value: string): string;
/** Strikethrough for completed list items. */
export declare function strike(value: string): string;
/**
 * Bot API date-time entity rendering a client-localized RELATIVE time
 * ("3 minutes ago", localized on the user's phone). The escaped fallback
 * keeps older clients / notifications readable.
 *
 * Host seams occasionally deliver a timestamp that violates the number
 * contract despite the adapter types — session event `at` folds are blind-cast
 * (`event.at ?? event.data?.createdAt as number`) and workspace registry rows
 * pass through unvalidated. A NaN/undefined-coerced/non-positive value would
 * render `<tg-time unix="NaN">`, which Telegram's entity parser rejects with
 * an HTTP 400 that kills the whole card, so garbage degrades here to the
 * escaped fallback text WITHOUT the tg-time wrapper.
 */
export declare function relTime(atMs: number, fallback?: string): string;
/**
 * Card header: `${icon} <b>Title</b> · meta…`. One emoji, one bold title,
 * at most a couple of quiet metadata segments — the scannable top line every
 * card shares.
 */
export declare function headerLine(icon: string, title: string, ...meta: readonly (string | undefined | false)[]): string;
/** Thin horizontal rule between groups; pure text so plain-text lanes match. */
export declare function divider(width?: number): string;
/**
 * Progress bar in Telegram-safe block glyphs: `▓▓▓▓░░░░░░ 40%`. Pure text —
 * renders identically in HTML and plain lanes, no font assumptions beyond
 * the monospace-friendly blocks every client ships.
 */
export declare function progressBar(done: number, total: number, width?: number): string;
