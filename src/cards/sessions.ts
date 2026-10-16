/**
 * Sessions / projects / history / search cards for dsh-telegram.
 *
 * The session browser chain: web-style ordered project groups
 * (sessionProjectSnapshot), the paginated Sessions roster (openSessionsCard),
 * the project switcher (openSessionProjectsCard), per-session detail
 * (openSessionDetailCard), the turn-grouped trajectory view (openHistoryCard)
 * and full-text search (openSearchCard).
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. All plugin-root singletons
 * arrive through one deps object so this module owns no mutable wiring of
 * its own.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Bridge } from "../harness/bridge.js";
import {
  displayTitleFor,
  groupSessionsByProject,
  listSessionDetails,
  orderProjectGroups,
  searchSessions,
  readTrajectory,
  type ProjectGroup,
  type SessionDetail,
} from "../harness/adapters/sessions.js";
import { listWorkspaces } from "../harness/adapters/workspace.js";
import type { TelegramTransport } from "../telegram/transport.js";
import { escapeHtml, plain, truncate } from "../telegram/html.js";
import { bold, headerLine, metaJoin, mono, relTime } from "../telegram/ui.js";
import { renderTrajectoryLines } from "../telegram/trajectory.js";
import {
  buildHistoryKeyboard,
  buildSearchKeyboard,
  buildSessionDetailKeyboard,
  buildSessionProjectsKeyboard,
  buildSessionsKeyboard,
} from "../telegram/keyboard.js";
import type { CardLoad, OpenCard } from "../core/cards.js";

/** Structural slice of the plugin-root state singleton this module reads. */
interface SessionCardsStateSlice {
  /** Chat↔agent bridge (bound-agent highlight + reverse lookups). Undefined while unmounted. */
  readonly bridge: Bridge | undefined;
  /** Last project key shown on the per-chat Sessions card (back navigation). */
  readonly lastSessionsProject: Map<number, string>;
}

export interface SessionCardsDeps {
  state: SessionCardsStateSlice;
  requireCtx(): Context;
  cardLoad: CardLoad;
  openCard: OpenCard;
  uiSend(chatId: number, text: string, options?: Parameters<TelegramTransport["sendText"]>[2]): Promise<number | undefined>;
  token(payload: Record<string, string>, chatId?: number): string;
}

/** Build the session-domain cards. Called once by index.ts; every card closes
 * over the shared deps like the previous module-scope closures did over
 * index.ts singletons. */
