/**
 * Goal domain (web ApiProxy goal.* six methods) over ctx.goals.
 */
import type { Context } from "@deepseek-ai/cordis";
import { type AdapterResult } from "./types.js";
export interface GoalView {
    id: string;
    revision: number;
    objective: string;
    maxGoalRounds?: number;
    phase: "active" | "paused" | "blocked" | "complete";
    activation: "armed" | "disarmed";
    roundsStarted: number;
    createdAt: number;
    updatedAt: number;
}
/** Resolve the current goal for one exact live agent. */
export declare function getGoal(ctx: Context, agentId: string): GoalView | undefined;
export declare function createGoal(ctx: Context, agentId: string, objective: string, maxGoalRounds?: number): Promise<AdapterResult>;
export declare function editGoal(ctx: Context, agentId: string, id: string, revision: number, request: {
    objective?: string;
    maxGoalRounds?: number;
}): Promise<AdapterResult & {
    goal?: GoalView;
}>;
export declare function pauseGoal(ctx: Context, agentId: string, id: string, revision: number): Promise<AdapterResult & {
    goal?: GoalView;
}>;
export declare function resumeGoal(ctx: Context, agentId: string, id: string, revision: number): Promise<AdapterResult & {
    goal?: GoalView;
}>;
export declare function clearGoal(ctx: Context, agentId: string, id: string, revision: number): Promise<AdapterResult & {
    goal?: GoalView;
}>;
