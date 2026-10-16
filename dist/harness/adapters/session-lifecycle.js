/**
 * Stateful session operations, mirroring the web ApiProxy `sessions` domain
 * (session.create/rename/fork/prompt/models/selectModel/attachment/
 * updateQueue + the Telegram-side delete) over the host seams: ctx.agents,
 * ctx.llm, ctx.attachments, ctx.agentDefaultModel, and the agent-preset
 * roster. Read-only queries live in session-read.ts; pure display helpers in
 * session-render.ts; sessions.ts re-exports the whole family.
 *
 * Destruction trunk: the tracked agent handles, the per-session model
 * selections, and the saved-attachment refs are module-level registries.
 * Every destroy path — SessionLifecycle.close, deleteSession, and plugin
 * teardown — funnels through the same release calls (🟠-14).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { agentsOf, sessionById, sessionEvents, sessionTitleService, sessionsOf, textOfContent } from "./session-read.js";
import { ensureOpencodeGoResponsesRoute, normalizeOpencodeGoModel, opencodeGoModelUsesResponses } from "./opencodeGo.js";
import { fail, ok } from "./types.js";
function agentPresetsOf(ctx) {
    return ctx.get("agentPresets");
}
function attachmentsOf(ctx) {
    return ctx.get("attachments");
}
function defaultModelOf(ctx) {
    return ctx.get("agentDefaultModel");
}
/** Per-session entry (#SL-1): `agentCtx` records WHICH agent-scoped context
 * the listeners were installed on, so an out-of-band agent replacement under
 * the same session id can be detected instead of reused blindly. */
const selections = new Map();
/** The agent-scoped cordis context our selection listeners mount on, or
 * undefined for handles that carry none (test doubles, pre-publish agents). */
function contextOf(agent) {
    return agent?.ctx;
}
/**
 * Install (or reuse) this plugin's per-session ModelSelectionRef on one
 * agent-scoped context. The install MUST happen as early as possible in the
 * agent's life — cordis waterfalls run listeners outermost-first, so the
 * FIRST-installed selection listener wins over any later one. The web API
 * proxy installs its own selection ref when IT creates or resumes a session;
 * if that happens before our first mid-session switch, our override would be
 * shadowed and every Telegram-side model switch would silently lose to the
 * web's stale value ("switched once, then never again"). Installing at
 * creation/adopt time pins our listener outermost for every session we own;
 * a disposed entry is re-installed fresh rather than silently dead.
 */
function ensureSelectionEntry(sessionId, agentCtx) {
    const existing = selections.get(sessionId);
    if (existing !== undefined && existing.disposed !== true) {
        // #SL-1: reuse is only safe while the stored listeners still belong to
        // THIS agent's context. An out-of-band replacement under the same session
        // id (web API proxy resuming the session from a browser, host loop
        // replacing a crashed agent) leaves the old entry writing to a dead
        // context where ref updates reach nothing — the tap reported ✅ while the
        // switch silently no-op'd forever. A context mismatch is therefore
        // treated exactly like a disposed entry: dispose the stale one, install
        // fresh here. Re-installing on the SAME context must never happen — it
        // would enqueue behind the web proxy's ref and lose the outermost-first
        // waterfall — so identity, not liveness, gates the reuse branch.
        if (existing.agentCtx === agentCtx)
            return existing;
        existing.dispose();
    }
    const ref = { current: undefined, assembled: undefined };
    const rawDispose = installModelSelection(agentCtx, ref);
    const entry = {
        ref,
        agentCtx,
        disposed: false,
        dispose: () => {
            entry.disposed = true;
            rawDispose();
        },
    };
    selections.set(sessionId, entry);
    return entry;
}
/** Install the selection ref from a creation/resume setup hook (best-effort:
 * an agent context that refuses listeners must not fail session creation). */
function setupSelectionInstall(sessionId) {
    return (agentCtx) => {
        try {
            ensureSelectionEntry(sessionId, agentCtx);
        }
        catch (err) {
            console.error(`[dsh-telegram] model-selection install skipped for ${sessionId}`, err);
        }
        return Promise.resolve();
    };
}
/** #SL-1 defect 2: the last selection this bridge APPLIED per session id.
 * Unlike `selections` it survives the resume-time release: a resume swaps the
 * agent identity under a stable session id, and a switch that raced (or
 * preceded) the swap must converge onto the NEW instance instead of being
 * lost with the released pre-resume entry. Cleared only on real destruction
 * paths — close(), deleteSession(), plugin teardown. */
