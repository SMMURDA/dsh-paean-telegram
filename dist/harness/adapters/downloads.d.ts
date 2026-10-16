import type { Context } from "@deepseek-ai/cordis";
import { type AdapterResult } from "./types.js";
export declare const TELEGRAM_DOCUMENT_LIMIT_BYTES: number;
/**
 * Test seam: pin the probe result so the "seam present" and "seam absent"
 * branches are both deterministic. On a host where the profile packages really
 * resolve (any developer machine running Paean), the probe succeeds and the
 * absent-branch test would otherwise depend on the environment. Production code
 * never calls this.
 */
export declare function setExportSeamForTest(seam: unknown): void;
/** Oversize guidance: the web URL path and the host-side location, so a
 * >50 MB log is still reachable instead of a dead end. */
export declare function oversizeGuidance(sessionId: string, totalBytes: number): string;
export interface SessionLogExport {
    result: AdapterResult;
    buffer?: Uint8Array;
}
/** sessionLog download: same ZIP the web serves, buffered for Telegram. */
export declare function exportSessionLog(ctx: Context, sessionId: string, includeDescendants: boolean): Promise<SessionLogExport>;
