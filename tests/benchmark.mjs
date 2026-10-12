import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshot } from '../dist/snapshot.js';
const root=await mkdtemp(join(tmpdir(),'reroute-measure-'));
try{
 const bytes=Buffer.alloc(65536,65);for(let i=0;i<128;i++)await writeFile(join(root,`source-${i}.txt`),bytes);
 const cpu=process.cpuUsage(),memory=process.memoryUsage(),a=await snapshot(root),used=process.cpuUsage(cpu);
 const result={scope:'local synthetic input only; 128 files / 8 MiB; no remote acceleration or CPU reduction claim',inputBytes:a.bytes,files:a.files.length,prepareMs:a.milliseconds,cpuUserMs:used.user/1000,cpuSystemMs:used.system/1000,rssBeforeBytes:memory.rss,rssAfterBytes:process.memoryUsage().rss};await a.cleanup();await mkdir('.artifacts',{recursive:true});await writeFile('.artifacts/input-measurement.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await rm(root,{recursive:true,force:true});}
