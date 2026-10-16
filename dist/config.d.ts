/** Telegram Bot API hard cap for one outbound text payload; longer text is
 * split into parts. Shared by the schema default and the validation upper
 * bound below (review 🟡-6). */
export declare const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
/** How inbound chat text is treated before it ever reaches the agent. */
export type InboundMode = 'auto-handle' | 'queue-only' | 'muted';
/** Which channel owns `ask_user_question` when more than one UI is mounted. */
export type QuestionOwnership = 'telegram' | 'web' | 'both' | 'auto';
/** Context-pressure compaction policy (issue #8). */
export type CompactionPolicy = 'auto' | 'ask' | 'never';
/** Ordered inbound rule; the first matching rule wins, otherwise `inbound.defaultMode`. */
export interface InboundRule {
    /** Optional numeric Telegram chat id. */
    chatId?: number;
    /** Optional case-insensitive substring; matches when the message text contains it. */
    pattern?: string;
    mode: InboundMode;
}
export interface TelegramConfig {
    security: {
        /** Chat id whitelist for inbound traffic. Empty means ALL inbound chat is rejected. */
        allowedChatIds: number[];
        /**
         * Optional absolute-path whitelist (B-7r) constraining the Host/Workspace
         * browse seams (/ls, /mkdir, /open, workspace create). Absent = the seams
         * stay unconstrained (behavior unchanged); when set, a path is only
         * browsable when it resolves inside one of these roots.
         */
        browseRoots?: string[];
        /**
         * A-1 (CF-1): kill-switch for the self-service bootstrap channel — the
         * "Allow this chat" button on the unauthorized prompt. The effective
         * default is ENABLED and the key stays absent until configured (same
         * posture as browseRoots), so default deployments persist byte-identical
         * configs; `false` makes the tap answer with the refusal text and never
         * touch the roster. dispatch reads `=== false`, so absent ≡ enabled.
         */
        selfAllow?: boolean;
    };
    watch: {
        /** Start long-polling automatically when the plugin mounts. */
        autoStart: boolean;
    };
    inbound: {
        defaultMode: InboundMode;
        rules: InboundRule[];
    };
    outbound: {
        /** Telegram parse mode for assistant output. Model Markdown is normalized
         * to valid Telegram HTML before sending; internal cards are always HTML. */
        parseMode: 'HTML';
        disableNotification: boolean;
        /** Per-message send retries on 429 / network errors. */
        maxRetries: number;
        /** Global send budget: messages per second (Bot API safe bound is 30). */
        sendRatePerSecond: number;
        /** Hard cap for one outbound text payload; longer text is split into parts. */
        maxMessageLength: number;
        /** Live reasoning/tool feed: one message edited in place while a turn
         * streams (web-style thinking + tool-call visibility). */
        liveFeed?: boolean;
    };
    /** Context-pressure auto compaction: when the latest request uses more than
     * `threshold` of the model context window, the bridge compacts automatically
     * (`auto`), asks first (`ask`), or stays quiet (`never`). */
    compact: {
        threshold: number;
        policy: CompactionPolicy;
        /** Minimum interval between two triggers for one session, ms. */
        cooldownMs: number;
    };
    /** Active project folder (Codex-style); new sessions are created under it. */
    workspace: {
        /** Absolute folder picked via /project; absent = boot directory. */
        activePath?: string;
    };
    /** Optional display facts surfaced in the status card. */
    mode?: {
        name?: string;
    };
    /** Telegram-owned default model (overrides the profile default so the bot
     * can run a different model than the web keeps). */
    model?: {
        provider?: string;
        model?: string;
    };
    /** Per-chat reasoning effort (codex-telegram-bot semantics): a directive is
     * prepended to inbound messages. Absent = medium. */
    reasoning?: {
        effort?: "minimal" | "low" | "medium" | "high" | "max";
    };
    /** Telegram media handling (issue #9): OpenAI-compatible voice
     * transcription. Missing apiKey = transcription disabled with guidance. */
    media?: {
        transcribe?: {
            baseUrl?: string;
            apiKey?: string;
            model?: string;
        };
    };
    /** Interactive question/approval channel routing. */
    interactive?: {
        /**
         * Which UI answers `ask_user_question`:
         * - `both` (default): mirror approvals/questions to both Telegram and the
         *   web when the host api-proxy is mounted; whichever side answers first
         *   settles the other side's card. Without the api-proxy seam this falls
         *   back to Telegram-only behavior.
         * - `telegram`: Telegram owns the question card, even when the web API
         *   proxy is mounted (web profile included).
         * - `web`: yield to the web API proxy's user-questions provider.
         * - `auto`: register the Telegram provider only when no enabled web API
         *   proxy loader entry is mounted (the legacy inference).
         */
        userQuestions?: QuestionOwnership;
        /** Tool names permanently auto-allowed after the user taps
         * "Allow forever (by tool)" on an approval card. Revoke with
         * `/config set interactive.allowByTool [...]`. */
        allowByTool?: string[];
    };
    /** Long-task notifications (issue #18): goal completion push + periodic
     * liveness heartbeat while a silent tool keeps running. */
    notify?: {
        /** Send a fresh receipt message (with sound) when a goal turn finishes. */
        onComplete?: boolean;
        /** Edit the progress card every 30s so elapsed time keeps moving. */
        onLongTask?: boolean;
    };
}
export declare const DEFAULT_CONFIG: TelegramConfig;
/** Config errors carry a JSON-pointer-ish path so humans can fix `.pi/telegram.json`. */
export declare class ConfigError extends Error {
    readonly path: string;
    constructor(path: string, message: string);
}
/** Merge raw (possibly partial) user config over defaults, validating every field. */
export declare function normalizeConfig(raw: unknown): TelegramConfig;
/** First matching inbound rule for (chatId, text), otherwise the default mode. */
export declare function resolveInboundMode(config: TelegramConfig, chatId: number, text: string): InboundMode;
/** Whether inbound messages from this chat are accepted at all. */
export declare function isChatAllowed(config: TelegramConfig, chatId: number): boolean;
/**
 * B-7r: optional root confinement for the host/workspace browse seams.
 * `undefined`/empty roots are a no-op (the default config keeps behavior
 * unchanged); otherwise `path` must resolve inside one of the roots — both
 * sides go through `resolve`, and the comparison uses `root + sep` so a
 * sibling directory that merely shares a prefix (`/a/home-evil` vs `/a/home`)
 * never slips through. Throws so adapters can degrade to their own fail text.
 */
