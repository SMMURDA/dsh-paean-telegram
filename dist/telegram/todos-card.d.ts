/**
 * Live Todo card renderer (issue #14). The card is opened while the agent is
 * still running and refreshes every few seconds, so the header also encodes
 * the completion state instead of only counts.
 *
 * Typography (design language, ./ui.ts): one header line — icon, bold title,
 * progress bar + done/total meta; completed items are struck through so the
 * remaining work pops without reading status tags.
 */
import { type TodoView } from "../harness/adapters/todos.js";
/** Todo card renderer shared by the initial open and the periodic refresh.
 * Length contract (#TL-1): the item block is budgeted by renderTodos
 * (TODOS_RENDER_MAX_CHARS), and this wrapper adds ≤~150 chars of
 * header/progress/footer chrome, so the FULL card always stays under ~3800
 * chars — below Telegram's 4096 send/edit ceiling. That bound is what lets
 * the 5s auto-refresh edit one bubble in place forever instead of tripping
 * the transport's overlong-edit fast-fail into a resend flood. */
export declare function renderTodosCard(todos: readonly TodoView[], hasLiveAgent: boolean): string;
