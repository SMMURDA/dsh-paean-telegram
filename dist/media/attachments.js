/**
 * Media/attachment handlers for dsh-telegram.
 *
 * Outbound: agent-requested workspace file delivery (issue #25), routed to
 * sendPhoto/sendVoice/sendAudio/sendDocument by file extension.
 * Inbound: photo / media-group / document / voice dispatch into the bridge.
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. All plugin-root singletons
 * (state, transport/ctx accessors, UI seams) arrive through one deps object
 * so this module owns no mutable wiring of its own.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { saveImageAttachment } from "../harness/adapters/sessions.js";
import { saveDocumentAttachment, transcribeVoice } from "../harness/adapters/media.js";
import { plain } from "../telegram/html.js";
/** Agent outbound attachments (issue #25): 1-10 workspace files, 50MB each,
 * routed to sendPhoto/sendVoice/sendAudio/sendDocument by file extension. */
const ATTACH_MAX_COUNT = 10;
/** Telegram's upload ceiling for one attachment (Bot API `sendDocument`).
 * Exported so `media/image-refs.ts` can keep its mirrors honest in tests. */
export const ATTACH_MAX_BYTES = 50 * 1024 * 1024;
/** Telegram photos (sendPhoto) cap at 10MB; larger jpg/jpeg/png must route
 * through sendDocument instead (RF-4 / AT-1 fix 2). */
const ATTACH_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const ATTACH_PHOTO_EXTENSIONS = new Set(["jpg", "jpeg", "png"]);
const ATTACH_VOICE_EXTENSIONS = new Set(["ogg", "opus"]);
const ATTACH_AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac", "wav", "flac"]);
function attachExtension(filename) {
    const dot = filename.lastIndexOf(".");
    return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}
