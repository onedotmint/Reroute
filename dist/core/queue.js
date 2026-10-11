import { RerouteError } from './errors.js';
/** Bounded event queue. Slow clients fail explicitly instead of exhausting daemon RAM. */
export class AsyncQueue {
    limit;
    items = [];
    waiter;
    ended = false;
    failure;
    constructor(limit = 4096) {
        this.limit = limit;
    }
    push(item) {
        if (this.ended)
            return;
        if (this.waiter) {
            const waiter = this.waiter;
            this.waiter = undefined;
            waiter.resolve({ value: item, done: false });
        }
        else if (this.items.length >= this.limit)
            this.end(new RerouteError('BACKPRESSURE', 'Output consumer is too slow; execution was disconnected.'));
        else
            this.items.push(item);
    }
    end(error) {
        if (this.ended)
            return;
        this.ended = true;
        this.failure = error;
        if (this.waiter) {
            const waiter = this.waiter;
            this.waiter = undefined;
            error ? waiter.reject(error) : waiter.resolve({ done: true, value: undefined });
        }
    }
    [Symbol.asyncIterator]() {
        return { next: () => {
                if (this.items.length)
                    return Promise.resolve({ value: this.items.shift(), done: false });
                if (this.failure)
                    return Promise.reject(this.failure);
                if (this.ended)
                    return Promise.resolve({ done: true, value: undefined });
                return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
            } };
    }
}
export class SerialLane {
    tail = Promise.resolve();
    run(operation, signal) {
        const result = this.tail.catch(() => { }).then(() => {
            if (signal?.aborted)
                throw new RerouteError('CANCELLED', 'Cancelled before execution', 130);
            return operation();
        });
        this.tail = result.catch(() => { });
        return result;
    }
}
