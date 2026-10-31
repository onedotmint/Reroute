// Record full-tree findings separately; only production high/critical findings block release.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const output = resolve('.artifacts');
await mkdir(output, { recursive: true });
let blocked = false;
for (const [scope, flags] of [['production', ['--omit=dev']], ['full', []]]) {
  const result = spawnSync('npm', ['audit', '--json', '--audit-level=high', ...flags], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
  });
  const report = JSON.parse(result.stdout);
  assert.ok(report.metadata?.vulnerabilities && !report.error, `${scope}: audit did not return a valid report`);
  assert.ok(result.status === 0 || result.status === 1, `${scope}: audit failed: ${result.stderr || result.error}`);
  await writeFile(join(output, `audit-${scope}.json`), JSON.stringify({ exitCode: result.status, report }, null, 2) + '\n');
  console.log(JSON.stringify({ scope, exitCode: result.status, vulnerabilities: report.metadata.vulnerabilities }));
  if (scope === 'production') blocked = result.status !== 0;
  else if (result.status !== 0) console.warn('Development/host tree has high vulnerabilities; see audit-full.json and docs/DEPENDENCY-SECURITY.md. This is NOT a clean full-tree audit.');
}
process.exitCode = blocked ? 1 : 0;
