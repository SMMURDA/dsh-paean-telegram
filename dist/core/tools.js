import { defineTool } from "@deepseek-ai/dsh-tools";
function textOutput() {
    return {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: value }],
    };
}
/** Register every built-in model tool. Called once by index.ts inside apply();
 * tool names, descriptions, parameters and result payloads are unchanged. */
export function registerTelegramTools(ctx, deps) {
    const { state, requireTransport, renderStatus, sendWorkspaceAttachments } = deps;
    ctx.tools.register(defineTool({
        name: "telegram_send",
        description: "Send an HTML message to one Telegram chat the bridge knows about.",
        parameters: {
            chatId: { type: "string", required: true, description: "Target chat id." },
            text: { type: "string", required: true, description: "Message body (HTML)." },
            disableNotification: { type: "boolean", description: "Send silently." },
        },
        output: textOutput(),
        async execute(args) {
            const chatId = Number(args.chatId);
            if (!Number.isInteger(chatId) || !state.chats.has(chatId)) {
                return JSON.stringify({ ok: false, error: `chat ${args.chatId} is not in the allowed roster` });
            }
            const t = requireTransport();
            const id = await t.sendText(chatId, args.text, {
                parse_mode: "HTML",
                disable_notification: args.disableNotification === true,
            });
            return JSON.stringify({ ok: true, messageId: id ?? null });
        },
    }));
    // Agent outbound attachments (#25). `telegram_attach` matches pi-telegram's
    // tool name for cross-project agent migration; `telegram_send_file` is the
    // original issue name kept as a drop-in alias.
    const attachToolParameters = {
        paths: {
            type: "array",
            required: true,
            items: { type: "string", description: "Workspace-relative file path (1-10 entries)." },
            description: "One or more local files under the workspace root.",
        },
        chatId: { type: "string", description: "Target chat id. Defaults to the executing agent's bound Telegram chat." },
        caption: { type: "string", description: "Optional caption shown above the file (HTML)." },
    };
    ctx.tools.register(defineTool({
        name: "telegram_attach",
        description: "Send 1-10 workspace files to a Telegram chat. Images (.jpg/.jpeg/.png) go as photos, .ogg/.opus as voice notes, other audio as audio, and everything else as a document. Paths outside the workspace root or chats outside the allowed roster are rejected.",
        parameters: attachToolParameters,
        output: textOutput(),
        async execute(args, exec) {
            return sendWorkspaceAttachments(args, exec);
        },
    }));
    ctx.tools.register(defineTool({
        name: "telegram_send_file",
        description: "Alias of telegram_attach: send 1-10 workspace files to a Telegram chat as photo/voice/audio/document by extension.",
        parameters: attachToolParameters,
        output: textOutput(),
        async execute(args, exec) {
            return sendWorkspaceAttachments(args, exec);
        },
    }));
    ctx.tools.register(defineTool({
        name: "telegram_reply",
        description: "Reply to the current inbound Telegram message. Fails when there is no pending inbound message.",
        parameters: {
            text: { type: "string", required: true, description: "Reply body (HTML)." },
            disableNotification: { type: "boolean", description: "Send silently." },
        },
        output: textOutput(),
        async execute(args, exec) {
            const bridge = state.bridge;
            // Route by the calling agent, not by the most-recently-touched chat:
            // two sessions in two chats may run telegram_reply concurrently.
            const agentId = exec.agent?.id === undefined ? undefined : String(exec.agent.id);
            const inbound = agentId !== undefined ? bridge?.inboundForAgent(agentId) : undefined;
            if (!bridge || !inbound)
                throw new Error(agentId === undefined ? "no agent context for telegram_reply" : "no active inbound message");
            await bridge.sendOutbound(inbound.chatId, args.text, {
                replyToInbound: true,
                parseMode: "HTML",
                disableNotification: args.disableNotification === true,
            });
            return JSON.stringify({ ok: true, chatId: inbound.chatId });
        },
    }));
    ctx.tools.register(defineTool({
        name: "telegram_broadcast",
        description: "Send the same HTML message to several Telegram chats concurrently.",
        parameters: {
            targets: {
                type: "array",
                required: true,
                items: {
                    type: "object",
                    additionalProperties: false,
                    properties: { chatId: { type: "string", required: true, description: "Target chat id." } },
                },
            },
            text: { type: "string", required: true, description: "Message body (HTML)." },
        },
        output: textOutput(),
        async execute(args) {
            const t = requireTransport();
            const targets = args.targets.map((x) => x.chatId).filter((x) => typeof x === "string");
            const results = await Promise.all(targets.map(async (chatId) => {
                const numeric = Number(chatId);
                if (!Number.isInteger(numeric) || !state.chats.has(numeric)) {
                    return { chatId, ok: false, error: "chat is not in the allowed roster" };
                }
                try {
                    const id = await t.sendText(numeric, args.text, { parse_mode: "HTML" });
                    return { chatId, ok: true, messageId: id ?? null };
                }
                catch (err) {
                    return { chatId, ok: false, error: err instanceof Error ? err.message : String(err) };
                }
            }));
            return JSON.stringify({ ok: results.length > 0 && results.every((r) => r.ok), results });
        },
    }));
    ctx.tools.register(defineTool({
        name: "telegram_status",
        description: "Report the bridge's current state: bot connectivity, agent status, inbox queue, and known chats.",
        parameters: {},
        output: textOutput(),
        async execute() {
            return renderStatus();
        },
    }));
    ctx.tools.register(defineTool({
        name: "telegram_mark_no_reply",
        description: "Mark the current inbound Telegram message as intentionally not replied.",
        parameters: {
            reason: { type: "string", description: "Optional reason (not sent to the chat)." },
        },
        output: textOutput(),
        async execute(args, exec) {
            const bridge = state.bridge;
            const agentId = exec.agent?.id === undefined ? undefined : String(exec.agent.id);
            const inbound = agentId !== undefined ? bridge?.inboundForAgent(agentId) : undefined;
            if (!bridge || !inbound)
                return JSON.stringify({ ok: false, text: agentId === undefined ? "no agent context for telegram_mark_no_reply" : "no active inbound message for this agent" });
            return JSON.stringify(bridge.markNoReply(args.reason ?? undefined, inbound.chatId));
        },
    }));
}
//# sourceMappingURL=tools.js.map