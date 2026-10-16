import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REASONING_DEFAULT, REASONING_EFFORTS } from './reasoning.js';
import { DEFAULT_TRANSCRIBE_MODEL } from './harness/adapters/media.js';
/** Telegram Bot API hard cap for one outbound text payload; longer text is
 * split into parts. Shared by the schema default and the validation upper
 * bound below (review 🟡-6). */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
export const DEFAULT_CONFIG = Object.freeze({
    security: { allowedChatIds: [] },
    watch: { autoStart: false },
    inbound: {
        defaultMode: 'auto-handle',
        rules: [],
    },
    outbound: {
        parseMode: 'HTML',
        disableNotification: false,
        maxRetries: 3,
        sendRatePerSecond: 20,
        maxMessageLength: TELEGRAM_MAX_MESSAGE_LENGTH,
        liveFeed: true,
    },
    compact: {
        threshold: 0.8,
        policy: 'ask',
        cooldownMs: 5 * 60_000,
    },
    workspace: {},
    mode: { name: '' },
    reasoning: { effort: REASONING_DEFAULT },
    model: {},
    media: { transcribe: { model: DEFAULT_TRANSCRIBE_MODEL } },
    interactive: { userQuestions: 'both', allowByTool: [] },
    notify: { onComplete: true, onLongTask: true },
});
/** Config errors carry a JSON-pointer-ish path so humans can fix `.pi/telegram.json`. */
export class ConfigError extends Error {
    path;
    constructor(path, message) {
        super(`${path}: ${message}`);
        this.name = 'ConfigError';
        this.path = path;
    }
}
const INBOUND_MODES = ['auto-handle', 'queue-only', 'muted'];
const QUESTION_OWNERSHIPS = ['telegram', 'web', 'both', 'auto'];
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function readString(record, key, path) {
    const value = record[key];
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string')
        throw new ConfigError(`${path}.${key}`, 'must be a string');
    return value;
}
function readNumber(record, key, path) {
    const value = record[key];
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ConfigError(`${path}.${key}`, 'must be a finite number');
    }
    return value;
}
function readBoolean(record, key, path) {
    const value = record[key];
    if (value === undefined)
        return undefined;
    if (typeof value !== 'boolean')
        throw new ConfigError(`${path}.${key}`, 'must be a boolean');
    return value;
}
function readIdArray(record, key, path) {
    const value = record[key];
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value))
        throw new ConfigError(`${path}.${key}`, 'must be an array of chat ids');
    return value.map((item, index) => {
        if (typeof item !== 'number' || !Number.isInteger(item)) {
            throw new ConfigError(`${path}.${key}[${index}]`, 'must be an integer chat id');
        }
        return item;
    });
}
function readStringArray(record, key, path) {
    const value = record[key];
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value))
        throw new ConfigError(`${path}.${key}`, 'must be an array of strings');
    return value.map((item, index) => {
        if (typeof item !== 'string' || item.trim() === '') {
            throw new ConfigError(`${path}.${key}[${index}]`, 'must be a non-empty string');
        }
        return item.trim();
    });
}
/** Merge raw (possibly partial) user config over defaults, validating every field. */
export function normalizeConfig(raw) {
    if (raw === undefined || raw === null)
        return cloneDefault();
    if (!isRecord(raw))
        throw new ConfigError('$', 'config root must be an object');
    const base = cloneDefault();
    const security = raw['security'];
    if (security !== undefined) {
        if (!isRecord(security))
            throw new ConfigError('security', 'must be an object');
        const ids = readIdArray(security, 'allowedChatIds', 'security');
        if (ids !== undefined)
            base.security.allowedChatIds = ids;
        const browseRoots = readStringArray(security, 'browseRoots', 'security');
        if (browseRoots !== undefined)
            base.security.browseRoots = browseRoots;
        // CF-1: strict boolean parse so a hand-edited "false"/"no"/0 is rejected
        // instead of silently re-opening the gate; absent stays absent.
        const selfAllow = readBoolean(security, 'selfAllow', 'security');
        if (selfAllow !== undefined)
            base.security.selfAllow = selfAllow;
    }
    const watch = raw['watch'];
    if (watch !== undefined) {
        if (!isRecord(watch))
            throw new ConfigError('watch', 'must be an object');
        const autoStart = readBoolean(watch, 'autoStart', 'watch');
        if (autoStart !== undefined)
            base.watch.autoStart = autoStart;
    }
    const inbound = raw['inbound'];
    if (inbound !== undefined) {
        if (!isRecord(inbound))
            throw new ConfigError('inbound', 'must be an object');
        const mode = readString(inbound, 'defaultMode', 'inbound');
        if (mode !== undefined) {
            if (!INBOUND_MODES.includes(mode)) {
                throw new ConfigError('inbound.defaultMode', `must be one of ${INBOUND_MODES.join(' | ')}`);
            }
            base.inbound.defaultMode = mode;
        }
        const rules = inbound['rules'];
        if (rules !== undefined) {
            if (!Array.isArray(rules))
                throw new ConfigError('inbound.rules', 'must be an array');
            base.inbound.rules = rules.map((rule, index) => {
                if (!isRecord(rule))
                    throw new ConfigError(`inbound.rules[${index}]`, 'must be an object');
                const chatId = readNumber(rule, 'chatId', `inbound.rules[${index}]`);
                if (chatId !== undefined && !Number.isInteger(chatId)) {
                    throw new ConfigError(`inbound.rules[${index}].chatId`, 'must be an integer chat id');
                }
                const pattern = readString(rule, 'pattern', `inbound.rules[${index}]`);
                if (pattern !== undefined && pattern.length === 0) {
                    throw new ConfigError(`inbound.rules[${index}].pattern`, 'must not be empty');
                }
                const mode = readString(rule, 'mode', `inbound.rules[${index}]`);
                if (mode === undefined || !INBOUND_MODES.includes(mode)) {
                    throw new ConfigError(`inbound.rules[${index}].mode`, `must be one of ${INBOUND_MODES.join(' | ')}`);
                }
                return { chatId, pattern, mode: mode };
            });
        }
    }
    const outbound = raw['outbound'];
    if (outbound !== undefined) {
        if (!isRecord(outbound))
            throw new ConfigError('outbound', 'must be an object');
        const liveFeed = readBoolean(outbound, 'liveFeed', 'outbound');
        if (liveFeed !== undefined)
            base.outbound.liveFeed = liveFeed;
        const parseMode = readString(outbound, 'parseMode', 'outbound');
        if (parseMode !== undefined) {
            if (parseMode !== 'HTML')
                throw new ConfigError('outbound.parseMode', "only 'HTML' is supported \u2014 assistant Markdown is normalized to HTML automatically");
            base.outbound.parseMode = 'HTML';
        }
        const disableNotification = readBoolean(outbound, 'disableNotification', 'outbound');
        if (disableNotification !== undefined)
            base.outbound.disableNotification = disableNotification;
        const maxRetries = readNumber(outbound, 'maxRetries', 'outbound');
        if (maxRetries !== undefined) {
            if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
                throw new ConfigError('outbound.maxRetries', 'must be an integer between 0 and 10');
            }
            base.outbound.maxRetries = maxRetries;
        }
        const rate = readNumber(outbound, 'sendRatePerSecond', 'outbound');
        if (rate !== undefined) {
            if (!(rate >= 1 && rate <= 30)) {
                throw new ConfigError('outbound.sendRatePerSecond', 'must be between 1 and 30');
            }
            base.outbound.sendRatePerSecond = rate;
        }
        const maxLength = readNumber(outbound, 'maxMessageLength', 'outbound');
        if (maxLength !== undefined) {
            if (!Number.isInteger(maxLength) || maxLength < 512 || maxLength > TELEGRAM_MAX_MESSAGE_LENGTH) {
                throw new ConfigError('outbound.maxMessageLength', `must be an integer between 512 and ${TELEGRAM_MAX_MESSAGE_LENGTH}`);
            }
            base.outbound.maxMessageLength = maxLength;
        }
    }
    const compact = raw['compact'];
    if (compact !== undefined) {
        if (!isRecord(compact))
            throw new ConfigError('compact', 'must be an object');
        const threshold = readNumber(compact, 'threshold', 'compact');
        if (threshold !== undefined) {
            if (!(threshold > 0 && threshold < 1))
                throw new ConfigError('compact.threshold', 'must be between 0 and 1 (exclusive)');
            base.compact.threshold = threshold;
        }
        const policy = readString(compact, 'policy', 'compact');
        if (policy !== undefined) {
            if (!['auto', 'ask', 'never'].includes(policy))
                throw new ConfigError('compact.policy', 'must be one of auto | ask | never');
            base.compact.policy = policy;
        }
        const cooldownMs = readNumber(compact, 'cooldownMs', 'compact');
        if (cooldownMs !== undefined) {
            if (!Number.isInteger(cooldownMs) || cooldownMs < 0)
                throw new ConfigError('compact.cooldownMs', 'must be a non-negative integer (ms)');
            base.compact.cooldownMs = cooldownMs;
        }
    }
    const workspace = raw['workspace'];
    if (workspace !== undefined) {
        if (!isRecord(workspace))
            throw new ConfigError('workspace', 'must be an object');
        const activePath = readString(workspace, 'activePath', 'workspace');
        if (activePath !== undefined)
            base.workspace.activePath = activePath;
    }
    const mode = raw['mode'];
    if (mode !== undefined) {
        if (!isRecord(mode))
            throw new ConfigError('mode', 'must be an object');
        const name = readString(mode, 'name', 'mode');
        if (name !== undefined)
            base.mode.name = name;
    }
    const reasoning = raw['reasoning'];
    if (reasoning !== undefined) {
        if (!isRecord(reasoning))
            throw new ConfigError('reasoning', 'must be an object');
        const effort = readString(reasoning, 'effort', 'reasoning');
        if (effort !== undefined) {
            if (!REASONING_EFFORTS.includes(effort)) {
                throw new ConfigError('reasoning.effort', 'must be one of minimal | low | medium | high | max');
            }
            base.reasoning = { effort: effort };
        }
    }
    const model = raw['model'];
    if (model !== undefined) {
        if (!isRecord(model))
            throw new ConfigError('model', 'must be an object');
        const provider = readString(model, 'provider', 'model');
        const name = readString(model, 'model', 'model');
        base.model = {
            ...(provider === undefined ? {} : { provider }),
            ...(name === undefined ? {} : { model: name }),
        };
    }
    const media = raw['media'];
    if (media !== undefined) {
        if (!isRecord(media))
            throw new ConfigError('media', 'must be an object');
        const transcribe = media['transcribe'];
        if (transcribe !== undefined) {
            if (!isRecord(transcribe))
                throw new ConfigError('media.transcribe', 'must be an object');
            const baseUrl = readString(transcribe, 'baseUrl', 'media.transcribe');
            const apiKey = readString(transcribe, 'apiKey', 'media.transcribe');
            const model = readString(transcribe, 'model', 'media.transcribe');
            base.media = {
                transcribe: {
                    ...(baseUrl === undefined ? {} : { baseUrl }),
                    ...(apiKey === undefined ? {} : { apiKey }),
                    ...(model === undefined ? {} : { model }),
                },
            };
        }
    }
    const interactive = raw['interactive'];
    if (interactive !== undefined) {
        if (!isRecord(interactive))
            throw new ConfigError('interactive', 'must be an object');
        const userQuestions = readString(interactive, 'userQuestions', 'interactive');
        if (userQuestions !== undefined && !QUESTION_OWNERSHIPS.includes(userQuestions)) {
            throw new ConfigError('interactive.userQuestions', `must be one of ${QUESTION_OWNERSHIPS.join(' | ')}`);
        }
        const allowByTool = readStringArray(interactive, 'allowByTool', 'interactive');
        base.interactive = {
            userQuestions: (userQuestions ?? base.interactive.userQuestions),
            allowByTool: allowByTool === undefined ? [...base.interactive.allowByTool] : [...new Set(allowByTool)],
        };
    }
    const notify = raw['notify'];
    if (notify !== undefined) {
        if (!isRecord(notify))
            throw new ConfigError('notify', 'must be an object');
        const onComplete = readBoolean(notify, 'onComplete', 'notify');
        const onLongTask = readBoolean(notify, 'onLongTask', 'notify');
        base.notify = {
            onComplete: onComplete ?? base.notify.onComplete,
            onLongTask: onLongTask ?? base.notify.onLongTask,
        };
    }
    return base;
}
function cloneDefault() {
    return {
        security: { allowedChatIds: [...DEFAULT_CONFIG.security.allowedChatIds] },
        watch: { autoStart: DEFAULT_CONFIG.watch.autoStart },
        inbound: {
            defaultMode: DEFAULT_CONFIG.inbound.defaultMode,
            rules: [...DEFAULT_CONFIG.inbound.rules],
        },
        outbound: { ...DEFAULT_CONFIG.outbound },
        compact: { ...DEFAULT_CONFIG.compact },
        workspace: { ...DEFAULT_CONFIG.workspace },
        mode: { ...DEFAULT_CONFIG.mode },
        reasoning: { ...DEFAULT_CONFIG.reasoning },
        model: { ...DEFAULT_CONFIG.model },
        media: { transcribe: { ...DEFAULT_CONFIG.media.transcribe } },
        interactive: { userQuestions: DEFAULT_CONFIG.interactive.userQuestions, allowByTool: [...DEFAULT_CONFIG.interactive.allowByTool] },
        notify: { ...DEFAULT_CONFIG.notify },
    };
}
/** First matching inbound rule for (chatId, text), otherwise the default mode. */
export function resolveInboundMode(config, chatId, text) {
    for (const rule of config.inbound.rules) {
        if (rule.chatId !== undefined && rule.chatId !== chatId)
            continue;
        if (rule.pattern !== undefined && !text.toLowerCase().includes(rule.pattern.toLowerCase()))
            continue;
        return rule.mode;
    }
    return config.inbound.defaultMode;
}
/** Whether inbound messages from this chat are accepted at all. */
export function isChatAllowed(config, chatId) {
    return config.security.allowedChatIds.includes(chatId);
}
/**
 * B-7r: optional root confinement for the host/workspace browse seams.
 * `undefined`/empty roots are a no-op (the default config keeps behavior
 * unchanged); otherwise `path` must resolve inside one of the roots — both
 * sides go through `resolve`, and the comparison uses `root + sep` so a
 * sibling directory that merely shares a prefix (`/a/home-evil` vs `/a/home`)
 * never slips through. Throws so adapters can degrade to their own fail text.
 */
