import { type AdapterResult } from "./types.js";
/** Default OpenAI-compatible voice-transcription model; also the config
 * default in config.ts so both call sites share one source of truth
 * (review 🟡-6). */
export declare const DEFAULT_TRANSCRIBE_MODEL = "whisper-1";
export interface TranscribeConfig {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
}
export declare function transcribeVoice(data: Uint8Array, filename: string, config: TranscribeConfig | undefined, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Promise<AdapterResult & {
    transcript?: string;
}>;
/** Store one document under `~/.dsh/sessions/<id>/attachments/<safe-name>`. */
export declare function saveDocumentAttachment(sessionId: string, data: Uint8Array, filename: string, now?: number): Promise<AdapterResult & {
    path?: string;
}>;
