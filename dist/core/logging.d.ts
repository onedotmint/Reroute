export declare function scrub(text: string): string;
export declare function log(event: string, fields?: Record<string, unknown>): Promise<void>;
export declare class LogTail {
    private text;
    push(stream: string, data: Buffer): void;
    read(): string;
}
