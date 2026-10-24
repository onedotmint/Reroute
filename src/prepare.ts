import { readFile, access } from 'node:fs/promises';
import { posix, join } from 'node:path';
import { words } from './router.js';
export interface Preparation { cwd: string; argv: string[] }
/** Native package-manager bootstrap only. Never install globally or resolve a mutable lockfile. */
export async function nodePreparation(input: string, cwd: string, command: string): Promise<Preparation | undefined> {
  const args=words(command);if(!args)return;
  const tools=['npm','pnpm','yarn','bun','node','tsc','eslint','vitest','vite','next','jest','rollup','webpack'];
  if(!tools.includes(args[0]??'')||['install','ci','add','remove','update','publish','login'].includes(args[1]??''))return;
  // Explicit directory-changing wrappers are left entirely to their caller.
  if(args.some(x=>/^(--cwd|--prefix|--dir|--directory|-C)(=|$)/.test(x)))return;
  let dir=cwd;
  for(;;){
    const path=join(input,dir);
    for(const [file,manager] of [['pnpm-lock.yaml','pnpm'],['npm-shrinkwrap.json','npm'],['package-lock.json','npm'],['yarn.lock','yarn'],['bun.lock','bun'],['bun.lockb','bun']]){
      try{await access(join(path,file!));}catch{continue;}
      let pkg:{packageManager?:string};try{pkg=JSON.parse(await readFile(join(path,'package.json'),'utf8'));}catch{throw new Error(`Lockfile without a readable package.json: ${dir}/${file}`);}
      const executable=['npm','pnpm','yarn','bun'].includes(args[0]!)?args[0]!:manager!;
      if(executable!==manager)continue;
      const argv=manager==='npm'?['npm','ci','--no-audit','--no-fund']:manager==='pnpm'?['pnpm','install','--frozen-lockfile']:manager==='bun'?['bun','install','--frozen-lockfile']:['yarn','install',Number(pkg.packageManager?.match(/^yarn@(\d+)/)?.[1])>=2?'--immutable':'--frozen-lockfile'];
      return {cwd:dir,argv};
    }
    if(dir==='.')return;dir=posix.dirname(dir);
  }
}
