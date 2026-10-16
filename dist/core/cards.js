/**
 * Card lifecycle plumbing for dsh-telegram.
 *
 * One registry per mount: `openCard` replaces the chat's transient card in
 * place through the Ephemeral lane and remembers per-chat refresh renderers
 * so web-side events can re-read open cards; `cardLoad` bounds every card
 * data load with a visible-failure timeout (issue #20/#2); `askConfirm`
 * layers the destructive-action confirmation keyboard on top of `openCard`;
 * `widenCard` pads a card to full bubble width.
 *
 * Plugin-root layer: may import ./harness/... and ./telegram/..., never a dsh
 * package beyond what index.ts itself imports. All plugin-root singletons
 * (transport access, UI seams) arrive through one deps object; the renderer
 * map is created here and returned so index.ts teardown keeps clearing it.
 */
import { buildConfirmKeyboard } from "../telegram/keyboard.js";
import { plain, truncate } from "../telegram/html.js";
/** Race one promise against a deadline so a hung callee fails its caller. */
export function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        }),
    ]).finally(() => {
        if (timer !== undefined)
            clearTimeout(timer);
    });
}
/** Telegram sizes the bubble (and its inline keyboard) to the widest text
 * line. A trailing line of non-breaking spaces forces the card to span the
 * maximum bubble width so keyboard rows never leave a right-hand gap. */
export function widenCard(text) {
    return `${text}\n${"\u00A0".repeat(80)}`;
}
/** Build the card registry. Called once by index.ts; the returned functions
 * close over the shared deps like the previous module-scope closures did over
 * index.ts singletons. */
export function createCardRegistry(deps) {
    const { requireTransport, uiOps, ephemeral, token, log, uiSend } = deps;
    /** Card data-loading deadline (issue #20/#2): a hung service must fail the
     * card with a visible message instead of wedging the chat's UI lane forever. */
    const CARD_LOAD_TIMEOUT_MS = 10_000;
    /** One shared underlying load per chat+label: after a caller's visible
     * deadline fires, the real loader keeps running — a retry used to start a
     * SECOND copy of the same work while the first finished unseen. Callers now
     * join the single in-flight promise (each with their own deadline), and a
     * late settlement after every caller timed out merely clears the entry. */
    const inFlightCardLoads = new Map();
    async function cardLoad(chatId, label, load) {
        const key = `${chatId}\u0000${label}`;
        let underlying = inFlightCardLoads.get(key);
        if (underlying === undefined) {
            underlying = Promise.resolve().then(load);
            inFlightCardLoads.set(key, underlying);
            // Forget the entry once it settles; both callbacks subscribe to the
            // rejection, so a loser that finishes after all callers timed out is
            // observed and dropped instead of surfacing as an unhandled rejection.
            const settled = underlying;
            void settled.then(() => {
                if (inFlightCardLoads.get(key) === settled)
                    inFlightCardLoads.delete(key);
            }, () => {
                if (inFlightCardLoads.get(key) === settled)
                    inFlightCardLoads.delete(key);
            });
        }
        try {
            return await withTimeout(underlying, CARD_LOAD_TIMEOUT_MS, label);
        }
        catch (err) {
            log(`${label} load failed`, err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err));
            await uiSend(chatId, `\u274C ${label} \u52A0\u8F7D\u5931\u8D25\uFF1A${plain(truncate(err instanceof Error ? err.message : String(err), 120))}`, { parse_mode: "HTML" });
            return undefined;
        }
    }
    /** Cards that should re-read their data source when web-side settings/plugin
     * events fire (presets, workspaces, sessions). Keyed by chat. */
    const activeCardRenderers = new Map();
    async function openCard(chatId, text, keyboard, refresh) {
        const t = requireTransport();
        // Only mutate the renderer registry after the ephemeral replace succeeds.
        // If replace throws, the card never opened, so no renderer must remain to
        // let later web events resurrect a stale card (CD-1 / RF-5).
        await ephemeral.replace(chatId, uiOps(t), text, {
            parse_mode: "HTML",
            reply_markup: keyboard,
        });
        if (refresh === undefined)
            activeCardRenderers.delete(chatId);
        else
            activeCardRenderers.set(chatId, refresh);
    }
    function refreshActiveCards() {
        for (const render of activeCardRenderers.values()) {
            void render().catch((err) => log("active card refresh failed", err));
        }
    }
    /** Replace the current card with a destructive-action confirmation. SC-2:
     * both keyboard tokens bind to the ASKING chat (RF-1 owner map) — an
     * unowned confirm token for a destructive action minted in chat A used to
     * be consumable from any other whitelisted chat B. */
    async function askConfirm(chatId, text, confirmPayload, cancelPayload) {
        await openCard(chatId, text, buildConfirmKeyboard({
            confirm: token(confirmPayload, chatId),
            cancel: token(cancelPayload, chatId),
        }));
    }
    return { activeCardRenderers, openCard, refreshActiveCards, askConfirm, cardLoad };
}
//# sourceMappingURL=cards.js.map