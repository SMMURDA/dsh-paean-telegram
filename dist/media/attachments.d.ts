import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { TelegramConfig } from "../config.js";
import type { Bridge } from "../harness/bridge.js";
import { type SessionLifecycle } from "../harness/adapters/sessions.js";
import type { TelegramTransport } from "../telegram/transport.js";
/** Structural slice of the plugin-root state singleton this module reads.
 * index.ts passes its live `state` object; hot-applied config and rebinding
 * are observed through the same reference without rewiring. */
interface AttachmentStateSlice {
    /** Chats that passed the whitelist gate (roster checks + delivery targets). */
    readonly chats: Set<number>;
    /** Active project root; outbound paths must stay inside it. */
    workspaceRoot: string;
    /** Live config (model default, media.transcribe). */
    config: TelegramConfig;
    /** Chat↔agent bridge (delivery + reverse lookups). Undefined while unmounted. */
    readonly bridge: Bridge | undefined;
}
export interface AttachmentHandlersDeps {
    state: AttachmentStateSlice;
    requireTransport(): TelegramTransport;
    requireCtx(): Context;
    uiSend(chatId: number, text: string, options?: Parameters<TelegramTransport["sendText"]>[2]): Promise<number | undefined>;
    currentAgent(chatId?: number): Agent | undefined;
    createSessionForChat(chatId: number, model?: {
        provider?: string;
        model?: string;
    }, agentPreset?: string, onlyIfUnbound?: boolean): Promise<ReturnType<SessionLifecycle["create"]>>;
    bindCreatedSession(chatId: number, agentId: string | undefined): boolean;
    scheduleBarSync(chatId: number, delayMs?: number): void;
}
/** Build the outbound + inbound attachment handlers. Called once by index.ts;
 * every handler closes over the shared deps like the previous module-scope
 * closures did over index.ts singletons. */
export declare function makeAttachmentHandlers(deps: AttachmentHandlersDeps): {
    sendWorkspaceAttachments: (args: {
        paths?: unknown;
        chatId?: unknown;
        caption?: unknown;
    }, exec: ToolRunContext) => Promise<string>;
    ensureChatAgent: (chatId: number) => Promise<Agent | undefined>;
    dispatchPhoto: (chatId: number, fileId: string, caption: string, messageId?: number) => Promise<void>;
    dispatchPhotos: (chatId: number, photos: readonly {
        fileId: string;
        caption: string;
        messageId?: number;
    }[]) => Promise<void>;
    dispatchDocument: (chatId: number, kind: "document" | "voice" | "video", fileId: string, name: string, mimeType: string, messageId?: number) => Promise<void>;
};
export {};
