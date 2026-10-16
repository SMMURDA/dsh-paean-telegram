/**
 * Callback payload registry: keeps long ids/arguments out of Telegram's
 * 64-byte callback_data limit. Tokens are single-use — a tap executes exactly
 * once even when Telegram redelivers a callback or a stale message is tapped
 * again — optionally bound to their minting chat (RF-1), and every ledger
 * stays bounded for long-running bots.
 */
export declare class TokenRegistry {
    private readonly maxEntries;
    private readonly tokens;
    private readonly used;
    /** Minting chat per pending token (RF-1): a tap from any other chat is
     * rejected instead of executing, so a whitelisted stranger cannot replay an
     * enumerated `t:<id>` into someone else's private chat. Only present when
     * the mint site knew its chat; absent entries stay world-usable so every
     * existing caller keeps working unchanged. Entries exist only while their
     * token is pending (dropped on take/evict), so the map stays bounded. */
    private readonly owners;
    private counter;
    constructor(maxEntries?: number);
    mint(payload: Record<string, string>, chatId?: number): string;
    /** Remove and return the payload for a callback; `undefined` when unknown,
     * already consumed, or — for a token minted with a chat binding — tapped
     * from any other chat (RF-1). A token without a recorded owner stays
     * usable from anywhere, which keeps pre-binding cards working; passing no
     * chatId at all also only ever matches unowned tokens. */
    take(data: string, chatId?: number): Record<string, string> | undefined;
    /** Put a taken token back when its callback threw before doing anything.
     * Only restores an id this registry marked used; tokens are never reused
     * so a successful run can never be un-consumed. `chatId` (the chat that
     * legitimately took the token — take() only succeeds for the minting chat)
     * re-records ownership so a restored token keeps its chat binding. */
    restore(data: string, payload: Record<string, string>, chatId?: number): boolean;
    /** Distinguish "already ran" from "card predates this bot process". */
    wasUsed(data: string): boolean;
    pending(): number;
    reset(): void;
}
