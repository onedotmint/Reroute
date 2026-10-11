import { SerialLane } from './queue.js';
import { invariant } from './errors.js';
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
    renewalGeneration = 0;
    disposed = false;
    activation;
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
    set(policy, valid = () => true) {
        return this.policyLane.run(async () => { if (valid())
            await this.provider.applyIdlePolicy(this.runtime, policy); });
    }
    renew(generation) {
        if (this.disposed || !this.leases || generation !== this.renewalGeneration)
            return;
        // Schedule after completion: slow SDK calls never accumulate queued renewal work.
        this.renewal = setTimeout(() => {
            this.renewal = undefined;
            void this.set({ active: true, minutes: this.minutes }, () => !this.disposed && !!this.leases && generation === this.renewalGeneration)
                .then(() => this.renew(generation), error => { if (!this.disposed && generation === this.renewalGeneration) {
                this.renewalGeneration++;
                this.onError(error);
            } });
        }, 60000);
        this.renewal.unref();
    }
    async acquire() {
        invariant(!this.disposed, 'CANCELLED', 'Lifecycle is disposed');
        clearTimeout(this.idle);
        this.idle = undefined;
        this.generation++;
        if (this.leases++ === 0) {
            const generation = ++this.renewalGeneration;
            const activation = this.set({ active: true, minutes: this.minutes }, () => !this.disposed)
                .then(() => this.renew(generation));
            this.activation = activation;
            void activation.then(() => { if (this.activation === activation)
                this.activation = undefined; }, () => { if (this.activation === activation)
                this.activation = undefined; });
        }
        try {
            if (this.activation)
                await this.activation;
            invariant(!this.disposed, 'CANCELLED', 'Lifecycle is disposed');
        }
        catch (error) {
            this.leases--;
            throw error;
        }
        let released = false;
        return async () => {
            if (released)
                return;
            released = true;
            if (--this.leases === 0) {
                this.renewalGeneration++;
                clearTimeout(this.renewal);
                this.renewal = undefined;
                if (!this.disposed)
                    await this.arm();
            }
        };
    }
    async arm() {
        if (this.disposed || this.leases)
            return;
        clearTimeout(this.idle);
        const generation = ++this.generation;
        const valid = () => !this.disposed && !this.leases && generation === this.generation;
        await this.set({ active: false, minutes: this.minutes }, valid);
        if (!valid())
            return;
        this.idle = setTimeout(() => {
            this.idle = undefined;
            void this.scheduleIdle(async () => {
                if (!valid())
                    return;
                await this.set({ active: false, minutes: 0 }, valid);
                if (valid())
                    this.onIdle();
            }).catch(error => { if (!this.disposed)
                this.onError(error); });
        }, this.minutes * 60000);
        this.idle.unref();
    }
    async stop() { this.dispose(); await this.set({ active: false, minutes: 0 }); this.onIdle(); }
    dispose() {
        this.disposed = true;
        this.generation++;
        this.renewalGeneration++;
        clearTimeout(this.renewal);
        clearTimeout(this.idle);
        this.renewal = undefined;
        this.idle = undefined;
    }
}
