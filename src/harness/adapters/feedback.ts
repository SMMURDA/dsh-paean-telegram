/**
 * Message feedback domain (web Typert messageFeedback/put,list,delete) over
 * ctx.messageFeedback.
 */
import type { Context } from "@deepseek-ai/cordis";
import { fail, ok, type AdapterResult } from "./types.js";

export type MessageFeedbackRating = "positive" | "negative";

export interface MessageFeedbackItem {
  messageId: string;
  rating: MessageFeedbackRating;
  note?: string;
  version: string;
  createdAt: number;
  updatedAt: number;
}

interface FeedbackServiceLike {
  list(request: { sessionId: string }): Promise<{ items: readonly MessageFeedbackItem[] }>;
  put(request: { sessionId: string; messageId: string; rating: MessageFeedbackRating; note?: string }): Promise<MessageFeedbackItem>;
  delete(request: { sessionId: string; messageId: string; ifVersion: string }): Promise<{ deleted: boolean }>;
}

function feedbackOf(ctx: Context): FeedbackServiceLike | undefined {
  return ctx.get("messageFeedback") as FeedbackServiceLike | undefined;
}

export async function listFeedback(ctx: Context, sessionId: string): Promise<MessageFeedbackItem[]> {
  const service = feedbackOf(ctx);
  if (!service) return [];
  try {
    return [...(await service.list({ sessionId })).items];
  } catch {
    return [];
  }
}

export async function putFeedback(
  ctx: Context,
  sessionId: string,
  messageId: string,
  rating: MessageFeedbackRating,
  note?: string,
): Promise<AdapterResult> {
  const service = feedbackOf(ctx);
  if (!service) return fail("messageFeedback service is unavailable in this profile");
  try {
    const item = await service.put({ sessionId, messageId, rating, ...(note === undefined ? {} : { note }) });
    return ok(`\u{1F44D} Feedback recorded (${item.rating})`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function deleteFeedback(ctx: Context, sessionId: string, messageId: string, ifVersion: string): Promise<AdapterResult> {
  const service = feedbackOf(ctx);
  if (!service) return fail("messageFeedback service is unavailable in this profile");
  try {
    await service.delete({ sessionId, messageId, ifVersion });
    return ok("\u{1F5D1} Feedback removed");
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
