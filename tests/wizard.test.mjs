import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
test('real Clack PTY: Enter defaults, Space multiselect, prefilled config and Ctrl-C cancellation', {timeout:30000},()=>{
 const script=String.raw`
import json, os, pathlib, pty, re, select, subprocess, sys, tempfile, time, fcntl, struct, termios
node, entry = sys.argv[1:]
with tempfile.TemporaryDirectory(prefix='reroute-wizard-') as base:
    def wizard(cancel=False):
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH",40,120,0,0))
        env=dict(os.environ, TERM='xterm-256color', CI='false')
        child=subprocess.Popen([node,entry,'setup','--advanced','--no-pi'],cwd=base,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
        os.close(slave); log=''
        def prompt(text, response):
            nonlocal log
            deadline=time.monotonic()+5
            while time.monotonic()<deadline:
                if select.select([master],[],[],.1)[0]:
                    try: part=os.read(master,65536)
                    except OSError: break
                    log+=part.decode(errors='replace')
                    plain=re.sub(r'\x1b\[[0-9;?]*[A-Za-z]','',log)
                    if text in plain:
                        os.write(master,response); log=''; return
            raise AssertionError('Missing prompt '+text+'; output='+repr(log))
        try:
            prompt('Profile name', b'\x03' if cancel else b'\r')
            if cancel:
                assert child.wait(timeout=5)!=0
                return
            prompt('Choose compute provider',b'\r')
            prompt('List existing resources now?',b'\r')
            prompt('SSH alias or user@host',b'\r' if pathlib.Path(base,'.reroute.json').exists() else b'offline-fixture\r')
            prompt('SSH identity file',b'\r')
            prompt('SSH port',b'\r')
            prompt('Isolated remote storage root',b'\r')
            prompt('Automatic task categories',b'\r' if pathlib.Path(base,'.reroute.json').exists() else b' \r')
            prompt('Save this project configuration?',b'\r')
            prompt('After saving, check connection',b'\r')
            assert child.wait(timeout=5)==0,log
        finally:
            if child.poll() is None: child.kill();child.wait()
            os.close(master)
    wizard(cancel=True)
    assert not pathlib.Path(base,'.reroute.json').exists()
    wizard(); config=json.loads(pathlib.Path(base,'.reroute.json').read_text())
    assert config['profiles']['default']['id']=='offline-fixture'
    assert config['tasks']==['test','check','benchmark'],config
    wizard(); assert json.loads(pathlib.Path(base,'.reroute.json').read_text())==config
print('Clack native PTY checks passed')
`;
 const r=spawnSync('python3',['-c',script,process.execPath,resolve('bin/reroute.mjs')],{encoding:'utf8',timeout:25000});
 assert.equal(r.status,0,r.stderr||r.stdout||String(r.error));
});


test('real Clack PTY: choose Daytona, enter masked API key, save private credentials without project leak', {timeout:30000},()=>{
 const script=String.raw`
import json, os, pathlib, pty, re, select, subprocess, sys, tempfile, time, fcntl, struct, termios
node, entry, mode = sys.argv[1:]
with tempfile.TemporaryDirectory(prefix='reroute-daytona-') as base:
    project=pathlib.Path(base,'project'); project.mkdir()
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH",42,130,0,0))
    env=dict(os.environ, TERM='xterm-256color', CI='false', XDG_CONFIG_HOME=str(project/'config') if mode=='unsafe' else base+'/config')
    env.pop('DAYTONA_API_KEY',None)
    child=subprocess.Popen([node,entry,'setup','--advanced','--no-pi'],cwd=project,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
    os.close(slave); log=''; transcript=''
    def prompt(phrase, answer):
        global log, transcript
        until=time.monotonic()+6
        while time.monotonic()<until:
            if select.select([master],[],[],.1)[0]:
                try: part=os.read(master,65536)
                except OSError: break
                log+=part.decode(errors='replace')
                plain=re.sub(r'\x1b\[[0-9;?]*[A-Za-z]','',log)
                if phrase in plain:
                    transcript+=plain
                    os.write(master,answer)
                    log=''
                    return
        raise AssertionError('Prompt not found '+phrase+' output='+repr(log))
    try:
        prompt('Profile name',b'\r')
        prompt('Choose compute provider',b'\x1b[B\r')
        prompt('Compute ownership',b'\r')
        prompt('Credential account name',b'\r')
        prompt('How would you like to authenticate?',b'\x1b[B\r')
        prompt('DAYTONA_API_KEY',b'test-secret-only-in-private-config\r')
        prompt('List existing resources now?',b'\r')
        prompt('Existing sandbox ID',b'existing-daytona-sandbox\r')
        prompt('Isolated remote storage root',b'\r')
        prompt('Automatic task categories',b'\r')
        prompt('Save this project configuration?',b'\r')
        prompt('After saving, check connection',b'\r')
        if mode=='unsafe':
            assert child.wait(timeout=6)==125,repr(log)
            assert not (project/'.reroute.json').exists()
            assert not (project/'config'/'reroute'/'credentials.json').exists()
            assert 'test-secret-only-in-private-config' not in transcript
            sys.exit(0)
        assert child.wait(timeout=6)==0,repr(log)
        config=json.loads((project/'.reroute.json').read_text())
        assert config['profiles']['default']['provider']=='daytona',config
        assert config['profiles']['default']['id']=='existing-daytona-sandbox'
        assert 'test-secret-only-in-private-config' not in json.dumps(config)
        secret=pathlib.Path(base,'config','reroute','credentials.json')
        assert (secret.stat().st_mode & 0o777)==0o600
        values=json.loads(secret.read_text())
        assert values['DAYTONA_API_KEY']=='test-secret-only-in-private-config'
        assert 'test-secret-only-in-private-config' not in transcript
    finally:
        if child.poll() is None: child.kill();child.wait()
        os.close(master)
print('Daytona Clack masked-secret PTY checks passed')
`;
 for(const mode of ['safe','unsafe']){
  const r=spawnSync('python3',['-c',script,process.execPath,resolve('bin/reroute.mjs'),mode],{encoding:'utf8',timeout:25000});
  assert.equal(r.status,0,r.stderr||r.stdout||String(r.error));
 }
});

