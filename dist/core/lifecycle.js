import { SerialLane } from './queue.js';
/** One owner for activity leases. Provider calls and idle deadlines are serialized. */
export class Lifecycle {
    provider;
    runtime;
    minutes;
    onIdle;
    onError;
    scheduleIdle;
    leases = 0;
    idle;
    renewal;
    generation = 0;
    policyLane = new SerialLane();
    constructor(provider, runtime, minutes, onIdle, onError, scheduleIdle = operation => operation()) {
        this.provider = provider;
        this.runtime = runtime;
        this.minutes = minutes;
        this.onIdle = onIdle;
        this.onError = onError;
        this.scheduleIdle = scheduleIdle;
    }
    get active() { return this.leases; }
    set(policy) { return this.policyLane.run(() => this.provider.applyIdlePolicy(this.runtime, policy)); }
    async acquire() {
        clearTimeout(this.idle);
        this.idle = undefined;
        this.generation++;
        if (this.leases++ === 0) {
            try {
                await this.set({ active: true, minutes: this.minutes });
            }
            catch (error) {
                this.leases--;
                throw error;
            }
            this.renewal = setInterval(() => {
                void this.policyLane.run(async () => { if (this.leases)
                    await this.provider.applyIdlePolicy(this.runtime, { active: true, minutes: this.minutes }); }).catch(this.onError);
            }, 60000);
            this.renewal.unref();
        }
        let released = false;
        return async () => {
            if (released)
                return;
            released = true;
            if (--this.leases === 0) {
                clearInterval(this.renewal);
                this.renewal = undefined;
                await this.arm();
            }
        };
    }
    async arm() {
        if (this.leases)
            return;
        clearTimeout(this.idle);
        const generation = ++this.generation;
        await this.set({ active: false, minutes: this.minutes });
        if (this.leases || generation !== this.generation)
            return;
        this.idle = setTimeout(() => {
            void this.scheduleIdle(async () => {
                if (this.leases || generation !== this.generation)
                    return;
                await this.set({ active: false, minutes: 0 });
                this.onIdle();
            }).catch(this.onError);
        }, this.minutes * 60000);
        this.idle.unref();
    }
    async stop() { this.dispose(); await this.set({ active: false, minutes: 0 }); this.onIdle(); }
    dispose() { this.generation++; clearInterval(this.renewal); clearTimeout(this.idle); }
}
