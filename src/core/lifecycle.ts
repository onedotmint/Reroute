import type { RuntimeProvider, RuntimeRef, IdlePolicy } from './contracts.js';
import { SerialLane } from './queue.js';
/** One owner for activity leases. Provider calls and idle deadlines are serialized. */
export class Lifecycle {
  private leases = 0;
  private idle?: NodeJS.Timeout;
  private renewal?: NodeJS.Timeout;
  private generation = 0;
  private readonly policyLane = new SerialLane();
  constructor(private readonly provider: RuntimeProvider, private readonly runtime: RuntimeRef, private readonly minutes: number,
    private readonly onIdle: () => void, private readonly onError: (error: unknown) => void,
    private readonly scheduleIdle: (operation: () => Promise<void>) => Promise<void> = operation => operation()) {}
  get active(): number { return this.leases; }
  private set(policy: IdlePolicy): Promise<void> { return this.policyLane.run(() => this.provider.applyIdlePolicy(this.runtime, policy)); }
  async acquire(): Promise<() => Promise<void>> {
    clearTimeout(this.idle); this.idle = undefined; this.generation++;
    if (this.leases++ === 0) {
      try { await this.set({ active: true, minutes: this.minutes }); }
      catch (error) { this.leases--; throw error; }
      this.renewal = setInterval(() => {
        void this.policyLane.run(async () => { if (this.leases) await this.provider.applyIdlePolicy(this.runtime, { active: true, minutes: this.minutes }); }).catch(this.onError);
      }, 60000); this.renewal.unref();
    }
    let released = false;
    return async () => {
      if (released) return; released = true;
      if (--this.leases === 0) { clearInterval(this.renewal); this.renewal = undefined; await this.arm(); }
    };
  }
  async arm(): Promise<void> {
    if (this.leases) return;
    clearTimeout(this.idle); const generation = ++this.generation;
    await this.set({ active: false, minutes: this.minutes });
    if (this.leases || generation !== this.generation) return;
    this.idle = setTimeout(() => {
      void this.scheduleIdle(async () => {
        if (this.leases || generation !== this.generation) return;
        await this.set({ active: false, minutes: 0 }); this.onIdle();
      }).catch(this.onError);
    }, this.minutes * 60000); this.idle.unref();
  }
  async stop(): Promise<void> { this.dispose(); await this.set({ active: false, minutes: 0 }); this.onIdle(); }
  dispose(): void { this.generation++; clearInterval(this.renewal); clearTimeout(this.idle); }
}
