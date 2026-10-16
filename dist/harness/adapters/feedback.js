import { fail, ok } from "./types.js";
function feedbackOf(ctx) {
    return ctx.get("messageFeedback");
}
export async function listFeedback(ctx, sessionId) {
    const service = feedbackOf(ctx);
    if (!service)
        return [];
    try {
        return [...(await service.list({ sessionId })).items];
    }
    catch {
        return [];
    }
}
export async function putFeedback(ctx, sessionId, messageId, rating, note) {
    const service = feedbackOf(ctx);
    if (!service)
        return fail("messageFeedback service is unavailable in this profile");
    try {
        const item = await service.put({ sessionId, messageId, rating, ...(note === undefined ? {} : { note }) });
        return ok(`\u{1F44D} Feedback recorded (${item.rating})`);
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}
export async function deleteFeedback(ctx, sessionId, messageId, ifVersion) {
    const service = feedbackOf(ctx);
    if (!service)
        return fail("messageFeedback service is unavailable in this profile");
    try {
        await service.delete({ sessionId, messageId, ifVersion });
        return ok("\u{1F5D1} Feedback removed");
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
}
//# sourceMappingURL=feedback.js.map