test('real Clack PTY: managed Daytona preset, Modal custom, named masked credentials and separate authorization', {timeout:45000},()=>{
 const script=String.raw`
import json, os, pathlib, pty, re, select, subprocess, sys, tempfile, time, fcntl, struct, termios
node, entry = sys.argv[1:]
with tempfile.TemporaryDirectory(prefix='reroute-managed-wizard-') as base:
    for provider in ['daytona','modal']:
        folder=pathlib.Path(base,provider); folder.mkdir()
        project=folder/'project'; project.mkdir()
        master, slave=pty.openpty()
        fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',50,160,0,0))
        env=dict(os.environ,TERM='xterm-256color',CI='false',XDG_CONFIG_HOME=str(folder/'config'),
            DAYTONA_API_KEY='wrong-default-account',MODAL_TOKEN_ID='wrong-default-id',MODAL_TOKEN_SECRET='wrong-default-secret')
        child=subprocess.Popen([node,entry,'setup','--advanced','--no-pi'],cwd=project,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
        os.close(slave); log=''; transcript=''
        def prompt(phrase,answer):
            global log,transcript
            until=time.monotonic()+6
            while time.monotonic()<until:
                if select.select([master],[],[],.1)[0]:
                    try: part=os.read(master,65536)
                    except OSError: break
                    log+=part.decode(errors='replace')
                    plain=re.sub(r'\x1b\[[0-9;?]*[A-Za-z]','',log)
                    if phrase in plain:
                        transcript+=plain; os.write(master,answer); log=''; return
            raise AssertionError('Missing '+phrase+'; output='+repr(log))
        try:
            prompt('Profile name',b'\r')
            prompt('Choose compute provider',b'\x1b[B\r' if provider=='daytona' else b'\x1b[B\x1b[B\x1b[B\r')
            prompt('Compute ownership',b'\x1b[B\r')
            prompt('Credential account name',b'build-account\r')
            prompt('How would you like to authenticate?',b'\x1b[B\r')
            keys=['DAYTONA_API_KEY'] if provider=='daytona' else ['MODAL_TOKEN_ID','MODAL_TOKEN_SECRET']
            for key in keys: prompt(key,('private-masked-'+key+'\r').encode())
            prompt('Compute specification',b'\r' if provider=='daytona' else b'\x1b[B\x1b[B\x1b[B\r')
            if provider=='modal':
                prompt('CPU (physical cores',b'\x15'+b'0.5\r')
                prompt('Memory (GiB)',b'\x15'+b'1.5\r')
            prompt('Toolchain image',b'\x15my-reviewed-toolchain:v1\r')
            prompt('Monthly local estimate budget',b'\r')
            prompt('Maximum per-task estimate',b'\r')
            prompt('Review CPU rate',b'\r')
            prompt('Review memory rate',b'\r')
            prompt('Monthly retained storage allowance',b'\r')
            prompt('Idle reclaim delay',b'\r')
            prompt('Maximum allowed CPU',b'\r')
            prompt('Maximum allowed memory',b'\r')
            prompt('Isolated remote storage root',b'\r')
            prompt('Automatic task categories',b'\r')
            prompt('Authorize automatic paid creation/start',b'\r' if provider=='daytona' else b'y\r')
            prompt('Save this project configuration?',b'\r')
            assert child.wait(timeout=6)==0,repr(log)
            config=json.loads((project/'.reroute.json').read_text()); profile=config['profiles']['default']
            assert profile['provider']==provider and profile['id']=='auto',profile
            assert profile['credential']=='build-account'
            assert profile['image']=='my-reviewed-toolchain:v1'
            assert profile['managed']['authorized']==(provider=='modal'),profile
            assert profile['compute']==({'cpu':1,'memoryGiB':2} if provider=='daytona' else {'cpu':.5,'memoryGiB':1.5}),profile
            assert profile['managed']['cpuHourUsd']==(.0504 if provider=='daytona' else .141912),profile
            assert profile['managed']['memoryGiBHourUsd']==(.0162 if provider=='daytona' else .024012),profile
            secret=folder/'config'/'reroute'/'accounts'/'build-account.json'
            assert (secret.stat().st_mode & 0o777)==0o600
            assert json.loads(secret.read_text())=={key:'private-masked-'+key for key in keys}
            assert not (folder/'config'/'reroute'/'credentials.json').exists()
            for key in keys:
                assert 'private-masked-'+key not in transcript
                assert 'private-masked-'+key not in json.dumps(config)
            assert 'Credit/balance: unknown' in transcript
            assert 'not hard bill caps' in transcript
            assert 'storage may still cost money' in transcript
            assert 'List existing resources now?' not in transcript
            assert 'Existing sandbox ID' not in transcript
            assert 'After saving, check connection' not in transcript
            if provider=='modal':
                assert 'physical cores (not vCPU)' in transcript
                assert 'live acceptance is not established' in transcript
        finally:
            if child.poll() is None: child.kill();child.wait()
            os.close(master)
print('Managed Clack PTY checks passed')
`;
 const r=spawnSync('python3',['-c',script,process.execPath,resolve('bin/reroute.mjs')],{encoding:'utf8',timeout:40000});
 assert.equal(r.status,0,r.stderr||r.stdout||String(r.error));
});
