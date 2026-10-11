/** Bounded event queue. Slow clients fail explicitly instead of exhausting daemon RAM. */
export declare class AsyncQueue<T> implements AsyncIterable<T> {
    private readonly limit;
    private items;
    private waiter?;
    private ended;
    private failure?;
    constructor(limit?: number);
    push(item: T): void;
    end(error?: unknown): void;
    [Symbol.asyncIterator](): AsyncIterator<T>;
}
export declare class SerialLane {
    private tail;
    run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}