export declare function assertBrowsable(path: string, roots: readonly string[] | undefined): void;
/**
 * Bot token comes only from the environment; the plugin itself never
 * persists it. For local checkouts that want the bridge to survive server
 * restarts without shell env wiring, `mountToken` (index.ts) falls back to a
 * gitignored `.telegram-token` file next to this package — the OPERATOR
 * writes that file once; the plugin only ever reads it.
 */
export declare function resolveToken(env?: NodeJS.ProcessEnv): string | undefined;
/** Read one token file: whole-file trim, empty/absent file = no token. */
export declare function readTokenFile(path: string): string | undefined;
/**
 * Absolute path of the checkout-local fallback token file: `.telegram-token`
 * beside this package (`<pkg>/dist/config.js` → `<pkg>/.telegram-token`).
 * Anchored to the module URL, so it follows the real install location.
 */
export declare function packageTokenFile(): string;
/** Mount-time resolution order: explicit env, then a token file referenced
 * by `TELEGRAM_BOT_TOKEN_FILE`, then the checkout-local `.telegram-token`. */
export declare function mountToken(env?: NodeJS.ProcessEnv): string | undefined;
/** Path of the config file for a workspace root. */
export declare function configFilePath(workspaceRoot: string): string;
/** Read + normalize config from a workspace root; missing file returns defaults. */
export declare function readConfig(workspaceRoot: string): TelegramConfig;
/** Persist config (pretty-printed) under `<root>/.pi/telegram.json`. */
export declare function writeConfig(workspaceRoot: string, config: TelegramConfig): string;
export type ConfigSection = "security" | "watch" | "inbound" | "outbound" | "compact" | "mode" | "workspace" | "reasoning" | "model" | "media" | "interactive" | "notify";
/**
 * Overlay a raw loader-provided config (from `ctx.config` / `internal/update`)
 * on top of an already-normalized config. Only keys present in the raw patch
 * are touched — the rest of the running config stays untouched (hot update).
 * Keys unknown to the schema are skipped (never written as `undefined`), and a
 * patched plain-object value overlays one level deeper so sibling leaves in
 * the running config survive (depth 2 covers the entire schema).
 */
export declare function overlayConfig(current: TelegramConfig, raw: unknown): {
    config: TelegramConfig;
    changed: ConfigSection[];
};
/** Read a config leaf by dot path (e.g. `outbound.sendRatePerSecond`). */
export declare function getConfigPath(config: TelegramConfig, path: string): unknown;
/** Build a nested patch object from a dot path + parsed JSON value. */
export declare function patchFromPath(path: string, value: unknown): Record<string, unknown>;
