import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// Actual terminal widgets and disk writes, no mock prompts, model, SDK network or cloud calls.
const script=String.raw`
import json, os, pathlib, pty, re, select, subprocess, sys, tempfile, time, fcntl, struct, termios
node, entry, case = sys.argv[1:]
with tempfile.TemporaryDirectory(prefix='reroute-quick-setup-') as base:
    base=pathlib.Path(base)
    project=base/'project'; project.mkdir()
    config=base/'private'; secrets=config/'reroute'/'accounts'
    project_file=project/'.reroute.json'
    config_file=config/'reroute'/'config.json' if case=='global' else project_file
    original=None
    if case in ('keep','cancel-existing','add-account','global'):
        original={'version':3,'active':'old-ssh','mode':'auto','profiles':{
            'old-ssh':{'provider':'ssh','id':'existing-host','port':2200},
            'old-cloud':{'provider':'daytona','id':'existing-sandbox'}},
            'tasks':['test'],'remote':[['trusted','build']],'local':[['npm','test']],'timeoutSeconds':123}
        project_file.write_text(json.dumps(original))
        original_bytes=project_file.read_bytes()
    if case=='named':
        secrets.mkdir(parents=True,mode=0o700)
        path=secrets/'daytona.json'; path.write_text(json.dumps({'DAYTONA_API_KEY':'already-saved-private'}));path.chmod(0o600)
    if case=='unsafe':
        config=project/'private';secrets=config/'reroute'/'accounts'
    env=dict(os.environ,TERM='xterm-256color',CI='false',XDG_CONFIG_HOME=str(config),REROUTE_STATE_DIR=str(base/'state'),HOME=str(base/'home'))
    for key in list(env):
        if key.startswith(('DAYTONA_','MODAL_','E2B_')):env.pop(key)
    if case=='environment':env['DAYTONA_API_KEY']='environment-private-token'
    master,slave=pty.openpty()
    fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',52,160,0,0))
    child=subprocess.Popen([node,entry,'setup']+([] if case=='global' else ['--project']),cwd=project,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
    os.close(slave);log='';transcript=''
    def prompt(phrase,answer):
        global log,transcript
        until=time.monotonic()+6
        while time.monotonic()<until:
            if select.select([master],[],[],.1)[0]:
                try:part=os.read(master,65536)
                except OSError:break
                log+=part.decode(errors='replace')
                plain=re.sub(r'\x1b\[[0-9;?]*[A-Za-z]','',log)
                if phrase in plain:
                    transcript+=plain;os.write(master,answer);log='';return
        raise AssertionError('Missing '+phrase+'; output='+repr(log))
    def finish(code):
        global transcript
        until=time.monotonic()+6
        while child.poll() is None and time.monotonic()<until:
            if select.select([master],[],[],.1)[0]:
                try:transcript+=os.read(master,65536).decode(errors='replace')
                except OSError:break
        assert child.wait(timeout=2)==code,repr(transcript[-1500:])
    def credentials(provider):
        prompt(provider+' — credentials',b'\r')
        keys=['DAYTONA_API_KEY'] if provider=='daytona' else ['MODAL_TOKEN_ID','MODAL_TOKEN_SECRET']
        for key in keys:prompt(provider+' — '+key,('masked-fixture-'+key+'\r').encode())
    try:
        if case=='cancel-start':
            prompt('Choose providers',b'\x03');finish(125)
            assert not config_file.exists() and not secrets.exists()
        elif case=='advanced':
            # Unselect Daytona, select only Advanced, then use the preserved SSH wizard.
            prompt('Choose providers',b' \x1b[B\x1b[B\x1b[B \r')
            prompt('Profile name',b'\x03');finish(125)
            assert not config_file.exists() and not secrets.exists()
        elif case=='mixed-advanced':
            prompt('Choose providers',b'\x1b[B\x1b[B\x1b[B \r')
            prompt('Profile name',b'\x03');finish(125)
            assert not config_file.exists() and not secrets.exists()
        elif case=='ssh':
            prompt('Choose providers',b' \x1b[B\x1b[B \r')
            prompt('SSH alias or user@host',b'build-host\r')
            prompt('Save these project profiles',b'\r');finish(0)
            saved=json.loads(config_file.read_text())
            assert saved['profiles']=={'ssh':{'provider':'ssh','id':'build-host'}} and saved['active']=='ssh'
            assert not secrets.exists()
            for unwanted in ('DAYTONA_API_KEY','Compute & budget','Automatic task categories','SSH identity file','SSH port'):
                assert unwanted not in transcript,unwanted
        elif case=='keep':
            prompt('Choose providers',b'\r')
            prompt('daytona — use a saved profile',b'\r')
            prompt('Default provider for this project',b'\x1b[B\r')
            prompt('Save these project profiles',b'\r');finish(0)
            saved=json.loads(config_file.read_text())
            assert saved['profiles']==original['profiles'] and saved['active']=='old-cloud'
            for key in ['tasks','remote','local','timeoutSeconds']:assert saved[key]==original[key]
            assert not secrets.exists() and 'Authorize future paid' not in transcript
        elif case=='add-account':
            prompt('Choose providers',b'\r')
            prompt('daytona — use a saved profile',b'\x1b[B\r')
            prompt('new profile/account name',b'daytona-work\r')
            credentials('daytona')
            prompt('Compute & budget',b'\r')
            prompt('Default provider for this project',b'\r')
            prompt('Authorize future paid',b'\r')
            prompt('Save these project profiles',b'\r');finish(0)
            saved=json.loads(config_file.read_text())
            for name,value in original['profiles'].items():assert saved['profiles'][name]==value
            assert saved['profiles']['daytona-work']['credential']=='daytona-work'
            assert (secrets/'daytona-work.json').exists()
        elif case in ('both','global','authorize','cancel-final','cancel-existing','cancel-second-key','unsafe'):
            prompt('Choose providers',b'\x1b[B \r')
            if case=='cancel-existing':
                prompt('daytona — use a saved profile',b'\x1b[B\r')
                prompt('new profile/account name',b'daytona-new\r')
            credentials('daytona')
            prompt('modal — credentials',b'\r')
            prompt('modal — MODAL_TOKEN_ID',b'masked-fixture-MODAL_TOKEN_ID\r')
            if case=='cancel-second-key':
                prompt('modal — MODAL_TOKEN_SECRET',b'\x03');finish(125)
                assert not config_file.exists() and not secrets.exists()
            else:
                prompt('modal — MODAL_TOKEN_SECRET',b'masked-fixture-MODAL_TOKEN_SECRET\r')
                prompt('Compute & budget',b'\r')
                prompt('Default provider for this project',b'\r' if case=='cancel-existing' else b'\x1b[B\r')
                prompt('Authorize future paid',b'y\r' if case=='authorize' else b'\r')
                prompt('Save these user defaults' if case=='global' else 'Save these project profiles',b'\x03' if case in ('cancel-final','cancel-existing') else b'\r')
                finish(125 if case in ('cancel-final','cancel-existing','unsafe') else 0)
                if case=='cancel-existing':
                    assert config_file.read_text()==json.dumps(original)
                    assert not secrets.exists()
                elif case in ('cancel-final','unsafe'):
                    assert not config_file.exists() and not secrets.exists()
                else:
                    saved=json.loads(config_file.read_text());assert saved['active']=='modal'
                    assert set(saved['profiles'])=={'daytona','modal'}
                    for provider,keys in [('daytona',['DAYTONA_API_KEY']),('modal',['MODAL_TOKEN_ID','MODAL_TOKEN_SECRET'])]:
                        profile=saved['profiles'][provider]
                        assert profile['id']=='auto' and profile['credential']==provider
                        assert profile['compute']=={'cpu':1,'memoryGiB':2}
                        assert profile['image']=='reroute:node-rust-v1'
                        assert profile['managed']['monthlyUsd']==3 and profile['managed']['maxTaskUsd']==.5
                        assert profile['managed']['authorized']==(case=='authorize')
                        path=secrets/(provider+'.json')
                        assert path.stat().st_mode&0o777==0o600
                        assert json.loads(path.read_text())=={key:'masked-fixture-'+key for key in keys}
                    assert secrets.stat().st_mode&0o777==0o700
                    assert 'PER credential account' in transcript and 'Credit/balance: unknown' in transcript
                    assert 'physical CPU cores' in transcript and 'vCPU' in transcript
                    for unwanted in ('Profile name','Compute ownership','Toolchain image (','Monthly local estimate budget (','Automatic task categories','Existing sandbox ID','Isolated remote storage root'):
                        assert unwanted not in transcript,unwanted
        elif case in ('later','environment','named'):
            prompt('Choose providers',b'\r')
            if case=='later':prompt('daytona — credentials',b'\x1b[B\r')
            if case=='environment':prompt('daytona — credentials',b'\x1b[B\r')
            prompt('Compute & budget',b'\r')
            if case!='later':prompt('Authorize future paid',b'\r')
            prompt('Save these project profiles',b'\r');finish(0)
            saved=json.loads(config_file.read_text())['profiles']['daytona']
            assert saved['managed']['authorized']==False
            if case=='environment':assert 'credential' not in saved and not secrets.exists()
            elif case=='later':assert saved['credential']=='daytona' and not secrets.exists() and 'Authorize future paid' not in transcript
            else:assert saved['credential']=='daytona' and 'DAYTONA_API_KEY' not in transcript
        elif case=='custom':
            prompt('Choose providers',b'\r');credentials('daytona')
            prompt('Compute & budget',b'\x1b[B\r')
            prompt('Compute specification',b'\r')
            prompt('CPU (vCPU)',b'\x152\r');prompt('Memory (GiB)',b'\x156\r')
            prompt('Toolchain image (',b'\r')
            prompt('Monthly local estimate budget (',b'\x154\r')
            for field in ('Maximum per-task estimate','Review CPU rate','Review memory rate','Monthly retained storage allowance','Idle reclaim delay','Maximum allowed CPU','Maximum allowed memory'):prompt(field,b'\r')
            prompt('Authorize future paid',b'\r');prompt('Save these project profiles',b'\r');finish(0)
            saved=json.loads(config_file.read_text())['profiles']['daytona']
            assert saved['compute']=={'cpu':2,'memoryGiB':6} and saved['managed']['monthlyUsd']==4
        else:raise AssertionError('unknown case')
        for private in ('masked-fixture-DAYTONA_API_KEY','masked-fixture-MODAL_TOKEN_ID','masked-fixture-MODAL_TOKEN_SECRET','already-saved-private','environment-private-token'):
            assert private not in transcript,'unmasked credential in terminal output'
            if config_file.exists():assert private not in config_file.read_text(),'credential in project config'
        if case=='global':
            assert project_file.read_bytes()==original_bytes,'global setup changed the existing project config'
            assert config_file.stat().st_mode&0o777==0o600
        assert not (base/'state').exists(),'setup must not allocate cloud ownership, resources or project consent'
    finally:
        if child.poll() is None:child.kill();child.wait()
        os.close(master)
print('quick setup '+case+' passed')
`;

for(const scenario of ['both','global','authorize','cancel-start','cancel-second-key','cancel-final','cancel-existing','ssh','keep','add-account','later','environment','named','custom','unsafe','advanced','mixed-advanced']){
 test('real quick setup PTY: '+scenario,{timeout:20000},()=>{
  const result=spawnSync('python3',['-c',script,process.execPath,resolve('bin/reroute.mjs'),scenario],{encoding:'utf8',timeout:18000});
  assert.equal(result.status,0,result.stderr||result.stdout||String(result.error));
 });
}
