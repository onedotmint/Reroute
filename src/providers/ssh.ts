import type { Profile, Provider, ExecOptions, ExecResult } from '../types.js';
import { processExec, quote, requireSuccess, shell } from '../util.js';
export function sshArgs(profile: Profile): string[] {
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', ...(profile.port ? ['-p', String(profile.port)] : []), ...(profile.identityFile ? ['-i', profile.identityFile] : [])];
}
export class SshProvider implements Provider {
  readonly stdin = true;
  constructor(readonly profile: Profile, protected readonly execute: typeof processExec = processExec) {}
  async status(): Promise<string> { return (await this.exec('true', { timeoutMs: 15000 })).code === 0 ? 'running' : 'unreachable'; }
  exec(command: string, options: ExecOptions = {}): Promise<ExecResult> { return this.execute('ssh', [...sshArgs(this.profile), this.profile.id, 'exec bash -c ' + quote(command)], { timeoutMs: 120000, ...options }); }
  async put(local: string, remote: string): Promise<void> { await requireSuccess(this.execute('rsync', ['-a', '--no-owner', '--no-group', '--checksum', '--protect-args', '-e', shell(['ssh', ...sshArgs(this.profile)]), '--', local, `${this.profile.id}:${remote}`], { timeoutMs: 120000 })); }
  async get(remote: string, local: string): Promise<void> { await requireSuccess(this.execute('rsync', ['-a', '--no-owner', '--no-group', '--protect-args', '-e', shell(['ssh', ...sshArgs(this.profile)]), '--', `${this.profile.id}:${remote}`, local], { timeoutMs: 120000 })); }
  async sync(local: string, remote: string): Promise<number> {
    const result = await requireSuccess(this.execute('rsync', ['-a', '--no-owner', '--no-group', '--delete', '--checksum', '--protect-args', '--stats', '-e', shell(['ssh', ...sshArgs(this.profile)]), '--', local + '/', `${this.profile.id}:${remote}/`], { timeoutMs: 300000, env: { ...process.env, LC_ALL: 'C' } }));
    const sent = /Total bytes sent:\s*([\d,]+)/.exec(result.stdout)?.[1];
    if (!sent) throw new Error('rsync did not report transfer statistics; input not sealed');
    return Number(sent.replaceAll(',', ''));
  }
  async lifecycle(_action: 'stop' | 'resume' | 'destroy'): Promise<void> { throw new Error('SSH does not own the host lifecycle. Use native host management; cancel and cleanup manage only Reroute tasks.'); }
}
