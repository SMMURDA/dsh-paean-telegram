import type { Context } from "@deepseek-ai/cordis";
import { type AdapterResult } from "./types.js";
export declare const TELEGRAM_DOCUMENT_LIMIT_BYTES: number;
/** Oversize guidance: the web URL path and the host-side location, so a
 * >50 MB log is still reachable instead of a dead end. */
export declare function oversizeGuidance(sessionId: string, totalBytes: number): string;
export interface SessionLogExport {
    result: AdapterResult;
    buffer?: Uint8Array;
}
/** sessionLog download: same ZIP the web serves, buffered for Telegram. */
export declare function exportSessionLog(ctx: Context, sessionId: string, includeDescendants: boolean): Promise<SessionLogExport>;
