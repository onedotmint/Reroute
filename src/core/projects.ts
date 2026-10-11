import { promises as fs } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectState, ProviderId } from './contracts.js';
import { invariant, errorCode } from './errors.js';
import { readJSON, writeJSON, exists, home, privateDir } from '../platform/files.js';
import { SerialLane } from './queue.js';
const identityFile = (root: string) => join(root, '.reroute', 'project.json');
export async function findProject(cwd: string): Promise<ProjectState | undefined> {
  let path = await fs.realpath(cwd);
  for (;;) {
    const data = await readJSON<ProjectState>(identityFile(path));
    if (data) {
      invariant(data.version === 1 && typeof data.enabled === 'boolean' && /^[a-f0-9-]{36}$/.test(data.project?.id ?? ''), 'PROJECT_STATE', 'Invalid project identity. Run reroute doctor.');
      invariant(data.project.root === path, 'PROJECT_MOVED', 'Project path changed or identity was copied. Run reroute enable --new-identity in the new location.');
      return data;
    }
    if (dirname(path) === path) return undefined;
    path = dirname(path);
  }
}
export async function projectRoot(cwd: string): Promise<string> {
  let path = await fs.realpath(cwd); const initial = path;
  for (;;) {
    if (await exists(join(path, '.git'))) return path;
    if (dirname(path) === path) return initial;
    path = dirname(path);
  }
}
/** Only the coordinator writes enabled-project identities and runtime state. */
export class ProjectStore {
  private lane = new SerialLane();
  async enable(cwd: string, provider: ProviderId, override: Record<string, unknown>, fresh = false): Promise<ProjectState> {
    return this.lane.run(async () => {
      const root = await projectRoot(cwd);
      const previous = await readJSON<ProjectState>(identityFile(root));
      if (fresh && previous?.runtime) invariant(typeof previous.project?.root === 'string' && previous.project.root !== root, 'PROJECT_RUNTIME', 'Destroy the current project runtime with reroute stop --destroy before rebuilding its identity');
      const old = fresh ? undefined : previous;
      if (old) invariant(old.project?.root === root, 'PROJECT_MOVED', 'Use reroute enable --new-identity after moving or copying a project');
      invariant(!old?.runtime || old.provider === provider, 'PROVIDER_CHANGE', 'Stop/destroy the existing runtime before changing provider');
      const state: ProjectState = old ?? { version: 1, project: { id: randomUUID(), root, name: basename(root) }, enabled: true, provider, override: {} };
      state.enabled = true; state.provider = provider; state.override = override;
      await privateDir(join(root, '.reroute')); await this.save(state);
      if (fresh && previous?.project?.root === root && /^[a-f0-9-]{36}$/.test(previous.project.id)) await fs.rm(join(home(), 'projects', `${previous.project.id}.json`), { force: true });
      const ignore = join(root, '.gitignore');
      let text = ''; try { text = await fs.readFile(ignore, 'utf8'); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
      if (!text.split(/\r?\n/).some(line => line === '.reroute/' || line === '/.reroute/')) await fs.appendFile(ignore, `${text && !text.endsWith('\n') ? '\n' : ''}# Reroute machine-local identity and conflict state\n.reroute/\n`);
      return state;
    });
  }
  async save(state: ProjectState): Promise<void> {
    await writeJSON(identityFile(state.project.root), state);
    await privateDir(join(home(), 'projects'));
    await writeJSON(join(home(), 'projects', `${state.project.id}.json`), state);
  }
  async all(): Promise<ProjectState[]> {
    const directory = join(home(), 'projects'); if (!await exists(directory)) return [];
    const result: ProjectState[] = [];
    for (const file of await fs.readdir(directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      const state = await readJSON<ProjectState>(join(directory, file));
      if (state) result.push(state);
    }
    return result;
  }
}
