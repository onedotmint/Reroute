import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// No model prompt, provider call, real user config or paid acceptance: drive actual Pi dialogs only.
test('real Pi PTY opens the panel and completes masked onboarding with default-No spending', { timeout: 45000 }, () => {
  const script = String.raw`
import json, os, pathlib, pty, re, select, subprocess, sys, tempfile, time, fcntl, struct, termios
node, cli, adapter = sys.argv[1:]
with tempfile.TemporaryDirectory(prefix='reroute-pi-panel-') as temp:
    base=pathlib.Path(temp)
    project=base/'project'; project.mkdir()
    guard=base/'deny-network.mjs'
    guard.write_text('import { appendFileSync } from "node:fs"; globalThis.fetch = async () => { appendFileSync('+json.dumps(str(base/'NETWORK_ATTEMPT'))+', "fetch\\n"); throw new Error("Network prohibited in Pi panel PTY"); };')
    config=base/'config'/'reroute'/'config.json'
    def run(configured,onboard=False):
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
                screen=until('PROJECT NOT AUTHORIZED')
                assert 'Config: global' not in screen,screen
                assert '· global' in screen,screen
                assert 'connection: not checked this session' in screen,screen
                os.write(master,b'\r')
                until('No cloud calls made to view this overview.')
                until('PROJECT NOT AUTHORIZED')
                # Escape closes the next native select without submitting a model prompt.
                os.write(master,b'\x1b')
                time.sleep(.2)
            else:
                # One render: waiting twice would stall on the already-buffered static menu.
                shown=until('Advanced terminal setup')
                assert 'No configuration yet' in shown,shown
                assert 'Configure in Pi' in shown,shown
                if onboard:
                    os.write(master,b'\r')
                    until('Choose a provider')
                    os.write(master,b'\x1b[B\r') # Daytona, not SSH
                    until('Use recommended cloud settings')
                    os.write(master,b'\r')
                    spending=until('Yes — authorize paid creation/start')
                    assert '→ No — save without spending authorization' in spending,spending
                    os.write(master,b'\r') # The default must decline spending.
                    until('input is not echoed')
                    os.write(master,b'\x1b[200~fixture-pty-hidden-key\x1b[201~')
                    masked=until('********')
                    assert 'fixture-pty-hidden-key' not in masked,masked
                    os.write(master,b'\r')
                    until('PROJECT NOT AUTHORIZED')
                os.write(master,b'\x1b')
            time.sleep(.2)
            os.write(master,b'/quit\r')
            assert child.wait(timeout=5)==0
            return transcript
        finally:
            if child.poll() is None: child.kill();child.wait()
            os.close(master)
    run(False)
    assert not config.exists()
    transcript=run(False,onboard=True)
    assert 'fixture-pty-hidden-key' not in transcript,'The terminal transcript must never contain the key'
    saved=json.loads(config.read_text())
    assert saved['profiles']['daytona']['managed']['authorized'] is False,saved
    keyfile=config.parent/'accounts'/'daytona.json'
    assert json.loads(keyfile.read_text())=={'DAYTONA_API_KEY':'fixture-pty-hidden-key'}
    assert keyfile.stat().st_mode & 0o777 == 0o600
    config.parent.mkdir(parents=True,exist_ok=True)
    value={'version':3,'active':'offline','mode':'auto','profiles':{'offline':{'provider':'ssh','id':'must-not-contact.invalid'}},
        'tasks':['build','test','check','benchmark'],'remote':[],'local':[],'timeoutSeconds':30}
    config.write_text(json.dumps(value))
    run(True)
    assert json.loads(config.read_text())==value
    assert not (project/'.reroute.json').exists()
    assert not (base/'NETWORK_ATTEMPT').exists(),'No network/model request is permitted'
print('Pi native PTY: overview, hidden pasted key, default-No spending; zero network/model calls')
`;
  const result = spawnSync('python3', ['-c', script, process.execPath,
    process.env.REROUTE_PI_CLI_PATH ?? resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), resolve('adapters/pi.ts')],
    { encoding: 'utf8', timeout: 40000 });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
});
