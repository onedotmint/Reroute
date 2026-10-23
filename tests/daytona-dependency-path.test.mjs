import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Image} from '@daytona/sdk';
import {DaytonaProvider} from '../dist/providers/daytona.js';
import {TOOLCHAIN_IMAGE} from '../dist/toolchain.js';

// Exercise the actual SDK image builder; all control-plane operations are offline fixtures.
test('Reroute starter and registry image paths never invoke local COPY glob expansion',async t=>{
 const root=await mkdtemp(join(tmpdir(),'reroute-dependency-path-'));
 const oldConfig=process.env.XDG_CONFIG_HOME,oldKey=process.env.DAYTONA_API_KEY;
 process.env.XDG_CONFIG_HOME=root;process.env.DAYTONA_API_KEY='FAKE_OFFLINE_KEY';
 const require=createRequire(import.meta.url),sdkRequire=createRequire(require.resolve('@daytona/sdk/package.json'));
 assert.equal(sdkRequire('@daytona/sdk/package.json').dependencies['fast-glob'],undefined);
 const globPath=sdkRequire.resolve('tinyglobby'),original=sdkRequire('tinyglobby');let globCalls=0;
 sdkRequire.cache[globPath].exports={...original,globSync:()=>{globCalls++;throw Error('Unexpected local COPY glob expansion');}};
 t.after(async()=>{sdkRequire.cache[globPath].exports=original;if(oldConfig===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=oldConfig;if(oldKey===undefined)delete process.env.DAYTONA_API_KEY;else process.env.DAYTONA_API_KEY=oldKey;await rm(root,{recursive:true,force:true});});
 for(const image of [TOOLCHAIN_IMAGE,'registry.example.invalid/toolchain:fixture']){
  let sent;
  const sandbox={id:'fake-sandbox',state:'started',cpu:2,memory:4,labels:{'reroute-managed':'v3','reroute-owner':'fake-owner'}};
  const sdk={Image,Daytona:class{
   async *list(){}
   volume={get:async()=>({id:'fake-volume',state:'ready'})};
   async create(params){sent=params;return sandbox;}
  }};
  const profile={provider:'daytona',id:'auto',image,compute:{cpu:2,memoryGiB:4},managed:{authorized:true}};
  await new DaytonaProvider(profile,async()=>sdk).ensureManaged({owner:'fake-owner',name:'fake-name',create:true,start:false,guardMinutes:6});
  if(image===TOOLCHAIN_IMAGE){assert.ok(sent.image instanceof Image);assert.deepEqual(sent.image.contextList,[]);}
  else assert.equal(sent.image,image);
 }
 assert.equal(globCalls,0);
});
