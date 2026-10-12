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
            prompt('Existing compute environment',b'\r')
            prompt('SSH alias or user@host',b'\r' if pathlib.Path(base,'.reroute.json').exists() else b'offline-fixture\r')
            prompt('SSH identity file',b'\r')
            prompt('SSH port',b'\r')
            prompt('Isolated remote storage root',b'\r')
            prompt('Automatic task categories',b'\r' if pathlib.Path(base,'.reroute.json').exists() else b' \r')
            prompt('Save this project configuration?',b'\r')
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
