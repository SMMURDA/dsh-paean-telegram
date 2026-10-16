import type { TelegramTransport } from "./transport.js";
export interface RouterDeps {
    transport: TelegramTransport;
    isAllowed: (chatId: number) => boolean;
    onCommand: (chatId: number, command: string, args: string, messageId?: number) => void | Promise<void>;
    onBarButton: (chatId: number, label: string, messageId?: number) => void | Promise<void>;
    onCallback: (chatId: number, data: string) => void | Promise<void>;
    onUserText: (chatId: number, text: string, messageId?: number) => void | Promise<void>;
    onPhoto: (chatId: number, fileId: string, caption: string, messageId?: number) => void | Promise<void>;
    onPhotos: (chatId: number, photos: readonly {
        fileId: string;
        caption: string;
        messageId?: number;
    }[], groupId?: string) => void | Promise<void>;
    onDocument: (chatId: number, kind: "document" | "voice" | "video", fileId: string, name: string, mimeType: string, messageId?: number) => void | Promise<void>;
    onUnauthorized: (chatId: number, reason?: string) => void | Promise<void>;
}
export declare function attachRouter(deps: RouterDeps): void;