function attachWithinWorkspace(root, target) {
    return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
/**
 * Upload explicit workspace files to one chat.
 *
 * Shared by the `telegram_attach` tool, final-answer image delivery in the
 * streaming renderer, AND the core forwarder that takes over when the live
 * feed is disabled — so the workspace-escape guard, the size cap and the
 * extension→method routing live in exactly one place.
 */
export async function uploadWorkspaceFiles(transport, workspaceRoot, chatId, files, caption) {
    // RF-4 / AT-1 fix 1: normalize the workspace root once through realpath so
    // symlink escapes are caught. On realpath failure we fall back to the plain
    // resolved path (matching the previous behaviour) rather than refusing.
    const resolvedRoot = resolve(workspaceRoot);
    const root = await realpath(resolvedRoot).catch(() => resolvedRoot);
    const results = [];
    for (const rel of files) {
        try {
            const abs = resolve(root, rel);
            // Resolve each candidate real path; a symlink pointing outside the
            // workspace must be rejected. Fall back to the unresolved path on error.
            const real = await realpath(abs).catch(() => abs);
            if (!attachWithinWorkspace(root, real)) {
                results.push({ path: rel, ok: false, error: "path resolves outside the workspace root (symlink escape)" });
                continue;
            }
            const info = await stat(real);
            if (!info.isFile()) {
                results.push({ path: rel, ok: false, error: "not a file" });
                continue;
            }
            if (info.size > ATTACH_MAX_BYTES) {
                results.push({ path: rel, ok: false, error: `exceeds the ${ATTACH_MAX_BYTES / (1024 * 1024)}MB Telegram limit` });
                continue;
            }
            const buffer = await readFile(real);
            const filename = basename(abs);
            const ext = attachExtension(filename);
            const sendCaption = typeof caption === "string" && caption !== "" ? caption : undefined;
            let method;
            let messageId;
            if (ATTACH_PHOTO_EXTENSIONS.has(ext) && info.size <= ATTACH_PHOTO_MAX_BYTES) {
                method = "sendPhoto";
                messageId = await transport.sendPhoto(chatId, buffer, filename, sendCaption);
            }
            else if (ATTACH_VOICE_EXTENSIONS.has(ext)) {
                method = "sendVoice";
                messageId = await transport.sendVoice(chatId, buffer, filename, sendCaption);
            }
            else if (ATTACH_AUDIO_EXTENSIONS.has(ext)) {
                method = "sendAudio";
                messageId = await transport.sendAudio(chatId, buffer, filename, sendCaption);
            }
            else {
                // Includes jpg/jpeg/png over 10MB (sendPhoto would fail): route via
                // sendDocument instead (AT-1 fix 2).
                method = "sendDocument";
                messageId = await transport.sendDocument(chatId, buffer, filename, sendCaption);
            }
            results.push({ path: rel, ok: messageId !== undefined, method, messageId: messageId ?? null, bytes: buffer.length });
        }
        catch (err) {
            results.push({ path: rel, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
    }
    return results;
}
/** Build the outbound + inbound attachment handlers. Called once by index.ts;
 * every handler closes over the shared deps like the previous module-scope
 * closures did over index.ts singletons. */
export function makeAttachmentHandlers(deps) {
    const { state, requireTransport, requireCtx, uiSend, currentAgent, createSessionForChat, bindCreatedSession, scheduleBarSync } = deps;
    /**
     * Upload explicit workspace files to one chat.
     *
     * The `telegram_attach` tool and final-answer image delivery both go through
     * here, so the workspace-escape guard, the size cap and the
     * extension→method routing live in exactly one place.
     */
    async function sendFilesToChat(chatId, files, caption) {
        return { results: await uploadWorkspaceFiles(requireTransport(), state.workspaceRoot, chatId, files, caption) };
    }
    async function sendWorkspaceAttachments(args, exec) {
        const paths = Array.isArray(args.paths) ? args.paths.filter((entry) => typeof entry === "string") : [];
        if (!Array.isArray(args.paths))
            return JSON.stringify({ ok: false, error: "paths must be an array of 1-10 workspace-relative file paths" });
        if (paths.length < 1 || paths.length > ATTACH_MAX_COUNT) {
            return JSON.stringify({ ok: false, error: `paths must contain 1-10 entries, got ${paths.length}` });
        }
        const agentId = exec.agent?.id === undefined ? undefined : String(exec.agent.id);
        const fallbackAgentId = agentId ?? state.bridge?.currentAgentIdValue();
        const resolvedChat = args.chatId !== undefined ? Number(args.chatId) : (fallbackAgentId !== undefined ? state.bridge?.chatIdForAgent(fallbackAgentId) : undefined);
        if (resolvedChat === undefined || !Number.isInteger(resolvedChat) || !state.chats.has(resolvedChat)) {
            return JSON.stringify({
                ok: false,
                error: args.chatId !== undefined
                    ? `chat ${args.chatId} is not in the allowed roster`
                    : "no bound Telegram chat context \u2014 pass chatId explicitly",
            });
        }
        // Delegated: the upload loop (escape guard, size cap, format routing)
        // lives in sendFilesToChat so final-answer images share it exactly.
        const { results } = await sendFilesToChat(resolvedChat, paths, args.caption);
        return JSON.stringify({ ok: results.length > 0 && results.every((entry) => entry.ok), results });
    }
    /** Ensure this chat has a live agent for media delivery; first media starts
     * its own session, same as first text. */
    async function ensureChatAgent(chatId) {
        let agent = currentAgent(chatId);
        if (agent)
            return agent;
        const created = await createSessionForChat(chatId, state.config.model, undefined, true);
        if (!created.result.ok || created.agentId === undefined) {
            await uiSend(chatId, `\u274C ${plain(created.result.text)}`, { parse_mode: "HTML" });
            return undefined;
        }
        bindCreatedSession(chatId, created.agentId);
        agent = currentAgent(chatId);
        if (!agent)
            await uiSend(chatId, "\u274C No live agent in this session.", { parse_mode: "HTML" });
        return agent;
    }
    async function dispatchPhoto(chatId, fileId, caption, messageId) {
        return dispatchPhotos(chatId, [{ fileId, caption, messageId }]);
    }
    /** Media-group batch: N images become ONE user turn (issue #9). */
    async function dispatchPhotos(chatId, photos) {
        const t = requireTransport();
        const agent = await ensureChatAgent(chatId);
        if (!agent)
            return;
        const downloads = await Promise.all(photos.slice(0, 10).map(async (photo) => ({ ...photo, data: await t.downloadFile(photo.fileId) })));
        if (downloads.some((photo) => !photo.data)) {
            await uiSend(chatId, "\u274C One or more photo downloads failed \u2014 nothing was delivered.", { parse_mode: "HTML" });
            return;
        }
        const attachments = [];
        for (const photo of downloads) {
            const saved = await saveImageAttachment(requireCtx(), photo.data, "image/jpeg", `telegram-${photo.fileId}.jpg`);
            if (!saved.ok || !saved.attachment) {
                // Partial batch (B14): nothing was delivered, and the durable
                // attachment store is append-only — no delete seam exists to free
                // already-committed bytes. Release what CAN be released: surface the
                // surviving refs to the user so they stay reachable through
                // /attachment instead of stranding silent, unreachable orphans.
                const savedIds = attachments.map((entry) => entry.attachmentId);
                const suffix = savedIds.length > 0 ? `\n\u{1F5BC} Already saved (${savedIds.length}): /attachment ${plain(savedIds.join(" "))}` : "";
                await uiSend(chatId, `\u274C ${plain(saved.text)}${suffix}`, { parse_mode: "HTML" });
                return;
            }
            attachments.push(saved.attachment);
        }
        const caption = photos.map((photo) => photo.caption).find((entry) => entry.trim() !== "") ?? "";
        const firstId = photos[0]?.messageId;
        const res = state.bridge?.deliverImages(chatId, attachments, caption, firstId);
        if (res && !res.ok)
            await uiSend(chatId, `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
        else {
            await uiSend(chatId, `\u{1F4F7} ${plain(res?.text ?? "Images delivered.")} \u00B7 ${attachments.length} images \u00B7 /attachment ${plain(attachments.map((entry) => entry.attachmentId).join(" "))}`, { parse_mode: "HTML" });
            scheduleBarSync(chatId, 0);
        }
    }
    async function dispatchDocument(chatId, kind, fileId, name, mimeType, messageId) {
        const t = requireTransport();
        const agent = await ensureChatAgent(chatId);
        if (!agent)
            return;
        const data = await t.downloadFile(fileId);
        if (!data) {
            await uiSend(chatId, `\u274C ${plain(kind)} download failed.`, { parse_mode: "HTML" });
            return;
        }
        if (kind === "voice") {
            const transcribed = await transcribeVoice(data, "voice.ogg", state.config.media?.transcribe);
            if (!transcribed.ok || transcribed.transcript === undefined) {
                // AT-1 fix 3: transcription failure is no longer a dead end. Save the
                // voice bytes to the session so the agent can still reach them, notify
                // the chat with the saved path, and hand the agent a prompt carrying
                // both the path and the transcription failure reason. Do NOT deliver
                // the failed transcript as a user message.
                const failureReason = transcribed.text ?? "voice transcription failed";
                const saved = await saveDocumentAttachment(agent.id, data, `voice-${Date.now()}.ogg`);
                if (!saved.ok || saved.path === undefined) {
                    await uiSend(chatId, `\u274C ${plain(failureReason)} \u2014 and saving the voice file also failed: ${plain(saved.text)}`, { parse_mode: "HTML" });
                    return;
                }
                await uiSend(chatId, `\u{1F4CE} ${plain(failureReason)} \u2014 saved voice to ${plain(saved.path)}`, { parse_mode: "HTML" });
                const prompt = `\u{1F399}\uFE0F Voice transcription failed (${failureReason}). The original voice file was saved to ${saved.path} \u2014 read/process it directly.`;
                const delivered = state.bridge.deliver(chatId, prompt, messageId);
                if (!delivered.ok)
                    await uiSend(chatId, `\u274C ${plain(delivered.text)}`, { parse_mode: "HTML" });
                else
                    scheduleBarSync(chatId, 0);
                return;
            }
            await uiSend(chatId, `\u{1F399}\uFE0F Transcript: ${plain(transcribed.transcript)}`, { parse_mode: "HTML" });
            const delivered = state.bridge.deliver(chatId, transcribed.transcript, messageId);
            if (!delivered.ok)
                await uiSend(chatId, `\u274C ${plain(delivered.text)}`, { parse_mode: "HTML" });
            else
                scheduleBarSync(chatId, 0);
            return;
        }
        const saved = await saveDocumentAttachment(agent.id, data, name || `${kind}.bin`);
        if (!saved.ok || saved.path === undefined) {
            await uiSend(chatId, `\u274C ${plain(saved.text)}`, { parse_mode: "HTML" });
            return;
        }
        await uiSend(chatId, plain(saved.text), { parse_mode: "HTML" });
        const prompt = `\u{1F4CE} Telegram ${kind} saved to ${saved.path} (${data.byteLength} bytes, ${mimeType || "unknown type"}) \u2014 read and process it.`;
        const delivered = state.bridge.deliver(chatId, prompt, messageId);
        if (!delivered.ok)
            await uiSend(chatId, `\u274C ${plain(delivered.text)}`, { parse_mode: "HTML" });
        else
            scheduleBarSync(chatId, 0);
    }
    return { sendWorkspaceAttachments, sendFilesToChat, ensureChatAgent, dispatchPhoto, dispatchPhotos, dispatchDocument };
}
//# sourceMappingURL=attachments.js.map