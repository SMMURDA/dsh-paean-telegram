/**
 * Credentials domain (web ApiProxy credentials.describe/set/unset) over
 * ctx.credentials. Values never ride back — describe only reports
 * configured/source/writable, exactly like the web.
 */
import type { Context } from "@deepseek-ai/cordis";
import { type AdapterResult } from "./types.js";
export interface CredentialView {
    ref: string;
    configured: boolean;
    source?: string;
    writable: boolean;
}
export declare function describeCredential(ctx: Context, ref: string): Promise<AdapterResult & {
    view?: CredentialView;
}>;
/** credentials.describe batch: web accepts up to 64 refs; Telegram mirrors
 * that by fanning out the single-ref host seam and combining the views. */
export declare function describeCredentials(ctx: Context, refs: readonly string[]): Promise<AdapterResult & {
    views?: CredentialView[];
}>;
/** Enumerate the credential refs this host exposes (empty without the
 * optional seam — values never ride back either way). */
export declare function listCredentialRefs(ctx: Context): Promise<string[]>;
export declare function setCredential(ctx: Context, ref: string, value: string): Promise<AdapterResult>;
export declare function unsetCredential(ctx: Context, ref: string): Promise<AdapterResult>;
