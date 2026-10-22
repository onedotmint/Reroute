export interface Compute { cpu: number; memoryGiB: number }
export interface CloudPolicy {
  authorized: boolean;
  maxCpu: number;
  maxMemoryGiB: number;
  maxTaskUsd: number;
  monthlyUsd: number;
  // User-reviewed rates, not an account balance or a guaranteed bill cap.
  cpuHourUsd: number;
  memoryGiBHourUsd: number;
  storageMonthUsd: number;
  idleMinutes: number;
}
export const PROVIDERS = ['ssh', 'daytona', 'skypilot', 'modal', 'e2b'] as const;
export type ProviderId = typeof PROVIDERS[number];
export type Category = 'build' | 'test' | 'check' | 'benchmark';
export interface Profile {
  provider: ProviderId;
  id: string;
  root?: string;
  port?: number;
  identityFile?: string;
  app?: string;
  image?: string;
  snapshot?: string;
  credential?: string;
  compute?: Compute;
  managed?: CloudPolicy;
  owner?: string;
  cacheVolume?: string;
  pendingResume?: string;
}
export interface ManagedRequest {
  name: string;
  owner: string;
  create: boolean;
  start: boolean;
  guardMinutes: number;
  replaceStopped?: boolean;
}
export interface Config {
  version: 3;
  active: string;
  mode: 'auto' | 'local';
  profiles: Record<string, Profile>;
  tasks: Category[];
  remote: string[][];
  local: string[][];
  timeoutSeconds: number;
}
export interface Decision { route: 'local' | 'remote'; reason: string; category?: Category }
/** The only optional future routing seam. No model or credentials are involved. */
export type Router = (command: string, cwd: string, config: Config) => Promise<Decision>;
export interface ExecOptions {
  stdout?: (chunk: Buffer) => void;
  stderr?: (chunk: Buffer) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  stdin?: NodeJS.ReadableStream;
}
export interface ExecResult { code: number; stdout: string; stderr: string; stdoutTruncated?: boolean; stderrTruncated?: boolean }
export interface Provider {
  readonly profile: Profile;
  readonly stdin: boolean;
  status(): Promise<string>;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  put(local: string, remote: string): Promise<void>;
  get(remote: string, local: string): Promise<void>;
  sync?(local: string, remote: string): Promise<number>;
  lifecycle(action: 'stop' | 'resume' | 'destroy', checkpoint?: (patch: Partial<Profile>) => Promise<void>): Promise<Partial<Profile> | void>;
  ensureManaged?(request: ManagedRequest): Promise<Profile>;
  guard?(minutes: number): Promise<void>;
  idle?(minutes: number): Promise<void>;
  close?(): Promise<void> | void;
}
export interface Entry { path: string; sha256: string; size: number; mode: number }
export interface Snapshot { dir: string; files: Entry[]; bytes: number; digest: string; cacheKey: string; milliseconds: number; cleanup(): Promise<void> }
export type JobStatus = 'preparing' | 'running' | 'exited' | 'cancelled' | 'timed_out' | 'failed' | 'unknown';
export interface Job {
  id: string;
  project: string;
  profile: Profile;
  root: string;
  command: string;
  cwd: string;
  createdAt: string;
  status: JobStatus;
  code?: number;
  error?: string;
  cacheWarning?: string;
  cost?: { estimatedUsd: number; runtimeSeconds: number; source: 'estimate'; balance: 'unavailable' };
  metrics?: { inputBytes: number; inputMs: number; transferredBytes: number; transferMs: number; cacheKey: string; provisionMs?: number; executionMs?: number; cacheHit?: boolean; cacheSaved?: boolean; cacheRestoreMs?: number; cacheSaveMs?: number };
}
