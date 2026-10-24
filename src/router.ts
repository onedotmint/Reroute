import { parse } from 'shell-quote';
import type { Category, Decision, Router } from './types.js';
const control = new Set(['git','gh','rg','grep','find','ls','cat','sed','awk','ssh','scp','rsync','sky','daytona','modal','e2b','aws','gcloud','az','kubectl','docker','podman','reroute','bash','sh','zsh','fish','env','sudo','su','rm','mv','cp','chmod','chown','curl','wget','xargs']);
const identity = /^(?:publish|login|logout|deploy|release|auth|token|config|install|add|remove|update)(?:$|[-_])/;
/** Parse one argv-shaped command; shell control syntax is never interpreted or executed. */
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
    if (!tokens.length || tokens.some(x => typeof x !== 'string') || tokens.some(x => typeof x === 'string' && (x.startsWith('/') || x.startsWith('~') || /^--(?:manifest-path|project|config|file|output|out-dir|outDir|root|target-dir|cache-dir)=\//.test(x) || x.includes('../')))) return undefined;
    return tokens as string[];
  } catch { return undefined; }
}
export function category(args: string[]): Category | undefined {
  const [exe, sub = '', task = ''] = args;
  const script = ['run','run-script'].includes(sub) ? task : sub;
  if (exe === 'cargo' && ['build','test','check','bench','clippy'].includes(sub)) return sub === 'bench' ? 'benchmark' : sub === 'test' ? 'test' : ['check','clippy'].includes(sub) ? 'check' : 'build';
  if (['npm','pnpm','yarn','bun'].includes(exe ?? '')) {
    if (/^(build|test|check|lint|bench)(:[\w-]+)*$/.test(script)) return /^test/.test(script) ? 'test' : /^bench/.test(script) ? 'benchmark' : /^(check|lint)/.test(script) ? 'check' : 'build';
    // Trust the selected project script, not a recursive whitelist of its implementation.
    if (['run','run-script'].includes(sub) && task && !task.startsWith('-')) return 'build';
  }
  if (['pytest','ctest','jest'].includes(exe ?? '') || (exe === 'node' && sub === '--test') || (exe === 'go' && sub === 'test') || (exe === 'vitest' && sub === 'run')) return 'test';
  if (['tsc','eslint','mypy'].includes(exe ?? '') || (exe === 'ruff' && sub === 'check')) return 'check';
  if ((exe === 'go' && sub === 'build') || (exe === 'cmake' && sub === '--build') || (['make','ninja'].includes(exe ?? '') && ['build','all'].includes(sub)) || (['vite','next'].includes(exe ?? '') && sub === 'build') || ['rollup','webpack'].includes(exe ?? '')) return 'build';
  if (['make','ninja'].includes(exe ?? '') && ['test','check','lint','bench'].includes(sub)) return sub === 'bench' ? 'benchmark' : sub === 'test' ? 'test' : 'check';
  if ((exe === 'node' && /\.(?:mjs|cjs|js|ts)$/.test(sub) || /^python(?:3)?$/.test(exe ?? '') && sub.endsWith('.py')) && !sub.startsWith('-')) return 'build';
  if (exe?.startsWith('./') || ['make','ninja'].includes(exe ?? '') && sub && !sub.startsWith('-')) return 'build';
  return undefined;
}
function prohibitedEntry(value = ''): boolean {
  const name = value.split('/').pop()!.replace(/\.[^.]+$/, '');
  return control.has(name) || name.split(':').some(part => identity.test(part));
}
export const ruleRouter: Router = async (command, _cwd, config) => {
  const local = (reason: string): Decision => ({ route: 'local', reason });
  if (config.mode === 'local') return local('local-mode');
  const args = words(command); if (!args) return local('complex-or-ambiguous-shell');
  const [exe, sub, scriptName] = args;
  const entry = ['npm','pnpm','yarn','bun'].includes(exe!) && ['run','run-script'].includes(sub ?? '') ? scriptName
    : ['node','python','python3'].includes(exe!) ? sub : exe;
  if (prohibitedEntry(exe) || prohibitedEntry(entry) || args.some(a => a.split(':').some(x => identity.test(x)))) return local('control-or-side-effect-command');
  if (args.some(x => /^(?:-C|(?:--cwd|--prefix|--dir|--directory|--watch|--watchAll|--serve|--ui|--preview)(?:=|$))/.test(x))) return local('working-directory-change-or-long-running-mode');
  if (args.some(x => ['--help','--version','-h','-V'].includes(x))) return local('lightweight-inspection');
  const matches = (prefix: string[]) => prefix.every((v,i) => args[i] === v);
  if (config.local.some(matches)) return local('configured-local-prefix');
  if (config.remote.some(matches)) return { route: 'remote', reason: 'explicitly-trusted-remote-prefix' };
  const task = category(args);
  if (!task || !config.tasks.includes(task)) return local(task ? 'task-category-disabled' : 'unknown-task');
  return { route: 'remote', reason: 'recognized-heavy-task', category: task };
};
