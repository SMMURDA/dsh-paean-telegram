/**
 * Skill domain (web ApiProxy skill.list) over ctx.skills.
 */
import type { Context } from "@deepseek-ai/cordis";
export interface SkillEntry {
    name: string;
    description: string;
    whenToUse?: string;
    source: string;
    provider: string;
    modelInvocable: boolean;
    userInvocable: boolean;
}
/** Web skill.list request envelope: the session addressing the catalog,
 * the session's project cwd (the host scopes project skills by it), and the
 * invocation scope (`user` = user-invocable entries only, like the web's
 * command palette; omitted = everything). */
export interface SkillListOptions {
    sessionId?: string;
    cwd?: string;
    scope?: string;
}
export declare function listSkills(ctx: Context, options?: string | SkillListOptions): Promise<SkillEntry[]>;
