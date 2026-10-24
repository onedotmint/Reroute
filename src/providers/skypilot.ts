import { SshProvider } from './ssh.js';
import { requireSuccess } from '../util.js';
/** SkyPilot owns provisioning and SSH aliases. Native SSH preserves separate stdout/stderr on the head node; no Ray queue or auto-launch. */
export class SkyPilotProvider extends SshProvider {
  override async status(): Promise<string> {
    const result = await requireSuccess(this.execute('sky', ['status', this.profile.id, '--refresh', '-o', 'json'], { timeoutMs: 90000 }));
    const items: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(items)) throw new Error('Unrecognized sky status JSON; upgrade the SkyPilot CLI');
    const row = items.find((x: { name?: string }) => x.name === this.profile.id) as { status?: string } | undefined;
    return row?.status === 'UP' ? 'running' : row?.status === 'STOPPED' ? 'stopped' : row ? 'unknown' : 'missing';
  }
  override async lifecycle(action: 'stop' | 'resume' | 'destroy'): Promise<void> {
    const verb = action === 'resume' ? 'start' : action === 'destroy' ? 'down' : 'stop';
    await requireSuccess(this.execute('sky', [verb, this.profile.id, '-y'], { timeoutMs: 600000 }));
  }
}
