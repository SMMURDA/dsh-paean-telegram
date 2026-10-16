export declare function detectProfile(argv?: readonly string[]): string | undefined;
export declare function dshHome(): string;
/** Profile directories under $DSH_HOME/profiles (skips non-profile dirs). */
export declare function listProfiles(): string[];
export interface ModeSummary {
    profile?: string;
    profiles: string[];
    note: string;
}
export declare function modeSummary(): ModeSummary;
