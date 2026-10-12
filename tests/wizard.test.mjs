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
        child=subprocess.Popen([node,entry,'setup','--no-pi'],cwd=base,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
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
node, entry = sys.argv[1:]
with tempfile.TemporaryDirectory(prefix='reroute-daytona-') as base:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH",42,130,0,0))
    env=dict(os.environ, TERM='xterm-256color', CI='false', XDG_CONFIG_HOME=base+'/config')
    env.pop('DAYTONA_API_KEY',None)
    child=subprocess.Popen([node,entry,'setup','--no-pi'],cwd=base,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
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
        prompt('How would you like to authenticate?',b'\x1b[B\r')
        prompt('DAYTONA_API_KEY',b'test-secret-only-in-private-config\r')
        prompt('List existing resources now?',b'\r')
        prompt('Existing sandbox ID',b'existing-daytona-sandbox\r')
        prompt('Isolated remote storage root',b'\r')
        prompt('Automatic task categories',b'\r')
        prompt('Save this project configuration?',b'\r')
        prompt('After saving, check connection',b'\r')
        assert child.wait(timeout=6)==0,repr(log)
        config=json.loads(pathlib.Path(base,'.reroute.json').read_text())
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
 const r=spawnSync('python3',['-c',script,process.execPath,resolve('bin/reroute.mjs')],{encoding:'utf8',timeout:25000});
 assert.equal(r.status,0,r.stderr||r.stdout||String(r.error));
});
