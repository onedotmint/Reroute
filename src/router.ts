import { parse } from 'shell-quote';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config, Category, Decision, Router } from './types.js';
const control = new Set(['git','gh','rg','grep','find','ls','cat','sed','awk','ssh','scp','rsync','sky','daytona','modal','e2b','aws','gcloud','az','kubectl','docker','podman','reroute','bash','sh','zsh','fish','env','sudo','su','rm','mv','cp','chmod','chown','curl','wget','xargs']);
const identity = /^(?:publish|login|logout|deploy|release|auth|token|config|install|add|remove|update)$/;
/** Conservative lexical parsing: never interpret expansion, redirection, pipelines, subshells, cd or nested shells as a safe task. */
export function words(command: string): string[] | undefined {
  if (!command.trim() || /[\0\r\n$`;|&<>(){}]/.test(command)) return undefined;
  // shell-quote accepts unterminated quotes; reject them rather than guessing a task.
  let quote: string | undefined, escaped = false;
  for (const char of command) {
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = undefined; }
    else if (char === "'" || char === '"') quote = char;
  }
  if (quote || escaped) return undefined;
  try {
    const tokens = parse(command);
    if (!tokens.length || tokens.some(x => typeof x !== 'string') || tokens.some(x => typeof x === 'string' && (x.startsWith('/') || x.includes('../')))) return undefined;
    return tokens as string[];
  } catch { return undefined; }
}
export function category(args: string[]): Category | undefined {
  const [exe, sub = '', task = ''] = args;
  const script = ['run','run-script'].includes(sub) ? task : sub;
  if (exe === 'cargo' && ['build','test','check','bench','clippy'].includes(sub)) return sub === 'bench' ? 'benchmark' : sub === 'test' ? 'test' : ['check','clippy'].includes(sub) ? 'check' : 'build';
  if (['npm','pnpm','yarn','bun'].includes(exe ?? '') && /^(build|test|check|lint|bench)(:[\w-]+)*$/.test(script)) return /^test/.test(script) ? 'test' : /^bench/.test(script) ? 'benchmark' : /^(check|lint)/.test(script) ? 'check' : 'build';
  if (['pytest','ctest','jest'].includes(exe ?? '') || (exe === 'node' && sub === '--test') || (exe === 'go' && sub === 'test') || (exe === 'vitest' && sub === 'run')) return 'test';
  if (['tsc','eslint','mypy'].includes(exe ?? '') || (exe === 'ruff' && sub === 'check')) return 'check';
  if ((exe === 'go' && sub === 'build') || (exe === 'cmake' && sub === '--build') || (['make','ninja'].includes(exe ?? '') && ['build','all'].includes(sub)) || (['vite','next'].includes(exe ?? '') && sub === 'build') || ['rollup','webpack'].includes(exe ?? '')) return 'build';
  if (['make','ninja'].includes(exe ?? '') && ['test','check','lint','bench'].includes(sub)) return sub === 'bench' ? 'benchmark' : sub === 'test' ? 'test' : 'check';
  return undefined;
}
async function scriptSafe(args: string[], cwd: string, depth = 0): Promise<boolean> {
  if (args.some(x => /^(?:--cwd|--prefix|--dir|--directory|-C|--watch|--watchAll|--serve|--ui|--preview)(?:=|$)/.test(x))) return false;
  if (!['npm','pnpm','yarn','bun'].includes(args[0]!)) return category(args) !== undefined;
  if (depth > 4) return false;
  const task = ['run','run-script'].includes(args[1] ?? '') ? args[2] : args[1];
  let pkg: { scripts?: Record<string,string> };
  try { pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')); } catch { return false; }
  if (!task || typeof pkg.scripts?.[task] !== 'string') return false;
  for (const key of ['pre' + task, task, 'post' + task]) {
    const raw = pkg.scripts?.[key]; if (!raw) continue;
    const nested = words(raw);
    if (!nested || nested.some(a => a.split(':').some(x => identity.test(x))) || !await scriptSafe(nested, cwd, depth + 1)) return false;
  }
  return true;
}
export const ruleRouter: Router = async (command, cwd, config) => {
  const local = (reason: string): Decision => ({ route: 'local', reason });
  if (config.mode === 'local') return local('local-mode');
  const args = words(command); if (!args) return local('complex-or-ambiguous-shell');
  if (control.has(args[0]!) || args.some(a => a.split(':').some(x => identity.test(x)))) return local('control-or-side-effect-command');
  if (args.some(x => /^(?:--cwd|--prefix|--dir|--directory|-C|--watch|--watchAll|--serve|--ui|--preview)(?:=|$)/.test(x))) return local('working-directory-change-or-long-running-mode');
  if (args.some(x => ['--help','--version','-h','-V'].includes(x))) return local('lightweight-inspection');
  const matches = (prefix: string[]) => prefix.every((v,i) => args[i] === v);
  if (config.local.some(matches)) return local('configured-local-prefix');
  if (config.remote.some(matches)) return { route: 'remote', reason: 'explicitly-trusted-remote-prefix' };
  const task = category(args);
  if (!task || !config.tasks.includes(task)) return local(task ? 'task-category-disabled' : 'unknown-task');
  if (!await scriptSafe(args, cwd)) return local('nested-script-not-proven-safe; configure a trusted prefix or use reroute exec');
  return { route: 'remote', reason: 'recognized-heavy-task', category: task };
};
