import { fail, ok } from "./types.js";
/** The execute signal is owned by the dispatching UI request — us. A hung
 * command backend must not suspend Telegram command processing forever (the
 * controller used to never fire). Same race shape as host.ts's withFsTimeout;
 * the controller is also aborted so signal-aware commands stop immediately. */
const COMMAND_TIMEOUT_MS = 60_000;
function commandsOf(ctx) {
    return ctx.get("commands");
}
export function listCommands(ctx, agent) {
    const commands = commandsOf(ctx);
    if (!commands)
        return [];
    try {
        return commands.list(agent).map((command) => ({
            name: command.name,
            description: command.description,
            ...(command.input?.hint === undefined ? {} : { input: command.input.hint }),
        }));
    }
    catch {
        return [];
    }
}
export async function executeCommand(ctx, agent, line) {
    const commands = commandsOf(ctx);
    if (!commands)
        return fail("commands service is unavailable in this profile");
    const controller = new AbortController();
    let timer;
    try {
        const execution = await Promise.race([
            commands.execute(agent, line, controller.signal),
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => {
                    const err = new Error(`command execution timed out after ${COMMAND_TIMEOUT_MS}ms`);
                    controller.abort(err);
                    reject(err);
                }, COMMAND_TIMEOUT_MS);
            }),
        ]);
        if (execution === undefined)
            return fail(`unknown or malformed slash command: ${line}`);
        if (execution.kind === "error")
            return fail(execution.message ?? "command failed");
        return ok(execution.text ?? "command executed");
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
//# sourceMappingURL=commands.js.map