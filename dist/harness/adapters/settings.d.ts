/**
 * Settings domain (web ApiProxy settings.describe/openDocument/update/replace/
 * mutate) over ctx.settings. Secrets stay redacted, same as the web.
 */
import type { Context } from "@deepseek-ai/cordis";
import { type AdapterResult } from "./types.js";
export interface SettingsNamespaceView {
    ns: string;
    /** Serialized schemastery envelope, when the registrant declared one. */
    schema?: unknown;
    value: unknown;
    base?: unknown;
    user?: unknown;
    applies: "live" | "restart";
    secrets: {
        path: string[];
        set: boolean;
    }[];
    revision: number;
}
export interface SettingsDescription {
    writable: boolean;
    hasDocument: boolean;
    documentPath?: string;
    namespaces: SettingsNamespaceView[];
    /** Namespaces the registrant marked outside the web boundary
     * (`exposed: false`) — filtered out of `namespaces`, listed here so the UI
     * can say what exists but is not web-addressable. */
    internalNamespaces: string[];
    error?: string;
}
/** Split a Telegram command argument of the form `<json> [expectedRevision]`
 * without disturbing whitespace inside JSON string values: full JSON first,
 * then a backwards scan for a trailing integer after the closing token.
 * A-2: the parsed `value` rides along so callers never JSON.parse a second
 * time; the `json` field keeps the original shape backward compatible. */
export declare function parseJsonWithRevision(raw: string): {
    json: string;
    value: unknown;
    revision?: number;
} | undefined;
export declare function describeSettings(ctx: Context): SettingsDescription;
export declare function updateSettings(ctx: Context, ns: string, patch: object, expectedRevision?: number): Promise<AdapterResult & {
    view?: SettingsNamespaceView;
}>;
export declare function replaceSettings(ctx: Context, ns: string, section: object, expectedRevision?: number): Promise<AdapterResult & {
    view?: SettingsNamespaceView;
}>;
export declare function mutateSettings(ctx: Context, ns: string, ops: {
    op: "set" | "unset";
    path: string[];
    value?: unknown;
}[], expectedRevision?: number): Promise<AdapterResult & {
    view?: SettingsNamespaceView;
}>;
