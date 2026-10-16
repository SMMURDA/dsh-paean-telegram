/**
 * Reasoning-effort extension (codex-telegram-bot semantics): fixed five
 * levels, directive prepended to inbound messages by the bridge, per-chat
 * effort persisted in the telegram config.
 *
 * Loaded as a harness-style plugin: either built into the core (index.ts
 * registers it directly) or through a loader entry such as
 * `dsh-telegram/extensions/reasoning`, which calls this apply() and lets the
 * profile disable it independently (/plugindisable telegram-reasoning).
 */
import type { Context } from "@deepseek-ai/cordis";
import type { TelegramExtension } from "./types.js";
export declare const reasoningExtension: TelegramExtension;
/** Harness plugin entry: `dsh-telegram/extensions/reasoning` loader entry.
 * Hot-pluggable: on loader disable/unload the effect disposer unregisters the
 * extension and the core refreshes the UI immediately. */
export declare const inject: string[];
export declare function apply(ctx: Context, _config?: unknown): void;