export function assertBrowsable(path, roots) {
    if (roots === undefined || roots.length === 0)
        return;
    const target = resolve(path);
    for (const root of roots) {
        const base = resolve(root);
        const prefix = base.endsWith(sep) ? base : base + sep;
        if (target === base || target.startsWith(prefix))
            return;
    }
    throw new Error(`path is outside the configured security.browseRoots: ${path}`);
}
/**
 * Bot token comes only from the environment; the plugin itself never
 * persists it. For local checkouts that want the bridge to survive server
 * restarts without shell env wiring, `mountToken` (index.ts) falls back to a
 * gitignored `.telegram-token` file next to this package — the OPERATOR
 * writes that file once; the plugin only ever reads it.
 */
export function resolveToken(env = process.env) {
    const token = env['TELEGRAM_BOT_TOKEN'];
    if (token === undefined || token.trim() === '')
        return undefined;
    return token.trim();
}
/** Read one token file: whole-file trim, empty/absent file = no token. */
export function readTokenFile(path) {
    let raw;
    try {
        raw = readFileSync(path, 'utf8');
    }
    catch {
        return undefined;
    }
    const token = raw.trim();
    return token === '' ? undefined : token;
}
/**
 * Absolute path of the checkout-local fallback token file: `.telegram-token`
 * beside this package (`<pkg>/dist/config.js` → `<pkg>/.telegram-token`).
 * Anchored to the module URL, so it follows the real install location.
 */
