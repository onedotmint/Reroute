import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// No model prompt, provider call, real user config or paid acceptance: drive actual Pi dialogs only.
test('real Pi PTY opens /reroute, displays global setup and local overview, then closes', { timeout: 45000 }, () => {
  const script = String.raw`
import json, os, pathlib, pty, re, select, subprocess, sys, tempfile, time, fcntl, struct, termios
node, cli, adapter = sys.argv[1:]
with tempfile.TemporaryDirectory(prefix='reroute-pi-panel-') as temp:
    base=pathlib.Path(temp)
    project=base/'project'; project.mkdir()
    guard=base/'deny-network.mjs'
    guard.write_text('import { appendFileSync } from "node:fs"; globalThis.fetch = async () => { appendFileSync('+json.dumps(str(base/'NETWORK_ATTEMPT'))+', "fetch\\n"); throw new Error("Network prohibited in Pi panel PTY"); };')
    config=base/'config'/'reroute'/'config.json'
    def run(configured):
        master,slave=pty.openpty()
        fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',52,140,0,0))
        env={key:value for key,value in os.environ.items() if not any(word in key for word in ['API_KEY','TOKEN','SECRET'])}
        env.update(TERM='xterm-256color',CI='false',HOME=str(base/'home'),USERPROFILE=str(base/'home'),
            XDG_CONFIG_HOME=str(base/'config'),XDG_CACHE_HOME=str(base/'cache'),XDG_DATA_HOME=str(base/'data'),XDG_STATE_HOME=str(base/'state'),
            PI_CODING_AGENT_DIR=str(base/'agent'),REROUTE_STATE_DIR=str(base/'reroute-state'),PI_OFFLINE='1',NODE_OPTIONS='--import='+str(guard))
        child=subprocess.Popen([node,cli,'--offline','--no-session','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-mcp','-e',adapter],
            cwd=project,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
        os.close(slave);log='';transcript=''
        def until(phrase,timeout=12):
            nonlocal log,transcript
            end=time.monotonic()+timeout
            while time.monotonic()<end:
                if select.select([master],[],[],.1)[0]:
                    try: part=os.read(master,65536)
                    except OSError: break
                    log+=part.decode(errors='replace')
                    plain=re.sub(r'\x1b\][^\x07]*(?:\x07|\x1b\\)','',log)
                    plain=re.sub(r'\x1b\[[0-9;?]*[A-Za-z]','',plain)
                    if phrase in plain:
                        transcript+=plain;log=plain.split(phrase,1)[1];return plain
                if child.poll() is not None: break
            raise AssertionError('Missing '+phrase+'; output='+repr(log)+'; exited='+str(child.poll()))
        try:
            until('[Extensions]')
            os.write(master,b'/reroute\r')
            if configured:
                screen=until('Project remote authorization: NOT authorized')
                assert 'Config: global' in screen,screen
                assert 'saved is not authenticated' in screen,screen
                os.write(master,b'\r')
                until('No cloud calls made to view this overview.')
                until('Project remote authorization: NOT authorized')
                # Escape closes the next native select without submitting a model prompt.
                os.write(master,b'\x1b')
                time.sleep(.2)
            else:
                until('Global setup recommended')
                os.write(master,b'\r')
                shown=until('setup defaults to global scope.')
                assert 'setup' in shown and '--cwd' in shown,shown
                assert '--project' not in shown,shown
            time.sleep(.2)
            os.write(master,b'/quit\r')
            assert child.wait(timeout=5)==0
            return transcript
        finally:
            if child.poll() is None: child.kill();child.wait()
            os.close(master)
    run(False)
    assert not config.exists()
    config.parent.mkdir(parents=True,exist_ok=True)
    value={'version':3,'active':'offline','mode':'auto','profiles':{'offline':{'provider':'ssh','id':'must-not-contact.invalid'}},
        'tasks':['build','test','check','benchmark'],'remote':[],'local':[],'timeoutSeconds':30}
    config.write_text(json.dumps(value))
    run(True)
    assert json.loads(config.read_text())==value
    assert not (project/'.reroute.json').exists()
    assert not (base/'NETWORK_ATTEMPT').exists(),'No network/model request is permitted'
print('Pi native PTY: global setup, overview, close; zero network/model calls')
`;
  const result = spawnSync('python3', ['-c', script, process.execPath,
    process.env.REROUTE_PI_CLI_PATH ?? resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), resolve('adapters/pi.ts')],
    { encoding: 'utf8', timeout: 40000 });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
});
