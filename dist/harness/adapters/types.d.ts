export interface AdapterResult {
    ok: boolean;
    text: string;
}
export declare function ok(text: string): AdapterResult;
export declare function fail(text: string): AdapterResult;
