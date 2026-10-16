/**
 * Message feedback domain (web Typert messageFeedback/put,list,delete) over
 * ctx.messageFeedback.
 */
import type { Context } from "@deepseek-ai/cordis";
import { type AdapterResult } from "./types.js";
export type MessageFeedbackRating = "positive" | "negative";
export interface MessageFeedbackItem {
    messageId: string;
    rating: MessageFeedbackRating;
    note?: string;
    version: string;
    createdAt: number;
    updatedAt: number;
}
export declare function listFeedback(ctx: Context, sessionId: string): Promise<MessageFeedbackItem[]>;
export declare function putFeedback(ctx: Context, sessionId: string, messageId: string, rating: MessageFeedbackRating, note?: string): Promise<AdapterResult>;
export declare function deleteFeedback(ctx: Context, sessionId: string, messageId: string, ifVersion: string): Promise<AdapterResult>;
