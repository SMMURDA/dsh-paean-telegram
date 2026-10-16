import type { Context } from "@deepseek-ai/cordis";
import { type AdapterResult } from "./types.js";
/** pluginInventory/list entry: the web's exact projection shape. */
export interface PluginEntry {
    entryId: string;
    moduleName: string | undefined;
    enabled: boolean;
    fiberPhase: string | null;
}
/** pluginInventory/list: the web's exact projection shape. */
export declare function listPlugins(ctx: Context): PluginEntry[];
export declare function patchFilePathFor(profile: string | undefined, home: string): string | undefined;
/** Durable toggle: rewrite only the profile's user patch layer (block-style YAML). */
export declare function persistPluginPatch(entryId: string, disabled: boolean, file?: string): AdapterResult;
/** Toggle one plugin: live now (restart-reverted) + durable patch (restart-applied). */
export declare function togglePlugin(ctx: Context, entryId: string, disabled: boolean): Promise<AdapterResult>;
/** Entry id for a module name (the loader's stable id is usually the name). */
export declare function entryIdFor(ctx: Context, moduleName: string): string | undefined;
