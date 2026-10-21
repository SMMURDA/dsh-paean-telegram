/** Telegram's own per-message attachment ceiling for `telegram_attach`. */
export declare const IMAGE_REF_MAX_COUNT = 10;
/** Mirrors `ATTACH_MAX_BYTES` in `media/attachments.ts`. A file above this can
 * never be delivered, so its reference stays text instead of being stripped
 * and then failing at upload. `test/answer-images.test.mjs` asserts the two
 * constants agree, so the mirror cannot drift silently. */
export declare const IMAGE_REF_MAX_BYTES: number;
export interface ImageRefExtraction {
    /** Prose with every delivered image reference removed. */
    text: string;
    /** Workspace-relative paths to send as photos, in document order, deduped. */
    images: string[];
}
/**
 * Split `text` into prose + deliverable local images.
 *
 * A reference is kept verbatim (and NOT queued) when the target is remote, has
 * a non-photo extension, escapes the workspace, does not exist, is not a file,
 * is larger than the upload ceiling, sits inside code, or when the per-message
 * count is already exhausted.
 */
export declare function extractLocalImageRefs(text: string, options: {
    workspaceRoot: string;
    max?: number;
}): Promise<ImageRefExtraction>;
