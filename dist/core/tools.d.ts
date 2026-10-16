/**
 * Model-tool registration for dsh-telegram.
 *
 * Registers the agent-facing tools on `ctx.tools`:
 *   telegram_send / telegram_reply / telegram_broadcast / telegram_status /
 *   telegram_mark_no_reply, plus the outbound attachment pair
 *   telegram_attach / telegram_send_file (handlers from media/attachments).
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. All plugin-root singletons
 * arrive through one deps object provided by index.ts at the original
 * registration site inside apply().
 */
import type { Context } from "@deepseek-ai/cordis";
import { type ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { Bridge } from "../harness/bridge.js";
import type { TelegramTransport } from "../telegram/transport.js";
/** Structural slice of the plugin-root state singleton this module reads. */
interface ToolsStateSlice {
    /** Chats that passed the whitelist gate (roster checks for send/broadcast). */
    readonly chats: Set<number>;
    /** Chat↔agent bridge (inbound routing for reply / mark-no-reply). */
    readonly bridge: Bridge | undefined;
}
export interface TelegramToolsDeps {
    state: ToolsStateSlice;
    requireTransport(): TelegramTransport;
    renderStatus(): string;
    sendWorkspaceAttachments(args: {
        paths?: unknown;
        chatId?: unknown;
        caption?: unknown;
    }, exec: ToolRunContext): Promise<string>;
}
/** Register every built-in model tool. Called once by index.ts inside apply();
 * tool names, descriptions, parameters and result payloads are unchanged. */
export declare function registerTelegramTools(ctx: Context, deps: TelegramToolsDeps): void;
export {};
