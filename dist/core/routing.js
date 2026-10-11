import { basename, delimiter, relative, resolve, sep } from 'node:path';
import { hash, contained } from '../platform/files.js';
import { invariant } from './errors.js';
export const RUNTIME_COMMANDS = [
    'cargo', 'rustc', 'rustup', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno',
    'python', 'python3', 'pip', 'pip3', 'uv', 'pytest', 'ruff', 'mypy', 'poetry', 'pdm',
    'cmake', 'make', 'ninja', 'gcc', 'g++', 'clang', 'clang++', 'cc', 'c++', 'ctest',
    'go', 'java', 'javac', 'mvn', 'gradle'
];
const CONTROL = new Set(['git', 'gh', 'rg', 'grep', 'find', 'ls', 'cat', 'sed', 'awk', 'ssh', 'scp', 'rsync', 'sky', 'daytona', 'modal', 'e2b', 'aws', 'gcloud', 'az', 'kubectl', 'docker', 'podman', 'reroute']);
const IDENTITY = new Set(['publish', 'login', 'logout', 'whoami', 'deploy', 'token', 'tokens', 'auth', 'owner', 'owners', 'config', 'credential', 'credentials']);
export function route(argv, commands = RUNTIME_COMMANDS) {
    const executable = basename(argv[0] ?? '').replace(/\.(exe|cmd)$/i, '');
    if (CONTROL.has(executable))
        return 'local';
    if (['cargo', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'uv', 'poetry', 'pdm', 'deno'].includes(executable) && argv.slice(1).some(x => IDENTITY.has(x)))
        return 'local';
    return commands.includes(executable) ? 'remote' : 'local';
}
const SECRET_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|AUTHORIZATION|COOKIE|SESSION|^AWS_|^AZURE_|^GOOGLE_|^GITHUB_|^GH_|^DAYTONA_|^MODAL_|^E2B_|^DSH_)/i;
const CONTROL_ENV = /^(?:PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|SHLVL|_|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|BASH_ENV|ENV|SSH_.*|REROUTE_.*|LD_.*|DYLD_.*|XDG_.*)$/;
export function isControlEnv(key) { return CONTROL_ENV.test(key); }
export function isSecretName(key) { return SECRET_NAME.test(key); }
export function environmentBaseline(env) {
    return JSON.stringify(Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && !SECRET_NAME.test(k) && !CONTROL_ENV.test(k)).map(([k, v]) => [k, hash(v)])));
}
export function selectedEnvironment(env, allow = []) {
    let baseline;
    if (env.REROUTE_BASE_ENV) {
        try {
            baseline = JSON.parse(env.REROUTE_BASE_ENV);
        }
        catch {
            throw new Error('Invalid Reroute environment baseline');
        }
    }
    const result = {};
    const standard = new Set(['CI', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'LANG', 'LC_ALL', 'TZ', 'NODE_ENV', 'RUST_BACKTRACE', 'CARGO_TERM_COLOR']);
    for (const [key, val] of Object.entries(env)) {
        if (val === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || SECRET_NAME.test(key) || CONTROL_ENV.test(key))
            continue;
        if (standard.has(key) || allow.includes(key) || (baseline && baseline[key] !== hash(val)))
            result[key] = val;
    }
    return result;
}
export function unshimmedPath(path, shimDir) {
    return (path ?? '').split(delimiter).filter(p => resolve(p || '.') !== resolve(shimDir)).join(delimiter);
}
export function remoteCwd(localRoot, cwd, remoteRoot) {
    invariant(contained(localRoot, cwd), 'CWD_OUTSIDE_PROJECT', 'Current directory is outside the enabled project');
    return remoteRoot.replace(/\/$/, '') + (relative(localRoot, cwd) ? '/' + relative(localRoot, cwd).split(sep).join('/') : '');
}
export function mapArgv(argv, localRoot, remoteRoot) {
    return argv.map(arg => {
        if (arg === localRoot || arg.startsWith(localRoot + sep))
            return remoteRoot + arg.slice(localRoot.length).split(sep).join('/');
        const equals = arg.indexOf('=');
        if (equals > 0 && (arg.slice(equals + 1) === localRoot || arg.slice(equals + 1).startsWith(localRoot + sep)))
            return arg.slice(0, equals + 1) + remoteRoot + arg.slice(equals + 1 + localRoot.length).split(sep).join('/');
        return arg;
    });
}
