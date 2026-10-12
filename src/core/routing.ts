import { basename, delimiter, relative, resolve, sep } from 'node:path';
import { hash, contained } from '../platform/files.js';
import { invariant } from './errors.js';
export const RUNTIME_COMMANDS = [
  'cargo', 'rustc', 'rustup', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno',
  'python', 'python3', 'pip', 'pip3', 'uv', 'pytest', 'ruff', 'mypy', 'poetry', 'pdm',
  'cmake', 'make', 'ninja', 'gcc', 'g++', 'clang', 'clang++', 'cc', 'c++', 'ctest',
  'go', 'java', 'javac', 'mvn', 'gradle'
];
const CONTROL = new Set(['git','gh','rg','grep','find','ls','cat','sed','awk','ssh','scp','rsync','sky','daytona','modal','e2b','aws','gcloud','az','kubectl','docker','podman','reroute','bash','sh','zsh','fish','cmd','powershell','pwsh','env','sudo','su','rm','mv','cp','chmod','chown','curl','wget','xargs']);
const IDENTITY = new Set(['publish','login','logout','whoami','deploy','release','token','tokens','auth','owner','owners','config','credential','credentials']);
export const TASK_CATEGORIES = ['build', 'test', 'check', 'benchmark'] as const;
export type TaskCategory = typeof TASK_CATEGORIES[number];
type TaskRules = { mode?: 'tasks'|'legacy'; tasks?: TaskCategory[]; local?: string[][]; remote?: string[][] };
export function routingDecision(argv: string[], commands = RUNTIME_COMMANDS, rules: TaskRules = {}, explicit = false): { executable: string; route: 'local' | 'remote'; rule: string } {
  const executable = basename(argv[0] ?? '').replace(/\.(exe|cmd)$/i, '');
  const decision = (route: 'local'|'remote', rule: string) => ({ executable, route, rule });
  if (CONTROL.has(executable)) return decision('local', 'control-command');
  if (['cargo','npm','npx','pnpm','yarn','bun','uv','poetry','pdm','deno','pip','pip3','mvn','gradle','make','ninja','cmake','go'].includes(executable) && argv.slice(1).some(x => x.split(':').some(part => IDENTITY.has(part)))) return decision('local', 'identity-subcommand');
  if (!executable || /[\0\r\n\s]/.test(argv[0] ?? '') || argv.some(x => ['&&','||',';','|','>','>>','<','&'].includes(x))) return decision('local', 'ambiguous-command');
  if (explicit) return decision('remote', 'explicit-remote');
  if (argv.slice(1).some(x => ['--version','--help','-V','-h'].includes(x))) return decision('local', 'lightweight-command');
  const matches = (prefix: string[]) => prefix.every((arg, i) => (i === 0 ? executable : argv[i]) === arg);
  if (rules.local?.some(matches)) return decision('local', 'project-local-rule');
  if (!commands.includes(executable)) return decision('local', 'not-configured-runtime-command');
  if (rules.remote?.some(matches)) return decision('remote', 'project-remote-rule');
  if (rules.mode === 'legacy') return decision('remote', 'configured-runtime-command');
  if (argv.length < 2 && !['pytest','ctest','make','ninja'].includes(executable)) return decision('local', 'lightweight-command');
  const sub = argv[1] ?? '', script = sub === 'run' || sub === 'run-script' ? argv[2] ?? '' : sub;
  const heavy =
    (executable === 'cargo' && ['build','test','check','bench','clippy'].includes(sub)) ||
    (['npm','pnpm','yarn','bun'].includes(executable) && /^(?:build|test|check|lint|bench)(?::[A-Za-z0-9_-]+)*$/.test(script)) ||
    (['make','ninja'].includes(executable) && ['', 'all','build','test','check','bench'].includes(sub)) ||
    (['pytest','ctest','rustc','gcc','g++','clang','clang++','cc','c++','javac','mypy'].includes(executable)) ||
    (executable === 'cmake' && ['--build','--workflow'].includes(sub)) ||
    (executable === 'go' && ['build','test'].includes(sub)) ||
    (['mvn','gradle'].includes(executable) && ['build','test','check','compile','package','verify'].includes(sub)) ||
    (executable === 'ruff' && ['check','format'].includes(sub)) ||
    (executable === 'deno' && ['test','bench','check','compile'].includes(sub));
  if (!heavy) return decision('local', 'unknown-or-light-task');
  const category: TaskCategory = ['pytest','ctest'].includes(executable) || /^(test)(:|$)/.test(script) ? 'test' :
    /^(bench)(:|$)/.test(script) ? 'benchmark' :
    ['ruff','mypy'].includes(executable) || /^(check|lint|clippy|verify)(:|$)/.test(script) ? 'check' : 'build';
  return rules.tasks && !rules.tasks.includes(category) ? decision('local', 'task-category-disabled') : decision('remote', 'heavy-task-candidate');
}
export function route(argv: string[], commands = RUNTIME_COMMANDS, rules: TaskRules = {}, explicit = false): 'local' | 'remote' { return routingDecision(argv, commands, rules, explicit).route; }
const SECRET_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|AUTHORIZATION|COOKIE|SESSION|^AWS_|^AZURE_|^GOOGLE_|^GITHUB_|^GH_|^DAYTONA_|^MODAL_|^E2B_|^DSH_)/i;
const CONTROL_ENV = /^(?:PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|SHLVL|_|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|BASH_ENV|ENV|SSH_.*|REROUTE_.*|LD_.*|DYLD_.*|XDG_.*)$/;
export function isControlEnv(key: string): boolean { return CONTROL_ENV.test(key); }
export function isSecretName(key: string): boolean { return SECRET_NAME.test(key); }
export function environmentBaseline(env: NodeJS.ProcessEnv): string {
  return JSON.stringify(Object.fromEntries(Object.entries(env).filter(([k,v]) => v !== undefined && !SECRET_NAME.test(k) && !CONTROL_ENV.test(k)).map(([k,v]) => [k, hash(v!)])));
}
export function selectedEnvironment(env: NodeJS.ProcessEnv, allow: string[] = []): Record<string, string> {
  let baseline: Record<string, string> | undefined;
  if (env.REROUTE_BASE_ENV) {
    try { baseline = JSON.parse(env.REROUTE_BASE_ENV); } catch { throw new Error('Invalid Reroute environment baseline'); }
  }
  const result: Record<string, string> = {};
  const standard = new Set(['CI','TERM','COLORTERM','NO_COLOR','FORCE_COLOR','LANG','LC_ALL','TZ','NODE_ENV','RUST_BACKTRACE','CARGO_TERM_COLOR']);
  for (const [key, val] of Object.entries(env)) {
    if (val === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || SECRET_NAME.test(key) || CONTROL_ENV.test(key)) continue;
    if (standard.has(key) || allow.includes(key) || (baseline && baseline[key] !== hash(val))) result[key] = val;
  }
  return result;
}
export function unshimmedPath(path: string | undefined, shimDir: string): string {
  return (path ?? '').split(delimiter).filter(p => resolve(p || '.') !== resolve(shimDir)).join(delimiter);
}
export function remoteCwd(localRoot: string, cwd: string, remoteRoot: string): string {
  invariant(contained(localRoot, cwd), 'CWD_OUTSIDE_PROJECT', 'Current directory is outside the enabled project');
  return remoteRoot.replace(/\/$/, '') + (relative(localRoot, cwd) ? '/' + relative(localRoot, cwd).split(sep).join('/') : '');
}
export function mapArgv(argv: string[], localRoot: string, remoteRoot: string): string[] {
  return argv.map(arg => {
    if (arg === localRoot || arg.startsWith(localRoot + sep)) return remoteRoot + arg.slice(localRoot.length).split(sep).join('/');
    const equals = arg.indexOf('=');
    if (equals > 0 && (arg.slice(equals + 1) === localRoot || arg.slice(equals + 1).startsWith(localRoot + sep))) return arg.slice(0, equals + 1) + remoteRoot + arg.slice(equals + 1 + localRoot.length).split(sep).join('/');
    return arg;
  });
}
