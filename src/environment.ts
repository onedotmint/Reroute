import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';

export interface EnvironmentInspection { lines: string[]; warnings: string[] }
const nodeLocks = [
  ['npm-shrinkwrap.json', 'npm'], ['package-lock.json', 'npm'], ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'],
] as const;
const otherLocks = ['Cargo.lock', 'uv.lock', 'poetry.lock', 'Pipfile.lock', 'requirements.txt', 'requirements-dev.txt'];
const limit = 128 * 1024;

// shortcut: only root declarations and simple TOML string scalars; use a TOML parser if full manifest semantics become necessary.
function tomlValue(text: string | undefined, section: string, key: string): string | undefined {
  let current = '';
  for (const line of text?.split(/\r?\n/) ?? []) {
    const header = line.trim().match(/^\[([\w.-]+)\]\s*(?:#.*)?$/);
    if (header) current = header[1]!;
    else if (line.trim().startsWith('[')) current = '';
    if (current !== section) continue;
    const value = line.trim().match(new RegExp(`^${key}\\s*=\\s*["']([^"'\\r\\n]*)["']\\s*(?:#.*)?$`));
    if (value) return value[1];
  }
}

/** Read-only root-level hints, not executable setup instructions or proof of remote compatibility. */
export async function inspectEnvironment(rootInput: string): Promise<EnvironmentInspection> {
  const lines: string[] = [], warnings: string[] = [], present = new Set<string>();
  let root: string;
  try { root = await realpath(rootInput); }
  catch { return { lines, warnings: ['Environment root is unavailable; declarations were not inspected.'] }; }
  const read = async (name: string, content = true): Promise<string | undefined> => {
    let file;
    try {
      const path = join(root, name), info = await lstat(path);
      if (!info.isFile()) { warnings.push(`${name}: non-regular declaration ignored.`); return; }
      present.add(name);
      if (!content) return;
      if (info.size > limit) { warnings.push(`${name}: declaration exceeds 128 KiB; contents ignored.`); return; }
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!(await file.stat()).isFile()) { warnings.push(`${name}: non-regular declaration ignored.`); return; }
      const buffer = Buffer.alloc(limit + 1), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > limit) { warnings.push(`${name}: declaration exceeds 128 KiB; contents ignored.`); return; }
      return buffer.toString('utf8', 0, bytesRead);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`${name}: declaration could not be safely read.`);
    } finally { await file?.close(); }
  };
  const version = (label: string, value: unknown, channel = false) => {
    if (value === undefined) return;
    // Only version syntax is emitted, never arbitrary manifest strings, paths or URLs.
    const valid = typeof value === 'string' && value.length <= 80 && !/[\r\n]/.test(value) && (channel
      ? /^(?:\d+\.\d+(?:\.\d+)?|stable|beta|nightly)(?:-\d{4}-\d{2}-\d{2})?$/.test(value)
      : /^(?=.*\d)[0-9vxX.*<>=!~^|, +\-]+$/.test(value));
    if (valid) lines.push(`${label}: ${value}`);
    else warnings.push(`${label}: unsupported version declaration omitted.`);
  };
  for (const [name] of nodeLocks) await read(name, false);
  for (const name of otherLocks) await read(name, false);
  const pkgText = await read('package.json');
  let manager: string | undefined;
  if (present.has('package.json')) lines.push('Node.js: package.json');
  if (pkgText !== undefined) {
    try {
      const pkg: unknown = JSON.parse(pkgText);
      if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error();
      const { packageManager, engines } = pkg as { packageManager?: unknown; engines?: unknown };
      if (packageManager !== undefined) {
        const match = typeof packageManager === 'string' && packageManager.length <= 256
          ? packageManager.match(/^(npm|pnpm|yarn|bun)@(\d+\.\d+\.\d+(?:-(?:rc|beta|alpha|canary|next)\.\d+)?)(?:\+sha(?:224|256|384|512)\.[a-f0-9]+)?$/) : null;
        if (match) { manager = match[1]; lines.push(`Package manager: ${manager}@${match[2]}`); }
        else warnings.push('package.json packageManager: unsupported declaration omitted.');
      }
      if (engines && typeof engines === 'object' && !Array.isArray(engines)) {
        for (const name of ['node', 'npm', 'pnpm', 'yarn', 'bun']) version(`package.json engines.${name}`, (engines as Record<string, unknown>)[name]);
      }
    } catch { warnings.push('package.json: invalid manifest; declarations ignored.'); }
  }
  const locks = nodeLocks.filter(([name]) => present.has(name));
  if (locks.length) lines.push(`Node lockfiles: ${locks.map(([name]) => name).join(', ')}`);
  if (present.has('npm-shrinkwrap.json')) lines.push('npm effective lockfile: npm-shrinkwrap.json (takes precedence over package-lock.json)');
  else if (present.has('package-lock.json')) lines.push('npm effective lockfile: package-lock.json');
  if (new Set(locks.map(([, tool]) => tool)).size > 1) warnings.push('Multiple Node package-manager lockfiles; confirm the intended manager before running remotely.');
  if (manager && locks.length && !locks.some(([, tool]) => tool === manager)) warnings.push('Declared package manager does not match the available Node lockfiles.');
  if (present.has('package.json') && !locks.length) warnings.push('No supported Node lockfile; automatic dependency bootstrap is unavailable.');
  for (const name of ['.nvmrc', '.node-version', '.python-version']) {
    const value = (await read(name))?.trim();
    if (name !== '.python-version' && value && ['node', 'stable', 'lts/*'].includes(value)) lines.push(`${name}: ${value}`);
    else version(name, value);
  }
  const tools = await read('.tool-versions');
  for (const name of ['nodejs', 'node', 'npm', 'pnpm', 'yarn', 'bun', 'rust', 'python']) {
    const match = tools?.match(new RegExp(`^${name}[ \\t]+([^\\r\\n#]+?)[ \\t]*(?:#.*)?$`, 'm'));
    if (match) version(`.tool-versions ${name}`, match[1]?.trim(), name === 'rust');
  }
  const cargo = await read('Cargo.toml');
  if (present.has('Cargo.toml') || present.has('Cargo.lock')) lines.push('Rust: Cargo');
  if (present.has('Cargo.lock')) lines.push('Rust lockfile: Cargo.lock');
  version('Cargo.toml rust-version', tomlValue(cargo, 'package', 'rust-version'));
  version('Cargo.toml edition', tomlValue(cargo, 'package', 'edition'));
  version('rust-toolchain.toml channel', tomlValue(await read('rust-toolchain.toml'), 'toolchain', 'channel'), true);
  version('rust-toolchain channel', (await read('rust-toolchain'))?.trim(), true);
  const python = await read('pyproject.toml'), pipfile = await read('Pipfile');
  if (present.has('pyproject.toml') || present.has('Pipfile') || otherLocks.slice(1).some(name => present.has(name))) lines.push('Python: project declarations');
  version('pyproject.toml requires-python', tomlValue(python, 'project', 'requires-python'));
  version('pyproject.toml poetry python', tomlValue(python, 'tool.poetry.dependencies', 'python'));
  for (const key of ['python_version', 'python_full_version']) version(`Pipfile ${key}`, tomlValue(pipfile, 'requires', key));
  const pythonLocks = otherLocks.slice(1).filter(name => present.has(name));
  if (pythonLocks.length) lines.push(`Python dependency files: ${pythonLocks.join(', ')}`);
  warnings.push('Static declarations only; remote runtimes and compatibility are not verified. No environment changes were made.');
  return { lines, warnings };
}
