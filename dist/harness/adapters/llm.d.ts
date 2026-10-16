/**
 * LLM domain (web ApiProxy llm.providers/models/discoverModels + the catalog
 * shape behind session.models) over ctx.llm.
 */
import type { Context } from "@deepseek-ai/cordis";
import { type AdapterResult } from "./types.js";
export interface ModelEntry {
    id: string;
    name: string;
    description?: string;
    reasoning?: {
        efforts: {
            id: string;
            name: string;
            description?: string;
        }[];
        defaultEffort?: string;
    };
}
export interface ModelGroup {
    id: string;
    name: string;
    models: ModelEntry[];
}
export interface ModelCatalog {
    groups: ModelGroup[];
    failures: {
        provider: string;
        message: string;
    }[];
    current: {
        provider?: string;
        model?: string;
        reasoningEffort?: string;
    };
    /** Web SessionModels.routable: whether an adapter currently serves the
     * selected provider (no llm registry = cannot judge, so report true). */
    routable: boolean;
}
/** One llm.providers row: the web also reports where the provider is
 * configured (settingsNs/settingsPath), whether an adapter is currently
 * mounted (active), and whether the provider was declared by settings
 * (declared) as opposed to discovered at runtime. */
export interface ProviderEntry {
    id: string;
    name: string;
    settingsNs?: string;
    settingsPath?: string;
    active?: boolean;
    declared?: boolean;
}
export interface ProviderCatalog {
    providers: ProviderEntry[];
    failures: {
        provider: string;
        message: string;
    }[];
}
/** Build the web's exact model catalog shape (groups + failures + routable). */
export declare function modelCatalog(ctx: Context, current?: {
    provider?: string;
    model?: string;
    reasoningEffort?: string;
}): Promise<ModelCatalog>;
/** llm.providers: the provider roster with deployment facts, failures kept
 * separate so one broken registration never hides the rest. */
export declare function providerCatalog(ctx: Context): Promise<ProviderCatalog>;
export interface DiscoveredModel {
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
}
/** llm.discoverModels: interrogate a draft endpoint, never storing the key. */
export declare function discoverModels(ctx: Context, settingsNs: string, request: {
    provider?: string;
    baseURL?: string;
    api?: string;
    apiKey?: string;
}): Promise<AdapterResult & {
    models?: DiscoveredModel[];
}>;
