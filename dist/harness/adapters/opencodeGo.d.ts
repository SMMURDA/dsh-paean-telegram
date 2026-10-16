/**
 * opencode-go compatibility shim.
 *
 * The Go-tier gateway serves `gpt-5.6-luna` and `grok-4.5` through the
 * OpenAI **Responses** API, but pi-ai's installed opencode-go catalog routes
 * them through `chat/completions`, whose stream terminates with a bare
 * `{"choices":[]}` chunk and no `finish_reason` — every turn fails with
 * `TRANSPORT / Stream ended without finish_reason`.
 *
 * This module provisions one additive `opencode-go-responses` route in the
 * `llm-pi-ai` settings section (same api key, `/zen/go/v1/responses`,
 * cache retention disabled so no stateful session headers are sent) and
 * transparently repoints selections of the affected models to that route.
 */
import type { Context } from "@deepseek-ai/cordis";
export declare const OPENCODE_GO_RESPONSES_ROUTE = "opencode-go-responses";
/** Map a model selection onto the Go Responses route when it is affected. */
export declare function normalizeOpencodeGoModel(provider: string | undefined, model: string | undefined): {
    provider: string;
    model: string;
};
/** Whether the model needs the Responses-route rewrite. */
export declare function opencodeGoModelUsesResponses(provider: string | undefined, model: string | undefined): boolean;
export declare function ensureOpencodeGoResponsesRoute(ctx: Context, log: (message: string, error?: unknown) => void): Promise<boolean>;