const appliedSelections = new Map();
/** Forget the remembered selection on a real destroy path. Deliberately NOT
 * part of `releaseModelSelection`: the resume path calls that mid-swap and
 * must KEEP the memory to re-assert it on the resumed agent (#SL-1 defect 2),
 * while close/delete must wipe it so a later session reusing the id starts
 * clean (destruction-trunk semantics). */
function forgetAppliedSelection(sessionId) {
    appliedSelections.delete(sessionId);
}
/** Re-pin our outermost selection ref on a freshly resumed agent instance and
 * re-assert the last applied switch (#SL-1 defect 2). Best-effort, mirroring
 * setupSelectionInstall: an agent context that refuses listeners must not
 * fail the resume. Reinstating immediately — instead of waiting for adopt()
 * or the next tap — keeps us FIRST in the outermost-first waterfall before
 * the web API proxy can mount its own ref on the new instance; a same-
 * identity re-entry (the adopt() that usually follows) reuses the entry, so
 * no second listener pair is ever created. */
function reinstateSelectionAfterResume(sessionId, handle) {
    try {
        const agentCtx = contextOf(handle.agent);
        if (agentCtx === undefined)
            return;
        const entry = ensureSelectionEntry(sessionId, agentCtx);
        const applied = appliedSelections.get(sessionId);
        if (applied !== undefined) {
            entry.ref.current = {
                provider: applied.provider,
                model: applied.model,
                ...(applied.reasoningEffort === undefined ? {} : { reasoningEffort: applied.reasoningEffort }),
            };
        }
    }
    catch (err) {
        console.error(`[dsh-telegram] model-selection reinstall skipped for resumed ${sessionId}`, err);
    }
}
/** session.selectModel: per-session ModelSelectionRef + default persistence. */
export async function selectSessionModel(ctx, sessionId, provider, model, reasoningEffort) {
    const agents = agentsOf(ctx);
    const agent = agents?.get(SessionId(sessionId));
    if (!agent)
        return fail(`session ${sessionId} has no live agent`);
    // `ctx.get("llm")`, not `ctx.llm`: this plugin's inject list does not
    // include "llm", and direct property access throws `cannot get property
    // "llm" without inject` in strict Cordis contexts.
    const llm = ctx.get("llm");
    if (!llm)
        return fail("llm service is unavailable in this profile");
    try {
        const selected = normalizeOpencodeGoModel(provider, model);
        if (opencodeGoModelUsesResponses(provider, model)) {
            const ready = await ensureOpencodeGoResponsesRoute(ctx, (message, error) => console.error(`[dsh-telegram] ${message}`, error ?? ""));
            if (!ready) {
                return fail(`${selected.provider} route is not registered in the llm registry \u2014 restart dsh so the newly persisted route loads, then tap again`);
            }
        }
        const resolved = await llm.resolveCallConfig({ provider: selected.provider, model: selected.model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) });
        // #SL-1: the route-setup and resolve awaits above open a window for a
        // concurrent resume/close (both card buttons on the same chat, nothing
        // serializes them) to replace or drop the agent this switch was validated
        // against — applying blindly landed the value on an orphaned ref while
        // the tap already reported ✅. Chosen semantics: RE-APPLY to whatever
        // agent is live now. Re-ensuring the entry on its context also repairs an
        // out-of-band replacement, so the user's confirmed switch survives a
        // restart instead of costing a second tap; only a session that vanished
        // entirely fails, and then honestly. The ref write below is synchronous
        // behind this check, so no disposal can slip between validation and apply.
        const liveAgent = agentsOf(ctx)?.get(SessionId(sessionId));
        const liveCtx = contextOf(liveAgent);
        if (liveCtx === undefined) {
            return fail(`session ${sessionId} was restarted while the switch was in flight \u2014 try again`);
        }
        // Reuse the creation-time entry when present and still ours; a missing,
        // previously disposed, or stale-context entry is re-installed fresh so
        // the switch always has live listeners to flow through.
        const entry = ensureSelectionEntry(sessionId, liveCtx);
        entry.ref.current = {
            provider: resolved.provider,
            model: resolved.model,
            ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
        };
        // #SL-1 defect 2: remember what was applied so a resume swapping the
        // agent identity underneath can re-assert it on the replacement.
        appliedSelections.set(sessionId, {
            provider: resolved.provider,
            model: resolved.model,
            ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
        });
        const defaults = defaultModelOf(ctx);
        try {
            await defaults?.saveSelection({
                provider: resolved.provider,
                model: resolved.model,
                ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
            });
        }
        catch {
            /* the switch applies to this session even when the default is not saved */
        }
        return ok(`\u{1F4CE} Model switched to ${resolved.provider}/${resolved.model}`);
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}
/** session.models.current: the per-session selection or the live agent default. */
export function currentSessionModel(ctx, sessionId) {
    const entry = selections.get(sessionId);
    const agent = agentsOf(ctx)?.get(SessionId(sessionId));
    if (entry !== undefined && entry.disposed !== true && entry.ref.current !== undefined) {
        // #SL-1: an entry whose listeners were installed on another agent's
        // context belongs to a replaced agent — serving its value would report
        // the dead instance's model. Release it exactly like a disposed entry and
        // fall through to the live agent's own options. With no live agent there
        // is nothing to compare against, so the pre-#SL-1 serve-the-entry
        // behavior stays (close/delete paths release explicitly).
        const liveCtx = contextOf(agent);
        if (liveCtx === undefined || entry.agentCtx === liveCtx) {
            return entry.ref.current;
        }
        releaseModelSelection(sessionId);
    }
    if (!agent)
        return {};
    return { provider: agent.options?.provider, model: agent.options?.model };
}
export function releaseModelSelection(sessionId) {
    const entry = selections.get(sessionId);
    if (!entry)
        return;
    entry.dispose();
    selections.delete(sessionId);
}
export function releaseAllModelSelections() {
    // Teardown forgets the applied-selection memory too: nothing may re-assert
    // a switch after the plugin is gone (#SL-1 defect 2).
    appliedSelections.clear();
    for (const [sessionId, entry] of selections) {
        entry.dispose();
        selections.delete(sessionId);
    }
}
/** session/queue snapshot (the web's events.mux `session/queue` frame). */
export function listQueue(ctx, sessionId) {
    const agents = agentsOf(ctx);
    const agent = agents?.get(SessionId(sessionId));
    if (!agent)
        return [];
    const inbox = agent.inbox;
    const out = [];
    for (const message of inbox.nextTurn)
        out.push({ itemId: message.id, target: "next-turn", text: textOfContent(message.content) });
    for (const message of inbox.nextStep)
        out.push({ itemId: message.id, target: "next-step", text: textOfContent(message.content) });
    return out;
}
/** session.updateQueue over agent.inbox (exact web semantics). */
export function updateQueueItem(ctx, sessionId, itemId, action) {
    const agents = agentsOf(ctx);
    const agent = agents?.get(SessionId(sessionId));
    if (!agent)
        return fail("queue-item-not-found: no live agent");
    const inbox = agent.inbox;
    const target = inbox.nextTurn.some((m) => m.id === itemId) ? "next-turn" : inbox.nextStep.some((m) => m.id === itemId) ? "next-step" : undefined;
    if (target === undefined)
        return fail("queue-item-not-found: item is no longer pending");
    const message = target === "next-turn" ? inbox.nextTurn.find((m) => m.id === itemId) : inbox.nextStep.find((m) => m.id === itemId);
    if (!message)
        return fail("queue-item-not-found: item is no longer pending");
    if (action.kind === "steer") {
        const status = agent.status;
        if (target !== "next-turn" || status !== "running")
            return fail("steer-unavailable: current turn no longer accepts steering");
    }
    if (action.kind === "edit") {
        inbox.replace(itemId, { ...message, content: [{ type: "text", text: action.content }] });
    }
    else {
        inbox.remove(itemId);
        if (action.kind === "steer")
            agent.steer(message);
    }
    return ok("Queue updated.");
}
/** Durable refs for images this bridge saved; `ctx.attachments.readImage`
 * verifies the exact recorded ref, so a read-back must use the real one. */
