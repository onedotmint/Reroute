#!/usr/bin/env bash
# A real isolated localhost OpenSSH server, only for disposable GitHub-hosted CI.
set -euo pipefail
if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_OS:-}" != Linux ]]; then
  echo 'This server fixture is restricted to disposable Linux GitHub Actions runners.' >&2
  exit 1
fi
base="${RUNNER_TEMP:?}/reroute-sshd"
mkdir -p "$base" "$HOME/.ssh"
chmod 700 "$base" "$HOME/.ssh"
ssh-keygen -q -t ed25519 -N '' -f "$base/client"
ssh-keygen -q -t ed25519 -N '' -f "$base/host"
# The runner itself is the SSH user; no accounts, cloud instances or existing data are touched.
cp "$base/client.pub" "$base/authorized_keys"
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
cat > "$base/sshd_config" <<CFG
Port $port
ListenAddress 127.0.0.1
HostKey $base/host
PidFile $base/pid
AuthorizedKeysFile $base/authorized_keys
StrictModes no
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM yes
AllowUsers $(id -un)
PermitRootLogin no
LogLevel VERBOSE
Subsystem sftp internal-sftp
CFG
sudo mkdir -p /run/sshd
# PAM performs account/session checks for the runner's password-locked account.
# Password and keyboard-interactive authentication remain disabled.
trap 'code=$?; if [ "$code" -ne 0 ] && [ -f "$base/server.log" ]; then sudo tail -n 60 "$base/server.log" >&2; fi; exit "$code"' ERR
sudo /usr/sbin/sshd -f "$base/sshd_config" -E "$base/server.log"
# Pin the key generated above, rather than accepting an unverified scanned key.
printf '[127.0.0.1]:%s %s\n' "$port" "$(cat "$base/host.pub")" >> "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"
{
  echo "REROUTE_TEST_SSH_ID=$(id -un)@127.0.0.1"
  echo "REROUTE_TEST_SSH_PORT=$port"
  echo "REROUTE_TEST_SSH_KEY=$base/client"
  echo "REROUTE_TEST_SSH_SERVER=$base"
} >> "$GITHUB_ENV"
ssh -T -p "$port" -i "$base/client" -o BatchMode=yes -o StrictHostKeyChecking=yes "$(id -un)@127.0.0.1" 'test -n "$SSH_CONNECTION" && command -v python3 && command -v rsync'
