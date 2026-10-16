/**
 * Routing layer for dsh-telegram (yellow-1 step 4).
 *
 * The four dispatch surfaces — token callbacks (t:\d+ payloads), raw callback
 * data (m:/s:/w:/q:/mo:/set:/h:/p:/ap:/qu:), persistent-bar buttons and slash
 * commands — plus the cross-surface action registry live here. Slash-command
 * implementations live in ./commands.ts and are called from dispatchCommand.
 *
 * Plugin-root layer: may import ./harness/..., ./telegram/..., ../cards/...
 * and sibling core modules; never media/, never index.ts. Every plugin-root
 * singleton and card opener arrives through one DispatchDeps object provided
 * once by index.ts (createDispatchers); bodies are moved verbatim from the
 * former index.ts closures, so bare names resolve through one destructure.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { type ConfigSection, type TelegramConfig } from "../config.js";
import type { Bridge } from "../harness/bridge.js";
import { SessionLifecycle } from "../harness/adapters/sessions.js";
import type { TelegramExtension, ExtensionHost } from "../extensions/types.js";
import { type Interactive } from "../harness/adapters/interactive.js";
import { CompactionWatcher } from "../harness/adapters/compaction-watch.js";
import { TokenRegistry } from "../telegram/tokens.js";
import { Ephemeral, type ChatOps } from "../telegram/ephemeral.js";
import type { TelegramTransport } from "../telegram/transport.js";
import type { PendingInput, PendingInputSpec } from "./chat-hub.js";
import { type CardLoad, type OpenCard } from "./cards.js";
import type { createModelCards } from "../cards/models.js";
import type { createMiscCards } from "../cards/misc.js";
import type { createSessionCards } from "../cards/sessions.js";
import type { createQueueCards } from "../cards/queue.js";
import type { createWorkspaceCards } from "../cards/workspaces.js";
import type { createGoalCards } from "../cards/goals.js";
import type { createPresetCards } from "../cards/presets.js";
import type { createHostCards } from "../cards/host.js";
/** Exact opener/loader shapes returned by the cards/* factories wired in
 * index.ts; deps fields borrow them so signatures cannot drift. */
type ModelCards = ReturnType<typeof createModelCards>;
type MiscCards = ReturnType<typeof createMiscCards>;
type SessionCards = ReturnType<typeof createSessionCards>;
type QueueCards = ReturnType<typeof createQueueCards>;
type WorkspaceCards = ReturnType<typeof createWorkspaceCards>;
type GoalCards = ReturnType<typeof createGoalCards>;
type PresetCards = ReturnType<typeof createPresetCards>;
type HostCards = ReturnType<typeof createHostCards>;
/** Structural slice of the plugin-root state singleton the routing layer
 * touches. `config` stays writable: /config hot-applies a new object and the
 * model-select tap persists the chosen default model into it. */
export interface DispatchStateSlice {
    readonly workspaceRoot: string;
    /** Boot workspace owning .pi/telegram.json (config never moves). */
    readonly configRoot: string;
    config: TelegramConfig;
    readonly bridge: Bridge | undefined;
    readonly interactive: Interactive | undefined;
    watching: boolean;
    readonly chats: Set<number>;
    readonly barCollapsed: Map<number, boolean>;
}
export type ActionOrigin = "token" | "callback" | "bar" | "command";
export type ActionReply = (text: string, ok?: boolean) => Promise<void>;
/** RA-2: the context carries only fields every entry actually reads — the
 * former dead `payload?`/`args?`/`messageId?` slots (never read by any
 * entry, never attached by dispatchCallback) are gone; re-add a field the
 * day an entry consumes it. `"token"` is live since RA-1 wired the
 * new-default token face. */
export interface ActionContext {
    chatId: number;
    origin: ActionOrigin;
    reply: ActionReply;
}
/** Everything the routing layer closes over, provided once by index.ts.
 * Singletons/registries pass whole; hub containers and card openers pass by
 * reference so destructured dispatch code mutates the same live state. */
