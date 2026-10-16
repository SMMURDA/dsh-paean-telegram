/**
 * Slash-command implementations for dsh-telegram (yellow-1 step 4).
 *
 * Every substantive /command body that used to be inlined in dispatchCommand
 * lives here as one function; dispatchCommand (core/dispatch.ts) resolves the
 * command word and hands over the per-invocation CommandCall bundle plus the
 * shared DispatchDeps. Thin delegations (cases that only route into the
 * action registry or a card opener) stayed inline in the dispatcher.
 *
 * Bodies are verbatim moves: bare names resolve through one destructure of
 * the call bundle and the deps object, exactly like the former closures over
 * dispatchCommand locals. Purely structural layer — may import harness/,
 * telegram/, config.js and sibling core modules; never index.ts.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { TelegramTransport } from "../telegram/transport.js";
import type { DispatchDeps } from "./dispatch.js";
/** Per-invocation values dispatchCommand computes once for every command and
 * passes to the extracted implementations below (its own locals, bundled). */
export interface CommandCall {
    /** Chat the command came from. */
    chatId: number;
    /** Canonical command word (no slash); distinguishes enable/disable text. */
    command: string;
    /** Raw argument tail after the command word. */
    args: string;
    /** message_id of the inbound command message, when the router saw one. */
    messageId?: number;
    /** Attached dsh context (requireCtx() at dispatch time). */
    ctx: Context;
    /** The chat's live agent, if any. */
    agent: Agent | undefined;
    /** Live transport (requireTransport() at dispatch time). */
    t: TelegramTransport;
    /** The dispatcher's logging reply wrapper: plain text on success, ❌-prefixed
     * HTML on failure. */
    send(text: string, okResult?: boolean): Promise<void>;
}
/** Complete Telegram command menu. Exported so index.ts can sync it to
 * Telegram's native Menu button (`setMyCommands`) on every transport mount,
 * not only on `/start` — clients cache the list, so a bot restart otherwise
 * leaves a stale menu until someone happens to run /start again.
 * EVERY entry here must have a dispatchCommand case (or an extension
 * handler): the native menu advertises exactly this list. */
export declare const TELEGRAM_COMMANDS: {
    command: string;
    description: string;
}[];
/** /start — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function startCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /help — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function helpCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /answer — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function answerCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /cancel — body moved verbatim from the former
 * dispatchCommand switch case. B-4r: cancels the chat's armed pending input
 * whatever its kind; the four kinds that previously had no cancel path now
 * answer with consistent texts instead of "Nothing to cancel.". */
export declare function cancelCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /pluginadd — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function pluginAddCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /bar — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function barCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /menucheck — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function menuSelfCheckCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
export declare function maskConfigValue(path: string, value: unknown): string;
/** /config — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function configCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /history — turn-grouped trajectory (issue #32). Two upgrades:
 * 1. No id and nothing bound no longer hard-fails — it falls back to the
 *    most recent session ("none bound" after a bot restart left the command
 *    dead for the one use case that matters: catch up on the latest work).
 * 2. Plain `/history` opens the LIVE History card, which re-renders itself
 *    on every turn/end (hot reload) and carries Load older / Session nav.
 *    The legacy static text path stays for an explicit `[turns]` argument. */
export declare function historyCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /search — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function searchCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /rename — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function renameCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /fork — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function forkCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /use — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function useCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /archive — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function archiveCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /steer — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function steerCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /queueedit — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function queueEditCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /goal / /goalcreate — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function goalCreateCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /goaledit — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function goalEditCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /goalclear — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function goalClearCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /workspacecreate — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function workspaceCreateCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /workspacerename — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function workspaceRenameCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /workspacepin — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function workspacePinCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /pluginenable / /plugindisable — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function pluginToggleCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /settingsdescribe — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function settingsDescribeCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /settingsupdate — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function settingsUpdateCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /settingsreplace — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function settingsReplaceCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /settingsmutate — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function settingsMutateCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /credential — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function credentialDescribeCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /credentialset — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function credentialSetCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /credentialunset — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function credentialUnsetCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /ls — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function lsCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /attachment — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function attachmentCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /mkdir — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function mkdirCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /pickdir — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function pickdirCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /openpath — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function openpathCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /discover — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function discoverCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /subagentprompt — body moved verbatim from the former
 * dispatchCommand switch case. B-4r: kind-filtered take so an input of
 * another kind stays armed instead of being swallowed here. */
export declare function subagentpromptCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /sessionlog — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function sessionlogCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
/** /commands — body moved verbatim from the former
 * dispatchCommand switch case. */
export declare function commandsListCommand(deps: DispatchDeps, c: CommandCall): Promise<void>;
