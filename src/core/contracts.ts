/** All provider/harness-independent contracts. Buffers carry bytes, not terminal text. */
export const PROTOCOL_VERSION = 1;
export type ProviderId = 'ssh' | 'daytona' | 'skypilot' | 'modal' | 'e2b';
export type RuntimeStatus = 'running' | 'stopped' | 'archived' | 'missing' | 'unknown';
export interface RuntimeSpec {
  cpu?: number; memoryMiB?: number; diskGiB?: number;
  gpu?: { type?: string; count?: number }; region?: string; image?: string; spot?: boolean;
  idleTimeoutMinutes: number;
  env: Record<string, string>;
}
export interface ProjectRef { id: string; root: string; name: string }
export interface RuntimeRef {
  id: string; provider: ProviderId; root: string; projectId: string;
  /** Non-secret provider-owned reconnect metadata only. */
  meta: Record<string, string>;
}
export interface Capabilities {
  resources: readonly ('cpu' | 'memoryMiB' | 'diskGiB' | 'gpu' | 'region' | 'image' | 'spot')[];
  persistence: 'disk' | 'volume' | 'ephemeral';
  idle: 'stop' | 'terminate' | 'none'; preview: boolean;
  stdin: boolean; nativeIdle: boolean;
}
export interface ExecRequest {
  argv: string[]; cwd: string; env: Record<string, string>; timeoutMs?: number;
}
export type ExecutionEvent = { type: 'output'; stream: 'stdout' | 'stderr'; data: Buffer };
export interface ExecutionExit { code: number; signal?: string; timedOut?: boolean; cancelled?: boolean }
export interface ExecutionHandle {
  events: AsyncIterable<ExecutionEvent>;
  wait(): Promise<ExecutionExit>;
  write(data: Buffer): Promise<void>;
  endInput(): Promise<void>;
  cancel(): Promise<void>;
}
export interface FileEntry { hash: string; size: number; mode: number }
export type Manifest = Record<string, FileEntry>;
export interface FileChange { path: string; expected: string | null; data: string | null; mode?: number }
export interface SyncPolicy { excludes: string[]; maxFileBytes: number; maxFiles: number; hashMode?: 'strict' | 'metadata' }
export interface ArtifactPolicy { paths: string[]; maxFileBytes: number }
export interface FileTransport {
  /** Internal scan-cache scope; never proof of remote ownership. */
  hashIdentity?: string;
  /** Bounded chunks; resolves only after content metadata and transport completion. */
  download?(path: string, policy: SyncPolicy, consume: (data: Buffer) => Promise<void>, artifact?: boolean): Promise<FileEntry>;
  readArtifact?(path: string, maxFileBytes: number): Promise<FileEntry & { data: string }>;
  invalidateHashes?(): void;
  scan(policy: SyncPolicy): Promise<Manifest>;
  read(paths: string[], policy: SyncPolicy): Promise<Record<string, string>>;
  apply(changes: FileChange[], policy: SyncPolicy): Promise<void>;
}
export interface IdlePolicy { active: boolean; minutes: number }
export interface RuntimeProvider {
  readonly id: ProviderId;
  readonly capabilities: Capabilities;
  ensureReady(project: ProjectRef, spec: RuntimeSpec, previous?: RuntimeRef): Promise<RuntimeRef>;
  status(runtime: RuntimeRef): Promise<RuntimeStatus>;
  /** Resume this exact runtime and verify its workspace; never provision a replacement. */
  restore?(project: ProjectRef, spec: RuntimeSpec, runtime: RuntimeRef): Promise<RuntimeRef>;
  exec(runtime: RuntimeRef, request: ExecRequest): Promise<ExecutionHandle>;
  files(runtime: RuntimeRef): FileTransport;
  applyIdlePolicy(runtime: RuntimeRef, policy: IdlePolicy): Promise<void>;
  destroy(runtime: RuntimeRef): Promise<void>;
  preview?(runtime: RuntimeRef, port: number): Promise<string>;
}
export interface ProjectConfig {
  provider: ProviderId;
  runtime: RuntimeSpec;
  providers: Record<string, Record<string, unknown>>;
  sync: SyncPolicy;
  artifacts?: ArtifactPolicy;
  authorization?: { paidProviders: ProviderId[] };
  routing: { commands: string[]; envAllow: string[]; mode?: 'tasks'|'legacy'; tasks?: ('build'|'test'|'check'|'benchmark')[]; local?: string[][]; remote?: string[][] };
}
export interface ProjectState {
  version: 1; project: ProjectRef; enabled: boolean;
  provider: ProviderId; override: Record<string, unknown>;
  runtime?: RuntimeRef; lastActivity?: number;
  /** Unreconciled remote source: retain the original runtime and suppress idle cleanup. */
  syncPending?: boolean;
}
export type ProviderFactory = (config: ProjectConfig) => RuntimeProvider;