const savedAttachments = new Map();
/** session.attachment admission: promote image bytes, mirroring the web gate. */
export async function saveImageAttachment(ctx, data, mediaType, name) {
    const attachments = attachmentsOf(ctx);
    if (!attachments)
        return fail("attachments service is unavailable in this profile");
    try {
        const ref = await attachments.saveImage({ data, mediaType, ...(name === undefined ? {} : { name }) });
        savedAttachments.set(String(ref.attachmentId), ref);
        if (savedAttachments.size > 500) {
            const oldest = savedAttachments.keys().next().value;
            if (oldest !== undefined)
                savedAttachments.delete(oldest);
        }
        return { ok: true, text: `\u{1F5BC} Attachment ${ref.attachmentId}`, attachment: ref };
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}
/** session.attachment read (base64, same as the web response). The web seam
 * verifies bytes against the exact durable ref, so only attachments this
 * bridge saved can be read back through Telegram. */
export async function readImageAttachment(ctx, attachmentId) {
    const attachments = attachmentsOf(ctx);
    if (!attachments)
        return fail("attachments service is unavailable in this profile");
    const ref = savedAttachments.get(attachmentId);
    if (!ref)
        return fail(`attachment ${attachmentId} was not saved by this bridge (send a photo first)`);
    try {
        const stored = await attachments.readImage(ref);
        return {
            ok: true,
            text: `\u{1F5BC} ${attachmentId} (${stored.data.byteLength} bytes)`,
            data: Buffer.from(stored.data).toString("base64"),
            mediaType: stored.ref.mediaType,
        };
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}
/** Plugin teardown: drop the in-memory ref registry (durable refs stay). */
export function releaseSavedAttachments() {
    savedAttachments.clear();
}
/** session.rename over ctx.sessionTitle (the web's exact seam). */
export function renameSession(ctx, sessionId, title) {
    const session = sessionById(ctx, sessionId);
    if (!session)
        return fail(`session ${sessionId} is not live (rename needs a live session)`);
    const titles = sessionTitleService(ctx);
    if (!titles)
        return fail("this profile mounts no session-title service");
    const trimmed = title.trim();
    if (!trimmed)
        return fail("title must not be blank");
    try {
        const accepted = titles.rename(session, trimmed);
        return ok(`\u270F Renamed to "${accepted.title}"`);
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}
/** session.fork over ctx.sessions.fork (web semantics: boundary anchors to turn ends). */
export function forkSession(ctx, sessionId, atSeq) {
    const store = sessionsOf(ctx);
    if (!store)
        return fail("sessions service is unavailable in this profile");
    try {
        const source = sessionById(ctx, sessionId);
        if (!source)
            return fail(`session ${sessionId} not found`);
        const events = sessionEvents(source);
        const lastSeq = events.length ? events[events.length - 1].seq : -1;
        let boundary;
        if (atSeq !== undefined) {
            const found = events.find((e) => e.type === "turn/end" && e.seq >= atSeq);
            if (found)
                boundary = found.seq;
            else if (atSeq > lastSeq)
                boundary = [...events].reverse().find((e) => e.type === "turn/end")?.seq;
            if (boundary === undefined)
                return fail("fork-unavailable: no turn boundary at that position");
        }
        const child = store.fork(SessionId(sessionId), boundary, SessionId(`telegram-${randomUUID()}`));
        return { ok: true, text: `\u{1F500} Forked to ${child.id}`, childId: child.id };
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}
/** Resume a persisted session as a live agent (session.open equivalent).
 * `inheritFrom` names the live agent whose provider/model the resumed agent
 * inherits. Without it the source is only resolvable when exactly ONE live
 * agent exists: among several, defaulting to list()[0] could inherit another
 * chat's model, so the request fails instead of guessing (🟠-17). */
export async function resumeSession(ctx, sessionId, inheritFrom) {
    const agents = agentsOf(ctx);
    if (!agents)
        return fail("agents service is unavailable in this profile");
    try {
        const live = agents.list();
        const previous = inheritFrom !== undefined
            ? live.find((agent) => String(agent.id) === String(inheritFrom)) ?? agents.get?.(SessionId(inheritFrom))
            : live.length === 1 ? live[0] : undefined;
        if (inheritFrom !== undefined && previous === undefined) {
            return fail(`cannot inherit provider/model: ${inheritFrom} has no live agent`);
        }
        if (previous === undefined && live.length > 1) {
            return fail(`${live.length} live sessions are running \u2014 cannot tell whose provider/model to inherit`);
        }
        // A resume replaces the AGENT object under this session id. Any selection
        // entry still keyed here points at the dead instance's listeners: updating
        // its ref would silently no-op every later switch ("switched once, then
        // never again" on resumed sessions). Drop it so the reinstatement below /
        // adopt()/the next tap installs a fresh ref on the new agent instead.
        releaseModelSelection(sessionId);
        const handle = await agents.resume({
            resumeSessionId: SessionId(sessionId),
            agentOptions: { provider: previous?.options?.provider, model: previous?.options?.model },
        });
        // #SL-1 defect 2: don't leave the new identity unpinned until some future
        // tap — reinstate our outermost ref NOW and re-assert the last applied
        // switch, so a tap that raced (or preceded) this resume converges onto
        // the post-resume agent instead of being lost with the released
        // pre-resume entry. No-op when Telegram never switched this id (fresh
        // ids, forked children): the inherited agentOptions stay authoritative.
        reinstateSelectionAfterResume(sessionId, handle);
        return { ok: true, text: `\u{1F4C2} Resumed ${handle.agent.id}`, agentId: handle.agent.id, handle };
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}
/** session.prompt: route text to queue or steer, mirroring the web modes. */
export function promptSession(ctx, sessionId, text, mode) {
    const agents = agentsOf(ctx);
    const agent = agents?.get(SessionId(sessionId));
    if (!agent)
        return fail(`session ${sessionId} has no live agent`);
    const message = createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
    const target = agent;
    try {
        if (mode === "steer")
            target.steer(message);
        else if (mode === "queue")
            target.send(message, "next-turn", false);
        else
            target.followup(message);
        return ok(mode === "queue" ? "Queued." : mode === "steer" ? "Steered." : "Delivered.");
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}
/** Session-directory segment encoding (mirrors the JSONL backend's
 * `encodeSegment`: safe path segment, `--` wrapped, separators folded). */
function encodeSegment(text) {
    let readable = "";
    let separatorRun = true;
    for (const ch of text) {
        if (ch === "/" || ch === "\\" || ch === "\u0000") {
            separatorRun = true;
            continue;
        }
        if (separatorRun) {
            readable += "~";
            separatorRun = false;
        }
        if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
            readable += ch;
            separatorRun = false;
        }
        else {
            readable += `~${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
            separatorRun = false;
        }
    }
    return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}
/**
 * Owns the agents this plugin created through `/new` so they can be torn down
 * (and persisted by the session-persistence plugins) when their OWN chat
 * replaces them. Creation never disposes a global "previous" agent anymore:
 * chat A's session must survive chat B pressing `✨ New`.
 */
/** Disposing a replaced agent is cleanup, not a user operation: a hung
 * dispose must not wedge the per-chat session-create chain (LOOP_AUDIT #6). */
const AGENT_DISPOSE_TIMEOUT_MS = 10_000;
function disposeWithin(dispose, label) {
    let timer;
    return Promise.race([
        dispose.then(() => undefined, () => undefined),
        new Promise((resolve) => {
            timer = setTimeout(() => {
                console.error(`[dsh-telegram] ${label} dispose timed out after ${AGENT_DISPOSE_TIMEOUT_MS}ms`);
                resolve();
            }, AGENT_DISPOSE_TIMEOUT_MS);
        }),
    ]).finally(() => {
        if (timer !== undefined)
            clearTimeout(timer);
    });
}
/** Destruction trunk for agent handles this plugin created or adopted. One
 * SessionLifecycle instance exists per process (index.ts), so the registry
 * lives beside `selections`/`savedAttachments` at module level and
 * close()/deleteSession()/teardown share ONE bookkeeping table — deleteSession
 * must never leave handle residue behind (🟠-14). */
const handles = new Map();
/** Claim and drop the tracked handle for `agentId`, if any. */
function takeTrackedHandle(agentId) {
    const handle = handles.get(agentId);
    if (handle !== undefined)
        handles.delete(agentId);
    return handle;
}
/** Delete one session entirely: dispose its live agent, drop the in-memory
 * model selection, and remove its durable session directory. There is no web
 * RPC for this — it is a Telegram-side convenience. */
export async function deleteSession(ctx, sessionId) {
    // D-1: the raw id feeds `join(root, project, candidate)` and `rm -rf` below,
    // and the token payload it arrives in can be forged by any authorized chat.
    // Sanitize BEFORE any filesystem work: "" would collapse the path to the
    // project directory itself, and `..`/separators could escape the sessions
    // root. Legal internal ids contain none of these shapes, so they pass
    // byte-for-byte; `encodeSegment` candidates below stay unchanged.
    const safeId = sessionId.replace(/[/\\]/g, "_").slice(0, 200);
    if (sessionId === "" || sessionId === "." || sessionId === ".." || safeId !== sessionId.trim()) {
        return fail(`invalid session id: ${JSON.stringify(sessionId.slice(0, 50))}`);
    }
    // 🟠-14: disposal funnels through SessionLifecycle's own bookkeeping —
    // claim the tracked handle first (so plugin teardown sees no residue) and
    // dispose it through the same guarded path as close(); only untracked
    // agents fall back to the registry dispose. The model selection is
    // released unconditionally (`releaseModelSelection` is idempotent), which
    // also cleans the leak left when the agent is already gone.
    const tracked = takeTrackedHandle(sessionId);
    if (tracked !== undefined) {
        await disposeWithin(tracked.dispose().catch((err) => console.error("[dsh-telegram] failed to dispose agent", err)), sessionId);
    }
    else {
        const agent = agentsOf(ctx)?.get(SessionId(sessionId));
        if (agent) {
            await agent.dispose().catch(() => { });
        }
    }
    releaseModelSelection(sessionId);
    // Real destruction: the remembered switch must not resurrect on a later
    // session reusing this id (#SL-1 defect 2).
    forgetAppliedSelection(sessionId);
    const { dshHome } = await import("./mode.js");
    const root = join(dshHome(), "sessions");
    // Backends have used both `encodeSegment(id)` (wrapped `--…--`) and the raw
    // id as the session directory name; delete whichever one exists.
    const candidates = [...new Set([encodeSegment(sessionId), sessionId])];
    let removed = false;
    try {
        for (const project of await readdir(root, { withFileTypes: true })) {
            if (!project.isDirectory())
                continue;
            for (const candidate of candidates) {
                const dir = join(root, project.name, candidate);
                if (existsSync(dir)) {
                    await rm(dir, { recursive: true, force: true });
                    removed = true;
                }
            }
        }
    }
    catch {
        /* scan errors are non-fatal */
    }
    return ok(`\u{1F5D1} Session ${sessionId} deleted${removed ? "" : " (no stored files)"}.`);
}
export class SessionLifecycle {
    /**
     * Create a session, mirroring web `session.create`:
     * - `model` (optional telegram-owned default) overrides the profile default
     *   (`ctx.agentDefaultModel.currentSelection()`), so prompt assembly always
     *   has a `{{model}}` value.
     * - `agentPreset` (optional) is resolved BEFORE the agent exists and mounted
     *   through the creation `setup` hook; the resolved id is recorded on the
     *   session header. Omitted = the roster's default preset (or no setup when
     *   the profile composes no preset roster).
     * - `replaceSessionId` (optional) names the agent THIS chat is leaving; only
     *   that agent is disposed after the new one publishes. Other chats' agents
     *   are never touched.
     */
    async create(ctx, cwd, model, options) {
        if (!ctx.agents)
            return { result: fail("agents service is unavailable in this profile") };
        const sessionId = SessionId(`telegram-${randomUUID()}`);
        const defaultModel = ctx.get("agentDefaultModel")?.currentSelection();
        const presets = agentPresetsOf(ctx);
        let resolvedPreset;
        let presetSetup;
        if (presets !== undefined) {
            try {
                const resolve = presets.resolve?.bind(presets) ?? ((id) => Promise.resolve({ id: id ?? presets.defaultId ?? "default" }));
                resolvedPreset = (await resolve(options?.agentPreset)).id;
                presetSetup = async (agentCtx) => {
                    await presets.mount(agentCtx, resolvedPreset);
                };
            }
            catch (err) {
                return { result: fail(err instanceof Error ? err.message : String(err)) };
            }
        }
        else if (options?.agentPreset !== undefined) {
            return { result: fail("this profile composes no agent presets") };
        }
        // The per-session model selection installs in the creation setup hook —
        // BEFORE any preset mount and before the web API proxy could ever install
        // its own ref on this session later. Cordis waterfalls run listeners
        // outermost-first, so being first is what keeps a Telegram-side model
        // switch authoritative over a web-side stale override for this session's
        // whole life.
        const setup = async (agentCtx) => {
            setupSelectionInstall(String(sessionId))(agentCtx);
            await presetSetup?.(agentCtx);
        };
        try {
            const handle = await ctx.agents.create({
                sessionId,
                meta: {
                    cwd,
                    ...(resolvedPreset === undefined ? {} : { agentPreset: resolvedPreset }),
                },
                agentOptions: {
                    provider: model?.provider ?? defaultModel?.provider,
                    model: model?.model ?? defaultModel?.model,
                },
                setup,
            });
            console.error(`[dsh-telegram] session create model=${handle.agent.options.model} provider=${handle.agent.options.provider} preset=${resolvedPreset ?? "-"} (telegram config: ${model?.provider ?? "-"}/${model?.model ?? "-"})`);
            handles.set(handle.agent.id, handle);
            const replaced = options?.replaceSessionId;
            if (replaced !== undefined && replaced !== handle.agent.id) {
                // close() owns the model-selection release for every destroy path
                // that passes through it.
                await this.close(replaced, ctx).catch((err) => console.error("[dsh-telegram] failed to dispose replaced agent", err));
            }
            return {
                result: ok(`\u2728 New session ${handle.agent.id} in ${cwd}`),
                agentId: handle.agent.id,
                ...(resolvedPreset === undefined ? {} : { agentPreset: resolvedPreset }),
            };
        }
        catch (err) {
            // The setup hook may have installed a selection ref for a session that
            // never published: drop it so the registry cannot leak the id.
            releaseModelSelection(String(sessionId));
            return { result: fail(err instanceof Error ? err.message : String(err)) };
        }
    }
    /** Resolve a live agent by id (agent id === session id). */
    find(ctx, agentId) {
        return ctx.agents?.get(SessionId(agentId));
    }
    /** Track a handle this plugin did not create (e.g. a resumed fork). The
     * model-selection ref installs here too: an adopted agent's first switch
     * must stay outermost, exactly like a created one. */
    adopt(handle) {
        handles.set(handle.agent.id, handle);
        try {
            const agentCtx = contextOf(handle.agent);
            if (agentCtx !== undefined)
                ensureSelectionEntry(String(handle.agent.id), agentCtx);
        }
        catch (err) {
            console.error(`[dsh-telegram] model-selection install skipped for adopted ${String(handle.agent.id)}`, err);
        }
    }
    /** Close (dispose) one live agent. Tracked handles are preferred; a live
     * agent this plugin adopted externally falls back to its own dispose. The
     * per-session model selection is released here so every destroy path that
     * funnels through close() drops it exactly once (`releaseModelSelection`
     * is idempotent; deleteSession claims the tracked handle through the same
     * trunk and releases the selection itself). */
    async close(agentId, ctx) {
        releaseModelSelection(agentId);
        // Real destruction (🟠-14 trunk): forget the applied-selection memory
        // alongside the entry so nothing re-asserts a dead session's switch.
        forgetAppliedSelection(agentId);
        const handle = takeTrackedHandle(agentId);
        if (handle !== undefined) {
            await disposeWithin(handle.dispose().catch((err) => console.error("[dsh-telegram] failed to dispose agent", err)), agentId);
            return ok(`\u23F9 Closed ${agentId}`);
        }
        const live = ctx !== undefined ? agentsOf(ctx) : undefined;
        const agent = live?.get(SessionId(agentId));
        if (agent === undefined)
            return fail(`no disposal handle for agent ${agentId}`);
        await disposeWithin(agent.dispose().catch((err) => console.error("[dsh-telegram] failed to dispose agent", err)), agentId);
        return ok(`\u23F9 Closed ${agentId}`);
    }
    /** Cancel the current turn of one agent (defaults to the only live agent).
     * `keepInbox: true` preserves queued messages: only the in-flight turn is
     * aborted, the session and its pending work stay alive. With several live
     * agents the default is refused — cancelling list()[0] could kill another
     * chat's turn (🟠-17). */
    stop(ctx, agentId) {
        const agents = ctx.agents?.list() ?? [];
        const agent = agentId !== undefined
            ? agents.find((a) => String(a.id) === String(agentId))
            : agents.length === 1 ? agents[0] : undefined;
        if (!agent) {
            if (agentId !== undefined)
                return fail("no live agent in this session");
            if (agents.length > 1)
                return fail(`${agents.length} live sessions are running \u2014 stop needs an explicit session id`);
            return ok("Nothing is running.");
        }
        agent.cancel({ kind: "user" }, { keepInbox: true });
        return ok("\u23F9 Stopping the current turn \u2014 queued messages are kept.");
    }
    /** Plugin teardown: dispose every agent this plugin created or adopted. */
    async dispose() {
        const pending = [...handles.values()];
        handles.clear();
        await Promise.all(pending.map((handle) => handle.dispose().catch(() => { })));
    }
}
//# sourceMappingURL=session-lifecycle.js.map