import { delimiter, join } from 'node:path';
import { promises as fs } from 'node:fs';
import { home, cliPath, atomicWrite, privateDir } from '../platform/files.js';
import { environmentBaseline, RUNTIME_COMMANDS, unshimmedPath } from './routing.js';
import { shellCommand, quote } from '../platform/process.js';
import { invariant } from './errors.js';
export function activationEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const dir = join(home(), 'shims');
  return { ...env, PATH: dir + delimiter + unshimmedPath(env.PATH, dir), REROUTE_BASE_ENV: environmentBaseline(env), REROUTE_ACTIVE: '1' };
}
export function bridgeCommand(command: string): string {
  invariant(typeof command === 'string' && !command.includes('\0'), 'HOOK_PROTOCOL', 'Invalid shell command');
  const prefix = shellCommand([process.execPath, cliPath(), 'shell', '--']);
  return command.startsWith(prefix + ' ') ? command : prefix + ' ' + quote(command);
}
export async function installShims(commands: string[] = RUNTIME_COMMANDS): Promise<void> {
  const dir = join(home(), 'shims'); await privateDir(dir);
  for (const name of new Set([...RUNTIME_COMMANDS, ...commands])) {
    invariant(/^[A-Za-z0-9_+.-]+$/.test(name) && !name.startsWith('.'), 'CONFIG', 'Unsafe shim executable name');
    const path = join(dir, name);
    const text = '#!/bin/sh\n# Managed by Reroute\nexec ' + shellCommand([process.execPath, cliPath(), 'shim', name]) + ' "$@"\n';
    await atomicWrite(path, text); await fs.chmod(path, 0o700);
    if (process.platform === 'win32') {
      invariant(!/["%\r\n]/.test(process.execPath + cliPath()), 'WINDOWS_PATH', 'Install path cannot contain quotes, percent or newlines');
      await atomicWrite(path + '.cmd', `@echo off\r\n"${process.execPath}" "${cliPath()}" shim ${name} %*\r\n`);
    }
  }
}
