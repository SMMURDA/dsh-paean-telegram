/**
 * Local image references inside an outgoing answer.
 *
 * A model that renders a screenshot writes it as Markdown, e.g.
 * `![light theme](screenshots/01.png)`. Telegram renders nothing for that — it
 * used to reach the chat as literal text while the image itself stayed on disk.
 * This module turns such references into files the caller can upload, and
 * returns the prose with those references stripped so the bubble stays clean.
 *
 * Deliberately conservative: only `png`/`jpg`/`jpeg` (the formats `sendPhoto`
 * accepts), only paths that really exist **inside** the workspace root (symlink
 * escapes are resolved first), never remote URLs, and never code: a reference
 * inside a fenced block or an inline code span is documentation the model is
 * *showing*, so editing it would corrupt the example and upload a file nobody
 * asked for. Anything it cannot verify is left in the text untouched — a silent
 * drop would hide the model's intent.
 */
import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

/** Telegram's own per-message attachment ceiling for `telegram_attach`. */
export const IMAGE_REF_MAX_COUNT = 10;

/** Mirrors `ATTACH_MAX_BYTES` in `media/attachments.ts`. A file above this can
 * never be delivered, so its reference stays text instead of being stripped
 * and then failing at upload. `test/answer-images.test.mjs` asserts the two
 * constants agree, so the mirror cannot drift silently. */
export const IMAGE_REF_MAX_BYTES = 50 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg"]);

/** Characters that must hug the word before a removed reference. */
const CLOSING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", "\u2014", "\u2013"]);

/**
 * `![alt](target "optional title")`, allowing the angle-bracket form
 * `![alt](<target>)` and a title in either quote style.
 */
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(\s*<?([^)>\s]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

export interface ImageRefExtraction {
  /** Prose with every delivered image reference removed. */
  text: string;
  /** Workspace-relative paths to send as photos, in document order, deduped. */
  images: string[];
}

function withinWorkspace(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf(sep));
  if (dot === -1 || dot < slash) return "";
  return path.slice(dot + 1).toLowerCase();
}

/** URL-ish targets (`https:`, `data:`, `//host`, `mailto:`) are never local. */
function isRemote(ref: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref);
}

/** True when `index` falls inside one of `spans`. */
function insideSpans(spans: readonly { start: number; end: number }[], index: number): boolean {
  return spans.some((span) => index >= span.start && index < span.end);
}

/**
 * Spans of `text` that are code: fenced blocks (``` / ~~~, up to three spaces of
 * indent, closed by the same fence character at equal-or-greater length) and
 * inline code spans (a backtick run closed by the same run on the same line).
 *
 * A model documenting Markdown writes the syntax inside a fence; treating that
 * as a live reference would delete a line of the example and upload a file —
 * the reference is text there, and stays text.
 */
function codeSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let fence: { marker: string; start: number } | undefined;
  let lineStart = 0;
  for (;;) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(text.slice(lineStart, lineEnd))?.[1];
    if (fence === undefined) {
      if (marker !== undefined) fence = { marker, start: lineStart };
    } else if (marker !== undefined && marker[0] === fence.marker[0] && marker.length >= fence.marker.length) {
      spans.push({ start: fence.start, end: lineEnd });
      fence = undefined;
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  // An unclosed fence runs to the end of the answer.
  if (fence !== undefined) spans.push({ start: fence.start, end: text.length });

  for (let i = 0; i < text.length; ) {
    if (text[i] !== "`" || insideSpans(spans, i)) {
      i += 1;
      continue;
    }
    let run = 0;
    while (text[i + run] === "`") run += 1;
    const close = text.indexOf("`".repeat(run), i + run);
    if (close === -1 || text.slice(i, close).includes("\n")) {
      i += run;
      continue;
    }
    spans.push({ start: i, end: close + run });
    i = close + run;
  }
  return spans;
}

/**
 * Split `text` into prose + deliverable local images.
 *
 * A reference is kept verbatim (and NOT queued) when the target is remote, has
 * a non-photo extension, escapes the workspace, does not exist, is not a file,
 * is larger than the upload ceiling, sits inside code, or when the per-message
 * count is already exhausted.
 */
export async function extractLocalImageRefs(
  text: string,
  options: { workspaceRoot: string; max?: number },
): Promise<ImageRefExtraction> {
  const max = options.max ?? IMAGE_REF_MAX_COUNT;
  const resolvedRoot = resolve(options.workspaceRoot);
  const root = await realpath(resolvedRoot).catch(() => resolvedRoot);

  const images: string[] = [];
  /** Spans of the references that WILL be uploaded, in document order. */
  const removals: { start: number; length: number }[] = [];
  /** Resolved paths already queued, so `a.png` and `./a.png` count once. */
  const queued = new Set<string>();
  // Cheap gate: an answer without the `!` `[` pair cannot hold a reference, and
  // this runs on every final answer.
  if (!text.includes("![")) return { text, images };
  const code = codeSpans(text);

  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) {
    const start = match.index ?? 0;
    const ref = (match[2] ?? "").trim();

    if (ref === "" || isRemote(ref) || !IMAGE_EXTENSIONS.has(extensionOf(ref))) continue;
    // Documented syntax, not a picture: never edit the code, never upload.
    if (insideSpans(code, start)) continue;

    const abs = resolve(root, ref);
    const real = await realpath(abs).catch(() => abs);
    if (!withinWorkspace(root, real)) continue;
    const info = await stat(real).catch(() => undefined);
    if (info === undefined || !info.isFile()) continue;
    // Above Telegram's upload ceiling: keep the reference visible instead of
    // promising a photo the transport can only reject.
    if (info.size > IMAGE_REF_MAX_BYTES) continue;

    // A repeat of a path already queued is removed from the prose but sent once;
    // the per-message cap leaves the overflow reference visible instead.
    if (!queued.has(real)) {
      if (images.length >= max) continue;
      queued.add(real);
      images.push(ref);
    }
    removals.push({ start, length: match[0].length });
  }

  if (removals.length === 0) return { text, images };

  // Rebuild the prose without the delivered references. Whitespace is fixed at
  // the seam only: two spaces or a space+newline must not be left behind, and
  // nothing else in the answer is reflowed.
  let cleaned = "";
  let cursor = 0;
  for (const removal of removals) {
    let chunk = text.slice(cursor, removal.start);
    const before = text[removal.start - 1];
    const afterIndex = removal.start + removal.length;
    const after = text[afterIndex];
    const beforeSpace = before !== undefined && (before === " " || before === "\t");
    const afterSpace = after !== undefined && (after === " " || after === "\t");
    // A reference dropped right before closing punctuation must not leave
    // "lalu ." behind: the separating space goes with the image.
    if (after !== undefined && CLOSING_PUNCTUATION.has(after) && /[ \t]$/.test(chunk)) {
      chunk = chunk.slice(0, -1);
    }
    cleaned += chunk;
    cursor = afterIndex;
    // Both sides carry separation: keep exactly one, so "a ![x](y) b" stays
    // "a b" and never "a  b". The retained space is the one BEFORE the ref.
    if (beforeSpace && afterSpace) {
      while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t")) cursor += 1;
    }
  }
  cleaned += text.slice(cursor);

  cleaned = cleaned
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text: cleaned, images };
}