export interface DispatchDeps {
    state: DispatchStateSlice;
    /** Plugin version (welcome text). */
    version: string;
    /** Live-session lifecycle (stop/close/create/adopt/find). */
    sessionLifecycle: SessionLifecycle;
    /** Transient-card lane (close/back clear the chat's card message). */
    ephemeral: Ephemeral;
    /** Single-use callback-token registry ("t:<id>" callbacks). */
    tokens: TokenRegistry;
    /** Context-pressure compaction watcher; assigned on transport mount, so it
     * must be read through this getter at dispatch time (issue #8). */
    compactionWatcher(): CompactionWatcher | undefined;
    log(message: string, error?: unknown): void;
    requireTransport(): TelegramTransport;
    requireCtx(): Context;
    uiSend(chatId: number, text: string, options?: Parameters<TelegramTransport["sendText"]>[2]): Promise<number | undefined>;
    uiOps(t: TelegramTransport): ChatOps;
    currentAgent(chatId?: number): Agent | undefined;
    boundAgentId(chatId?: number): string | undefined;
    createSessionForChat(chatId: number, model?: {
        provider?: string;
        model?: string;
    }, agentPreset?: string, onlyIfUnbound?: boolean): Promise<ReturnType<SessionLifecycle["create"]>>;
    bindCreatedSession(chatId: number, agentId: string | undefined): boolean;
    applyConfigLive(changed: readonly ConfigSection[]): void;
    refreshAllPanels(): void;
    sendWithLiveBar(chatId: number, text: string, options?: Parameters<TelegramTransport["sendText"]>[2]): Promise<number | undefined>;
    scheduleBarSync(chatId: number, delayMs?: number): void;
    setBarCollapsed(chatId: number, collapsed: boolean): void;
    startWatching(): Promise<void>;
    stopWatching(): Promise<void>;
    openStatusPanel(chatId: number): Promise<void>;
    openMenuAt(chatId: number, page: number): Promise<void>;
    extensionForCallback(action: string): {
        extension: TelegramExtension;
        handler: NonNullable<TelegramExtension["callbacks"]>[string];
    } | undefined;
    extensionForCommand(command: string): {
        extension: TelegramExtension;
        handler: NonNullable<TelegramExtension["commands"]>[string];
    } | undefined;
    extensionForBar(label: string): {
        extension: TelegramExtension;
        handler: NonNullable<TelegramExtension["barButtons"]>[string];
    } | undefined;
    buildExtensionHost(): ExtensionHost;
    activeCardRenderers: Map<number, () => Promise<void>>;
    openCard: OpenCard;
    askConfirm(chatId: number, text: string, confirmPayload: Record<string, string>, cancelPayload: Record<string, string>): Promise<void>;
    cardLoad: CardLoad;
    menuPageIndex: Map<number, number>;
    cardOrigins: Map<number, "menu" | "bar">;
    /** B-4r per-chat pending-input store: commands/dispatch arm free-text
     * flows, onUserText consumes them, /cancel cancels them. */
    armPending(chatId: number, input: PendingInputSpec): void;
    takePending(chatId: number, kind?: PendingInput["kind"]): PendingInput | undefined;
    cancelPending(chatId: number): PendingInput["kind"] | undefined;
    pendingStartAfterAllow: Set<number>;
    abortChatLoops(chatId: number): void;
    stopTodoCardRefresh(chatId: number): void;
    lastProjectKey: SessionCards["lastProjectKey"];
    openSessionsCard: SessionCards["openSessionsCard"];
    openSessionProjectsCard: SessionCards["openSessionProjectsCard"];
    openSessionDetailCard: SessionCards["openSessionDetailCard"];
    openHistoryCard: SessionCards["openHistoryCard"];
    openSearchCard: SessionCards["openSearchCard"];
    openQueueCard: QueueCards["openQueueCard"];
    openWorkspacesCard: WorkspaceCards["openWorkspacesCard"];
    openWorkspaceDetailCard: WorkspaceCards["openWorkspaceDetailCard"];
    openProjectCard: WorkspaceCards["openProjectCard"];
    applyProjectPath: WorkspaceCards["applyProjectPath"];
    openWorkspaceCreatePicker: WorkspaceCards["openWorkspaceCreatePicker"];
    openTodosCard: GoalCards["openTodosCard"];
    openGoalsCard: GoalCards["openGoalsCard"];
    openNewSessionCard: PresetCards["openNewSessionCard"];
    openPresetsCard: PresetCards["openPresetsCard"];
    openPresetDetailCard: PresetCards["openPresetDetailCard"];
    openHostSettingsCard: HostCards["openHostSettingsCard"];
    openSettingsNamespaceCard: HostCards["openSettingsNamespaceCard"];
    openCredentialsCard: HostCards["openCredentialsCard"];
    openHostCard: HostCards["openHostCard"];
    openHostDirectoryCard: HostCards["openHostDirectoryCard"];
    openModelsCard: ModelCards["openModelsCard"];
    openProvidersCard: ModelCards["openProvidersCard"];
    openProviderModelsCard: ModelCards["openProviderModelsCard"];
    openModelThinkingCard: ModelCards["openModelThinkingCard"];
    openPluginsCard: MiscCards["openPluginsCard"];
    openSkillsCard: MiscCards["openSkillsCard"];
    openSubagentsCard: MiscCards["openSubagentsCard"];
    isContinuableSubagent: MiscCards["isContinuableSubagent"];
    openSubagentDetailCard: MiscCards["openSubagentDetailCard"];
    openJobsCard: MiscCards["openJobsCard"];
    openDynamicCordisCard: MiscCards["openDynamicCordisCard"];
    openCapabilitiesCard: MiscCards["openCapabilitiesCard"];
    openFeedbackListCard: MiscCards["openFeedbackListCard"];
    openModeCard: MiscCards["openModeCard"];
    openAllowedCard: MiscCards["openAllowedCard"];
    openWatchCard: MiscCards["openWatchCard"];
    openSettingsCard: MiscCards["openSettingsCard"];
    openAboutCard: MiscCards["openAboutCard"];
}
/** Build the routing layer. Called once by index.ts; the returned dispatchers
 * close over the shared deps exactly like the former module-scope closures
 * closed over index.ts locals. Bodies are verbatim moves. */
export declare function createDispatchers(deps: DispatchDeps): {
    dispatchToken(chatId: number, payload: Record<string, string>): Promise<void>;
    dispatchCallback(chatId: number, data: string): Promise<void>;
    dispatchBarButton(chatId: number, label: string): Promise<void>;
    dispatchCommand(chatId: number, command: string, args: string, messageId?: number): Promise<void>;
};
export {};
