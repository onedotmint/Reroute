import type { RuntimeProvider, RuntimeRef, IdlePolicy } from './contracts.js';
import { SerialLane } from './queue.js';
import { invariant } from './errors.js';
/** One owner for activity leases. Provider calls and idle deadlines are serialized. */
export class Lifecycle {
  private leases = 0;
  private idle?: NodeJS.Timeout;
  private renewal?: NodeJS.Timeout;
  private generation = 0;
  private renewalGeneration = 0;
  private disposed = false;
  private activation?: Promise<void>;
  private readonly policyLane = new SerialLane();
  constructor(private readonly provider: RuntimeProvider, private readonly runtime: RuntimeRef, private readonly minutes: number,
    private readonly onIdle: () => void, private readonly onError: (error: unknown) => void,
    private readonly scheduleIdle: (operation: () => Promise<void>) => Promise<void> = operation => operation()) {}
  get active(): number { return this.leases; }
  private set(policy: IdlePolicy, valid: () => boolean = () => true): Promise<void> {
    return this.policyLane.run(async () => { if (valid()) await this.provider.applyIdlePolicy(this.runtime, policy); });
  }
  private renew(generation: number): void {
    if (this.disposed || !this.leases || generation !== this.renewalGeneration) return;
    // Schedule after completion: slow SDK calls never accumulate queued renewal work.
    this.renewal = setTimeout(() => {
      this.renewal = undefined;
      void this.set({ active: true, minutes: this.minutes }, () => !this.disposed && !!this.leases && generation === this.renewalGeneration)
        .then(() => this.renew(generation), error => { if (!this.disposed && generation === this.renewalGeneration) { this.renewalGeneration++; this.onError(error); } });
    }, 60000); this.renewal.unref();
  }
  async acquire(): Promise<() => Promise<void>> {
    invariant(!this.disposed, 'CANCELLED', 'Lifecycle is disposed');
    clearTimeout(this.idle); this.idle = undefined; this.generation++;
    if (this.leases++ === 0) {
      const generation = ++this.renewalGeneration;
      const activation = this.set({ active: true, minutes: this.minutes }, () => !this.disposed)
        .then(() => this.renew(generation));
      this.activation = activation;
      void activation.then(() => { if (this.activation === activation) this.activation = undefined; }, () => { if (this.activation === activation) this.activation = undefined; });
    }
    try { if (this.activation) await this.activation; invariant(!this.disposed, 'CANCELLED', 'Lifecycle is disposed'); }
    catch (error) { this.leases--; throw error; }
    let released = false;
    return async () => {
      if (released) return; released = true;
      if (--this.leases === 0) {
        this.renewalGeneration++; clearTimeout(this.renewal); this.renewal = undefined;
        if (!this.disposed) await this.arm();
      }
    };
  }
  async arm(): Promise<void> {
    if (this.disposed || this.leases) return;
    clearTimeout(this.idle); const generation = ++this.generation;
    const valid = () => !this.disposed && !this.leases && generation === this.generation;
    await this.set({ active: false, minutes: this.minutes }, valid);
    if (!valid()) return;
    this.idle = setTimeout(() => {
      this.idle = undefined;
      void this.scheduleIdle(async () => {
        if (!valid()) return;
        await this.set({ active: false, minutes: 0 }, valid);
        if (valid()) this.onIdle();
      }).catch(error => { if (!this.disposed) this.onError(error); });
    }, this.minutes * 60000); this.idle.unref();
  }
  async stop(): Promise<void> { this.dispose(); await this.set({ active: false, minutes: 0 }); this.onIdle(); }
  dispose(): void {
    this.disposed = true; this.generation++; this.renewalGeneration++;
    clearTimeout(this.renewal); clearTimeout(this.idle);
    this.renewal = undefined; this.idle = undefined;
  }
}