export function packageTokenFile() {
    return join(resolve(dirname(fileURLToPath(import.meta.url))), '..', '.telegram-token');
}
/** Mount-time resolution order: explicit env, then a token file referenced
 * by `TELEGRAM_BOT_TOKEN_FILE`, then the checkout-local `.telegram-token`. */
export function mountToken(env = process.env) {
    const direct = resolveToken(env);
    if (direct !== undefined)
        return direct;
    const ref = env['TELEGRAM_BOT_TOKEN_FILE'];
    if (ref !== undefined && ref.trim() !== '') {
        const fromRef = readTokenFile(ref.trim());
        if (fromRef !== undefined)
            return fromRef;
    }
    return readTokenFile(packageTokenFile());
}
/** Path of the config file for a workspace root. */
export function configFilePath(workspaceRoot) {
    return join(workspaceRoot, '.pi', 'telegram.json');
}
/** Read + normalize config from a workspace root; missing file returns defaults. */
export function readConfig(workspaceRoot) {
    const file = configFilePath(workspaceRoot);
    let raw;
    try {
        raw = readFileSync(file, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return cloneDefault();
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        throw new ConfigError(file, `invalid JSON: ${error.message}`);
    }
    return normalizeConfig(parsed);
}
/** Persist config (pretty-printed) under `<root>/.pi/telegram.json`. */
export function writeConfig(workspaceRoot, config) {
    const file = configFilePath(workspaceRoot);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return file;
}
const CONFIG_SECTIONS = ["security", "watch", "inbound", "outbound", "compact", "mode", "workspace", "reasoning", "model", "media", "interactive", "notify"];
/**
 * Overlay a raw loader-provided config (from `ctx.config` / `internal/update`)
 * on top of an already-normalized config. Only keys present in the raw patch
 * are touched — the rest of the running config stays untouched (hot update).
 * Keys unknown to the schema are skipped (never written as `undefined`), and a
 * patched plain-object value overlays one level deeper so sibling leaves in
 * the running config survive (depth 2 covers the entire schema).
 */
export function overlayConfig(current, raw) {
    if (raw === undefined || raw === null || !isRecord(raw))
        return { config: current, changed: [] };
    const normalized = normalizeConfig(raw);
    const merged = { ...current };
    const changed = [];
    for (const section of CONFIG_SECTIONS) {
        const rawSection = raw[section];
        if (!isRecord(rawSection))
            continue;
        const normalizedSection = normalized[section];
        const out = { ...current[section] };
        let applied = false;
        for (const key of Object.keys(rawSection)) {
            const next = normalizedSection[key];
            if (next === undefined)
                continue; // unknown key: skip instead of writing undefined
            const prev = out[key];
            // CC-11: a no-op hot reload must not rewrite or report a section. Use
            // JSON.stringify for objects/arrays (deep-equal), strict-equal otherwise.
            const unchanged = (typeof next === "object" && next !== null && typeof prev === "object" && prev !== null)
                ? JSON.stringify(next) === JSON.stringify(prev)
                : next === prev;
            if (unchanged)
                continue;
            if (isRecord(next) && isRecord(prev)) {
                // Plain-object value (media.transcribe is the only one today): overlay
                // per sub-key so sibling leaves in the running config survive.
                const deep = { ...prev };
                for (const subKey of Object.keys(next))
                    deep[subKey] = next[subKey];
                out[key] = deep;
            }
            else {
                out[key] = next;
            }
            applied = true;
        }
        if (applied) {
            merged[section] = out;
            changed.push(section);
        }
    }
    return { config: merged, changed };
}
/** Read a config leaf by dot path (e.g. `outbound.sendRatePerSecond`). */
export function getConfigPath(config, path) {
    const parts = path.split(".").filter((part) => part !== "");
    let node = config;
    for (const part of parts) {
        if (!isRecord(node) && !Array.isArray(node))
            return undefined;
        node = node[part];
    }
    return node;
}
/** Build a nested patch object from a dot path + parsed JSON value. */
export function patchFromPath(path, value) {
    const parts = path.split(".").filter((part) => part !== "");
    const root = {};
    let node = root;
    for (const part of parts.slice(0, -1))
        node = node[part] = {};
    if (parts.length === 0)
        return root;
    node[parts[parts.length - 1]] = value;
    return root;
}
//# sourceMappingURL=config.js.map