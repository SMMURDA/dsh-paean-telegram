/**
 * Assistant-output Markdown normalizer.
 *
 * The model speaks Markdown; Telegram Bot API HTML mode does not. Rather than
 * asking every deployment to choose a second parse mode (and maintain a second
 * entity-aware splitter), assistant prose is normalized to Telegram HTML here:
 *
 * - `**bold**` / `__bold__`          -> <b>
 * - `*italic*` / `_italic_`          -> <i> (word-boundary aware)
 * - `~~strike~~`                     -> <s>
 * - `` `code` `` / fenced blocks     -> <code> / <pre>
 * - `[label](url)`                   -> <a>
 * - ATX headings                     -> a bold line (Telegram HTML has no h1-h6)
 * - unordered lists                  -> bullet glyphs; ordered lists keep numbers
 * - block quotes                     -> <blockquote>
 *
 * Telegram rejects non-conforming entity nesting with HTTP 400 "can't parse
 * entities" (MD-1): `code`/`pre` may not appear inside any other entity and
 * an anchor's content must be plain text. Link labels are therefore flattened
 * to plain escaped text, and styled runs flatten inner code spans to text.
 * Legal styling nestings (e.g. b>i) stay untouched.
 *
 * Everything else is HTML-escaped, so malformed model markup degrades to
 * readable text instead of being sent raw to Telegram. Internal cards,
 * keyboards, approvals, questions, and the live streaming draft keep their
 * own deliberate HTML and never pass through this function.
 */
/** Telegram-monospace display width of a cell (issue #31): `String.length`
 * counts UTF-16 code units, so CJK cells padded by code units misalign
 * against Latin columns (a CJK char renders ~2 columns in the monospace
 * font). Width is measured on the RAW cell: escapeHtml entities render as
 * one character inside <pre><code>, so padding against the escaped length
 * would under-pad columns containing & < > " characters. */
export declare function cellDisplayWidth(text: string): number;
/** First GFM table found anywhere in a text, as an aligned monospace block.
 * Streaming progress lines use this so a table snapshot renders as a table
 * instead of leaking raw `|`/`---` pipes (issue #26). Full assistant answers
 * go through `markdownToHtml`, which already handles the same blocks (#19). */
export declare function markdownTablePreBlock(markdown: string): string | undefined;
/** Convert model Markdown to Telegram Bot API HTML parse mode. */
export declare function markdownToHtml(markdown: string): string;
