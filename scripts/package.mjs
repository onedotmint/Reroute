import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
function run(command,args,options={}) {
  const result=spawnSync(command,args,{encoding:'utf8',...options});
  if(result.error||result.status!==0)throw new Error(`${command} failed: ${result.error?.message??result.stderr??result.status}`);
  return result.stdout??'';
}
const root=fileURLToPath(new URL('..',import.meta.url));
const output=resolve(process.argv[2]??join(root,'..'));
mkdirSync(output,{recursive:true});
const git=args=>run('git',args,{cwd:root}).trim();
if(git(['status','--porcelain']))throw new Error('Commit or remove all intended changes before packaging. Dirty trees are not archived.');
const files=run('git',['ls-files','-z'],{cwd:root}).split('\0').filter(Boolean);
const forbidden=new Set(['node_modules','.tools','.git','.reroute','target','__pycache__']);
for(const file of files){
  if(file.split('/').some(part=>forbidden.has(part)||part==='.env'||part.startsWith('.env.'))||/\.(zip|tgz|key|pem|p12|pfx)$/.test(file))throw new Error('Disallowed archive path: '+file);
  if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(readFileSync(join(root,file),'utf8')))throw new Error('Possible private key: '+file);
}
const metadata={branch:git(['branch','--show-current']),commit:git(['rev-parse','HEAD']),tree:git(['rev-parse','HEAD^{tree}']),workingTree:'clean',createdAt:new Date().toISOString(),files:files.length,note:'Archive adds only this generated provenance file to the committed canonical source tree.'};
const archive=join(output,'reroute-source.zip'),temp=mkdtempSync(join(tmpdir(),'reroute-package-'));
try{
  run('git',['archive','--format=zip','--prefix=reroute/','--output='+archive,'HEAD'],{cwd:root});
  const metadataFile=join(temp,'state.json');writeFileSync(metadataFile,JSON.stringify(metadata,null,2)+'\n');
  run('python3',['-c',"import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'a',compression=zipfile.ZIP_DEFLATED); z.write(sys.argv[2],'reroute/DELIVERY-STATE.json'); z.close()",archive,metadataFile]);
  run('python3',['-c',"import zipfile,sys,pathlib; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert all(not n.startswith('/') and '..' not in pathlib.PurePosixPath(n).parts for n in z.namelist()); z.extractall(sys.argv[2])",archive,temp]);
  const extracted=join(temp,'reroute');
  for(const file of ['README.md','LICENSE','NOTICE','docs/verification/ORIGINAL-DELIVERY.md','DELIVERY-STATE.json','package.json','package-lock.json','pnpm-lock.yaml','bin/reroute.mjs','dist/cli/main.js','assets/worker.py','docs/ARCHITECTURE.md','docs/PROVIDERS.md','docs/HARNESSES.md','docs/TESTING.md'])if(!existsSync(join(extracted,file)))throw new Error('Missing required delivery file: '+file);
  const help=run(process.execPath,['bin/reroute.mjs','--help'],{cwd:extracted});if(!help.includes('Reroute'))throw new Error('Extracted CLI smoke failed');
  // These unit and harness fixtures use actual extracted modules, no install step.
  const tests=run(process.execPath,['--test','--test-reporter=tap','tests/unit/core.test.mjs','tests/harness/adapters.test.mjs'],{cwd:extracted});
  if(!tests.includes('# fail 0'))throw new Error('Extracted unit/harness verification did not confirm success');
  writeFileSync(join(output,'reroute-packaging-report.json'),JSON.stringify({...metadata,archive:basename(archive),sha256:createHash('sha256').update(readFileSync(archive)).digest('hex'),archiveExtracted:true,requiredContentsVerified:true,forbiddenPathsChecked:true,embeddedPrivateKeyHeadersChecked:true,extractedCliSmoke:true,extractedUnitAndHarnessTests:'passed',tests:tests.trim().split('\n').slice(-9)},null,2)+'\n');
  console.log(JSON.stringify({archive,commit:metadata.commit,extracted:true,smoke:'passed',extractedTests:'passed'},null,2));
}finally{rmSync(temp,{recursive:true,force:true});}