export function createSessionCards(deps: SessionCardsDeps): {
  lastProjectKey(chatId: number): string | undefined;
  openSessionsCard(chatId: number, projectKey?: string, page?: number): Promise<void>;
  openSessionProjectsCard(chatId: number, page?: number): Promise<void>;
  openSessionDetailCard(chatId: number, sessionId: string): Promise<void>;
  openHistoryCard(chatId: number, sessionId: string, beforeSeq?: number): Promise<void>;
  openSearchCard(chatId: number, query: string, page?: number): Promise<void>;
} {
  const { state, requireCtx, cardLoad, openCard, uiSend, token } = deps;

  const SESSIONS_PAGE_SIZE = 10;
  const SESSION_PROJECTS_PAGE_SIZE = 12;
  /** Synthetic project key for the legacy flat "all sessions" view. */
  const ALL_PROJECTS_KEY = "__all__";

  /** Load the Sessions roster once and project it into web-style ordered project groups. */
  async function sessionProjectSnapshot(chatId: number): Promise<{ details: SessionDetail[]; groups: ProjectGroup[]; bound?: string }> {
    const ctx = requireCtx();
    const details = await cardLoad(chatId, "sessions roster", () => listSessionDetails(ctx));
    const workspaces = details === undefined ? [] : listWorkspaces(ctx).items;
    if (details === undefined) return { details: [], groups: [], bound: undefined };
    const groups = groupSessionsByProject(details, workspaces);
    const bound = state.bridge?.agentIdForChat(chatId) ?? state.bridge?.currentAgentIdValue();
    return { details, groups: orderProjectGroups(groups, bound), bound };
  }

  /** Project key the user last viewed on this chat's Sessions card. */
  function lastProjectKey(chatId: number): string | undefined {
    return state.lastSessionsProject.get(chatId);
  }

  async function openSessionsCard(chatId: number, projectKey?: string, page = 0): Promise<void> {
    const { details, groups, bound } = await sessionProjectSnapshot(chatId);
    const requestedKey = projectKey ?? groups[0]?.key ?? ALL_PROJECTS_KEY;
    const group = requestedKey === ALL_PROJECTS_KEY ? undefined : groups.find((candidate) => candidate.key === requestedKey) ?? groups[0];
    const key = group?.key ?? ALL_PROJECTS_KEY;
    const sessions = (group?.sessions ?? details).filter((session) => !session.archived);
    const archivedCount = (group?.sessions ?? details).length - sessions.length;
    const totalPages = Math.max(1, Math.ceil(sessions.length / SESSIONS_PAGE_SIZE));
    const safe = Math.max(0, Math.min(page, totalPages - 1));
    const pageItems = sessions.slice(safe * SESSIONS_PAGE_SIZE, (safe + 1) * SESSIONS_PAGE_SIZE);
    const runningCount = sessions.filter((session) => session.running).length;
    const label = group?.label ?? "All sessions";
    state.lastSessionsProject.set(chatId, key);
    // Design language: bold card title, a quiet meta strip, then one bold row
    // per session with its recency/id beneath — scannable on a phone.
    const lines = [
      headerLine("\u{1F9ED}", "Sessions", plain(truncate(label, 26))),
      metaJoin(
        runningCount > 0 ? `\u25B6\uFE0F ${runningCount} running` : undefined,
        `${sessions.length} sessions`,
        archivedCount > 0 ? `\u{1F5C4}${archivedCount}` : undefined,
        `page ${safe + 1}/${totalPages}`,
      ),
      "",
    ];
    if (sessions.length === 0) lines.push("(no sessions in this project)", "");
    for (const session of pageItems) {
      const title = displayTitleFor(session.title, session.cwd, session.id);
      const hasTitle = session.title !== undefined && session.title.trim() !== "";
      const marker = session.id === bound ? "\u25B8" : "\u2022";
      const state_ = session.running ? " \u25B6\uFE0F" : session.live ? "" : " \u00B7 cold";
      lines.push(`${marker} ${bold(truncate(title, 32))}${state_}`);
      if (session.lastPromptAt !== undefined) {
        // session-read's scanMeta blind-casts `event.at ?? data.createdAt` to
        // number, so a string/missing ts can reach this card despite the type;
        // the fallback keeps the line text-only instead of a broken tg-time.
        lines.push(`   ${metaJoin(`\u23F1\uFE0F ${relTime(session.lastPromptAt, "unknown")}`, hasTitle ? mono(truncate(session.id, 14)) : undefined)}`);
      } else if (hasTitle) {
        lines.push(`   ${mono(truncate(session.id, 14))}`);
      }
    }
    lines.push("", "Session buttons open details \u00B7 Archive / Delete act directly.");
    await openCard(chatId, lines.join("\n"), buildSessionsKeyboard(pageItems.map((session) => ({
      id: session.id,
      title: displayTitleFor(session.title, session.cwd, session.id),
      running: session.running,
      archiveCb: token({ action: "session-archive", sessionId: session.id }, chatId),
      deleteCb: token({ action: "session-delete", sessionId: session.id }, chatId),
    })), {
      projectCount: groups.length,
      projectsCb: token({ action: "sessions-projects" }, chatId),
      paging: {
        ...(safe > 0 ? { previous: token({ action: "sessions-page", projectKey: key, page: String(safe - 1) }, chatId) } : {}),
        ...(safe + 1 < totalPages ? { next: token({ action: "sessions-page", projectKey: key, page: String(safe + 1) }, chatId) } : {}),
      },
    }), () => openSessionsCard(chatId, key, safe));
  }

  /** Project switcher page: running projects first, then current, then recency. */
  async function openSessionProjectsCard(chatId: number, page = 0): Promise<void> {
    const { groups, bound } = await sessionProjectSnapshot(chatId);
    const totalPages = Math.max(1, Math.ceil(groups.length / SESSION_PROJECTS_PAGE_SIZE));
    const safe = Math.max(0, Math.min(page, totalPages - 1));
    const pageGroups = groups.slice(safe * SESSION_PROJECTS_PAGE_SIZE, (safe + 1) * SESSION_PROJECTS_PAGE_SIZE);
    const lines = [headerLine("\u{1F504}", "Projects", `${groups.length}`, `page ${safe + 1}/${totalPages}`), ""];
    for (const group of pageGroups) {
      const current = bound !== undefined && group.sessions.some((session) => session.id === bound);
      lines.push(
        metaJoin(
          `${current ? "\u25B8" : "\u2022"} ${bold(truncate(group.label, 30))}`,
          group.runningCount > 0 ? `\u25B6\uFE0F${group.runningCount}` : undefined,
          `${group.sessions.length} total`,
        ),
      );
    }
    lines.push("", "Tap a project to switch its Sessions page.");
    await openCard(chatId, lines.join("\n"), buildSessionProjectsKeyboard(pageGroups.map((group) => ({
      label: group.label,
      running: group.runningCount,
      total: group.sessions.length,
      cb: token({ action: "sessions-project", projectKey: group.key }, chatId),
    })), {
      all: token({ action: "sessions-project", projectKey: ALL_PROJECTS_KEY }, chatId),
      paging: {
        ...(safe > 0 ? { previous: token({ action: "sessions-projects-page", page: String(safe - 1) }, chatId) } : {}),
        ...(safe + 1 < totalPages ? { next: token({ action: "sessions-projects-page", page: String(safe + 1) }, chatId) } : {}),
      },
      back: token({ action: "sessions-open" }, chatId),
    }), () => openSessionProjectsCard(chatId, safe));
  }

  async function openSessionDetailCard(chatId: number, sessionId: string): Promise<void> {
    const ctx = requireCtx();
    const details = await cardLoad(chatId, "session details", () => listSessionDetails(ctx));
    if (details === undefined) return;
    const session = details.find((candidate) => candidate.id === sessionId);
    if (!session) {
      await uiSend(chatId, `\u274C Session ${plain(truncate(sessionId, 32))} not found.`, { parse_mode: "HTML" });
      return openSessionsCard(chatId, lastProjectKey(chatId));
    }
    const title = displayTitleFor(session.title, session.cwd, session.id);
    // Design language: bold title header, full id as monospace subtitle, then
    // quiet key-value rows. Only the non-default states are spelled out.
    const statusWords = [
      session.live ? "live" : "cold",
      session.running ? "\u25B6\uFE0F running" : "idle",
      ...(session.blank ? ["blank"] : []),
      ...(session.archived ? ["archived"] : []),
    ];
    const lines = [
      headerLine("\u{1F9ED}", truncate(title, 40)),
      mono(session.id),
      "",
      metaJoin(...statusWords),
      metaJoin(`events ${session.eventCount}`, session.cwd ? `cwd ${mono(truncate(session.cwd, 28))}` : undefined),
      session.lastPromptAt !== undefined ? `\u23F1\uFE0F last prompt ${relTime(session.lastPromptAt, "unknown")}` : "",
    ].filter((line) => line !== "");
    await openCard(chatId, lines.join("\n"), buildSessionDetailKeyboard(session.id, session.archived, token({ action: "sessions-open" }, chatId)));
  }

  /** Last viewed trajectory cursor per chat. Hot reload (turn/end) must
   * re-render the page the user is actually reading — without this a paged
   * "Load older" view snapped back to the newest turns on every refresh. */
  const historyCursors = new Map<number, number>();

  async function openHistoryCard(chatId: number, sessionId: string, beforeSeq?: number): Promise<void> {
    // Turn-grouped trajectory view (issue #32), matching the web's Trajectory ledger:
    // per-turn model/outcome/duration header plus user/thinking/tool/answer steps.
    if (beforeSeq === undefined) historyCursors.delete(chatId);
    else historyCursors.set(chatId, beforeSeq);
    const result = await cardLoad(chatId, "session history", () => readTrajectory(requireCtx(), sessionId, 6, beforeSeq));
    if (result === undefined) return;
    await openCard(chatId, renderTrajectoryLines(sessionId, result).join("\n"), buildHistoryKeyboard(
      sessionId,
      result.hasMore && result.nextBefore !== undefined
        ? token({ action: "history-older", sessionId, beforeSeq: String(result.nextBefore) }, chatId)
        : undefined,
      // Hot reload ("/history would not hot-reload"): register this card as the chat's
      // active renderer so turn/end re-reads the trajectory in place, keeping
      // the page the user paged to.
    ), () => openHistoryCard(chatId, sessionId, historyCursors.get(chatId)));
  }

  const SEARCH_PAGE_SIZE = 10;

  async function openSearchCard(chatId: number, query: string, page = 0): Promise<void> {
    const hits = await cardLoad(chatId, "search results", () => searchSessions(requireCtx(), query, 100));
    if (hits === undefined) return;
    const totalPages = Math.max(1, Math.ceil(hits.length / SEARCH_PAGE_SIZE));
    const safe = Math.max(0, Math.min(page, totalPages - 1));
    const pageHits = hits.slice(safe * SEARCH_PAGE_SIZE, (safe + 1) * SEARCH_PAGE_SIZE);
    const lines = [headerLine("\u{1F50D}", "Search", `\u201C${plain(truncate(query, 40))}\u201D`, `${hits.length} hit(s)`, `page ${safe + 1}/${totalPages}`), ""];
    for (const hit of pageHits) {
      lines.push(`\u2022 ${mono(truncate(hit.sessionId, 24))} #${hit.seq} ${escapeHtml(hit.type)}${hit.live ? "" : " (cold)"}`);
      lines.push(`  ${plain(truncate(hit.snippet, 80))}`);
    }
    if (hits.length === 0) lines.push("(no hits)");
    await openCard(chatId, lines.join("\n"), buildSearchKeyboard(pageHits.map((hit) => hit.sessionId), {
      ...(safe > 0 ? { previous: token({ action: "search-page", query, page: String(safe - 1) }, chatId) } : {}),
      ...(safe + 1 < totalPages ? { next: token({ action: "search-page", query, page: String(safe + 1) }, chatId) } : {}),
    }));
  }

  return { lastProjectKey, openSessionsCard, openSessionProjectsCard, openSessionDetailCard, openHistoryCard, openSearchCard };
}
