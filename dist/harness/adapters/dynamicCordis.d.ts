/**
 * Dynamic Cordis domain: the web exposes 12 dynamicCordisRunner methods. The
 * read-only inventory predates issue #50; Telegram now also mirrors the
 * lifecycle half (define / run / stop / undefine) so a user can install their
 * own plugin — for example a decode plugin backed by their own model — and
 * activate it straight from the phone. Client-half activation still flows
 * through the standard approval channel, exactly like the web panel. Every
 * lifecycle invocation is bounded by RUNNER_TIMEOUT_MS (audit IA-2) so a hung
 * runner fails the originating card callback / command visibly instead of
 * wedging it forever.
 */
import type { Context } from "@deepseek-ai/cordis";
export interface DynamicCordisRow {
    pluginId: string;
    packageId?: string;
    status?: string;
    [key: string]: unknown;
}
/** User-supplied definition for one immutable Package (issue #50). */
export interface DynamicCordisDefineInput {
    /** Package label. */
    name: string;
    /** User-facing purpose. */
    purpose: string;
    /** Host-half source (JS program). Optional; at least one half is required. */
    host?: string;
    /** Client-half source (browser program). Optional. */
    client?: string;
}
export interface DynamicCordisResult {
    ok: boolean;
    text: string;
}
export declare function listDynamicCordis(ctx: Context): DynamicCordisRow[];
/** Runner deadline (audit IA-2, LOOP_AUDIT #3 class): a hung
 * dynamicCordisRunner — deadlocked runner or wedged plugin — used to hang the
 * originating card callback (dispatch plugin-run/stop/remove-confirm) or the
 * /pluginadd lane forever. One documented bound for all lifecycle seams,
 * mirroring host.ts withFsTimeout and core/cards.ts CARD_LOAD_TIMEOUT_MS. */
export declare const RUNNER_TIMEOUT_MS = 15000;
/**
 * Define a new dynamic Plugin's first Package (or append to an existing one
 * when `pluginId` is given). Mirrors web define semantics: the request is
 * session-scoped and returns Host-minted identities.
 */
export declare function defineDynamicCordis(ctx: Context, agentId: string, input: DynamicCordisDefineInput, existingPluginId?: string): Promise<DynamicCordisResult & {
    pluginId?: string;
    packageId?: string;
}>;
/**
 * Activate (or update to) a Package. With no explicit packageId the latest
 * known version is used. An unauthorized Client half parks in approval — the
 * interactive card flow settles it, same as the web.
 */
export declare function runDynamicPlugin(ctx: Context, agent: unknown, pluginId: string, packageId?: string): Promise<DynamicCordisResult>;
/** Stop the active run while keeping every immutable version. */
export declare function stopDynamicPlugin(ctx: Context, agent: unknown, pluginId: string): Promise<DynamicCordisResult>;
/** Remove a Plugin, its active run, and all Packages. Irreversible. */
export declare function undefineDynamicPlugin(ctx: Context, agent: unknown, pluginId: string): Promise<DynamicCordisResult>;
