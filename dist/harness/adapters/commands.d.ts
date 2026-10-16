/**
 * Commands domain (web Typert commands/list + commands/execute, reached on
 * the web through session.prompt slash dispatch) over ctx.commands.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { type AdapterResult } from "./types.js";
export interface CommandEntry {
    name: string;
    description: string;
    input?: string;
}
export declare function listCommands(ctx: Context, agent: Agent): CommandEntry[];
export declare function executeCommand(ctx: Context, agent: Agent, line: string): Promise<AdapterResult>;
