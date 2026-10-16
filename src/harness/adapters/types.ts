export interface AdapterResult {
  ok: boolean;
  text: string;
}

export function ok(text: string): AdapterResult {
  return { ok: true, text };
}

export function fail(text: string): AdapterResult {
  return { ok: false, text };
}
