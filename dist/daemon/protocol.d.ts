import type { Socket } from 'node:net';
export declare function endpoint(): string;
export declare function send(socket: Socket, packet: unknown): Promise<void>;
export declare function lines(socket: Socket, handle: (packet: Record<string, unknown>) => void, onError: (error: unknown) => void): void;
