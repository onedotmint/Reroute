import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function files(directory, prefix = '') {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(prefix, entry.name);
    return entry.isDirectory() ? files(join(directory, entry.name), path) : [path];
  }).sort();
}

export function checkDist(project = root) {
  const compiler = join(project, '.tools/node_modules/typescript/bin/tsc');
  if (!existsSync(compiler)) throw new Error('Install the build toolchain in .tools first (TypeScript 5.8.3 and @types/node@22).');
  const output = mkdtempSync(join(tmpdir(), 'reroute-dist-check-'));
  try {
    // Compile elsewhere: rebuilding dist first would hide stale committed output.
    const result = spawnSync(process.execPath, [compiler, '--project', 'tsconfig.json', '--outDir', output, '--incremental', 'false'], { cwd: project, encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error(`Temporary build failed: ${result.error?.message ?? result.stdout + result.stderr}`);
    const dist = join(project, 'dist');
    const generated = files(output), delivered = files(dist);
    const mismatches = [...new Set([...generated, ...delivered])].filter(file =>
      !generated.includes(file) || !delivered.includes(file) || !readFileSync(join(output, file)).equals(readFileSync(join(dist, file)))
    );
    if (mismatches.length) throw new Error(`dist does not match src: ${mismatches.join(', ')}. Run npm run build and include the regenerated dist files.`);
    console.log('dist matches a fresh temporary build.');
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { checkDist(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
