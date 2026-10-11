import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const local = resolve('.tools/node_modules/typescript/bin/tsc');
const args = ['--project', 'tsconfig.json', ...(process.argv.includes('--check') ? ['--noEmit'] : [])];
const result = existsSync(local)
  ? spawnSync(process.execPath, [local, ...args], { stdio: 'inherit' })
  : spawnSync(process.platform === 'win32' ? 'tsc.cmd' : 'tsc', args, { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error) console.error('Install the build toolchain: npm install --prefix .tools --no-save typescript@5.8.3 @types/node@22');
process.exitCode = result.status ?? 1;
