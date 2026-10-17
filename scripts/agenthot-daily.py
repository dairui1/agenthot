#!/usr/bin/env python3
"""Run the production daily publisher through a temporary, local Codex adapter."""

import argparse
import contextlib
from datetime import datetime
import fcntl
import json
import os
from pathlib import Path
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
HOST = "hostinger-dokploy"
REMOTE_PORT = 14312
MAX_SECONDS = 90 * 60
HEARTBEAT_SECONDS = 2
LEASE_SECONDS = 10
PROBE_SCRIPT = """let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const config = JSON.parse(input);
  if (config.baseUrl !== 'http://127.0.0.1:14312/v1' || typeof config.token !== 'string' || !config.token) throw new Error();
  const response = await fetch('http://127.0.0.1:14312/', {
    headers: { Authorization: `Bearer ${config.token}` },
    redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (response.status !== 404 || JSON.stringify(await response.json()) !== JSON.stringify({error: {message: 'Not found'}})) throw new Error();
  console.log(JSON.stringify({ok: true, stage: 'transport', probe: {remoteAdapter: true}}));
} catch {
  console.error(JSON.stringify({ok: false, stage: 'transport', error: 'Remote adapter authentication probe failed'}));
  process.exitCode = 1;
}
"""
SSH_OPTIONS = [
    "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3", "-o", "ForwardAgent=no",
    "-o", "ControlPath=none",
]


class TransportError(Exception):
    pass


def ssh_command(command, forwards=None):
    return ["ssh", *SSH_OPTIONS, *(forwards or []), HOST, command]


def node_binary():
    candidates = [shutil.which("node"), "/opt/homebrew/bin/node", "/usr/local/bin/node"]
    for candidate in candidates:
        if candidate and os.access(candidate, os.X_OK):
            return str(Path(candidate).resolve())
    raise TransportError("Node.js 24 is required on the operator Mac")


def local_release():
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True,
        check=True, timeout=10,
    )
    release = result.stdout.strip()
    if len(release) != 40 or any(char not in "0123456789abcdef" for char in release):
        raise TransportError("Cannot identify the local release")
    return release


@contextlib.contextmanager
def operation_lock():
    directory = ROOT / ".data"
    directory.mkdir(mode=0o700, exist_ok=True)
    with (directory / "daily-publish.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise TransportError("Another daily publisher is already running") from error
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def remaining(deadline):
    seconds = deadline - time.monotonic()
    if seconds <= 0:
        raise TransportError("Daily publisher reached its run deadline")
    return seconds


def stop_process(process):
    if process is None or process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)


def adapter_environment(token, port):
    allowed = {
        "HOME", "PATH", "TMPDIR", "CODEX_HOME", "CODEX_BIN", "LANG", "LC_ALL",
        "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
    }
    env = {key: value for key, value in os.environ.items() if key in allowed}
    env.update(CODEX_CLI_TOKEN=token, CODEX_CLI_PORT=str(port))
    return env


def unused_local_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def check_adapter(token, port, timeout):
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/", headers={"Authorization": f"Bearer {token}"},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout):
            raise TransportError("Unexpected service on the local adapter port")
    except urllib.error.HTTPError as error:
        with error:
            try:
                if error.code == 404 and json.load(error) == {"error": {"message": "Not found"}}:
                    return
            except ValueError:
                pass
        raise TransportError("The local adapter did not accept its temporary token")


def wait_for_adapter(process, token, port, deadline):
    deadline = min(deadline, time.monotonic() + 20)
    while remaining(deadline):
        if process.poll() is not None:
            raise TransportError("The local Codex adapter exited during startup")
        try:
            check_adapter(token, port, min(1, remaining(deadline)))
            return
        except (urllib.error.URLError, TimeoutError):
            time.sleep(0.1)


def remote_command(mode, release, seconds):
    # Docker writes the cidfile only after this invocation creates its container.
    # Never remove an existing container by its shared daily-publish name.
    tunnel_check = f"""test "$(timeout --signal=KILL 10s ss -H -ltn '( sport = :{REMOTE_PORT} )' | awk '{{print $4}}')" = '127.0.0.1:{REMOTE_PORT}' || {{ echo 'Reverse tunnel is not loopback-only' >&2; exit 1; }}
""" if mode in {"collect", "probe"} else ""
    database_check = "" if mode == "probe" else """db_ip=$(timeout --signal=KILL 10s docker inspect --format '{{with index .NetworkSettings.Networks "agenthot_default"}}{{.IPAddress}}{{end}}' agenthot-db-1)
test -n "$db_ip" || { echo 'Production database network address is unavailable' >&2; exit 1; }
"""
    environment = "" if mode == "probe" else '--env-file /opt/agenthot/.env -v agenthot_data:/data -e AGENTHOT_DATABASE_HOST="$db_ip"'
    entrypoint = "node --input-type=module -e " + shlex.quote(PROBE_SCRIPT) if mode == "probe" else f"node modules/daily-publish/remote.ts --{mode}"
    return f"""set -eu
deadline={int(time.time() + seconds)}
exec 3<&0
IFS= read -r -t {LEASE_SECONDS} payload <&3 || {{ echo 'Missing transport configuration' >&2; exit 1; }}
{tunnel_check}\
cd /opt/agenthot
test "$(timeout --signal=KILL 10s git rev-parse HEAD)" = {shlex.quote(release)} || {{ echo 'Production checkout does not match local HEAD' >&2; exit 1; }}
api_image=$(timeout --signal=KILL 10s docker inspect --format '{{{{.Image}}}}' agenthot-api-1)
publisher_image=$(timeout --signal=KILL 10s docker image inspect --format '{{{{.Id}}}}' agenthot-app)
test -n "$api_image" && test -n "$publisher_image" && test "$api_image" = "$publisher_image" || {{ echo 'Publisher image does not match the running API' >&2; exit 1; }}
api_release=$(timeout --signal=KILL 10s docker inspect --format '{{{{range .Config.Env}}}}{{{{println .}}}}{{{{end}}}}' agenthot-api-1 | sed -n 's/^AIHOT_RELEASE=//p')
test "$api_release" = {shlex.quote(release)} || {{ echo 'Running API release does not match local HEAD' >&2; exit 1; }}
{database_check}\
work=$(mktemp -d /tmp/agenthot-daily.XXXXXXXX)
cidfile="$work/container-id"
runner=
cleanup() {{
  status=$?
  trap - EXIT
  trap '' HUP INT TERM
  if test -n "$runner"; then
    kill "$runner" >/dev/null 2>&1 || true
    wait "$runner" >/dev/null 2>&1 || true
  fi
  if test -s "$cidfile"; then
    cid=$(cat "$cidfile")
    if timeout --signal=KILL 5s docker inspect "$cid" >/dev/null 2>&1; then
      timeout --signal=KILL 10s docker rm -f "$cid" >/dev/null || status=1
    fi
  fi
  rm -f "$cidfile"
  rmdir "$work"
  exit "$status"
}}
trap cleanup EXIT
trap 'exit 143' HUP TERM
trap 'exit 130' INT
read_heartbeat() {{
  IFS=' ' read -r -t {LEASE_SECONDS} heartbeat heartbeat_at <&3 || return 1
  test "$heartbeat" = 'alive' || return 1
  case "$heartbeat_at" in ''|*[!0-9]*) return 1;; esac
}}
# Require a pulse generated after preflight, not one queued before a disconnected client.
fresh_after=$(date +%s)
while true; do
  test "$((deadline - $(date +%s) - 20))" -gt 0 || {{ echo 'Run deadline reached before publisher startup' >&2; exit 1; }}
  read_heartbeat || {{ echo 'Transport heartbeat ended before publisher startup' >&2; exit 1; }}
  if test "$heartbeat_at" -gt "$fresh_after"; then break; fi
done
container_seconds=$((deadline - $(date +%s) - 20))
test "$container_seconds" -gt 0 || {{ echo 'Run deadline reached before publisher startup' >&2; exit 1; }}
printf '%s\\n' "$payload" | timeout --signal=TERM --kill-after=10s "${{container_seconds}}s" docker run --rm -i \\
  --cidfile "$cidfile" --name agenthot-daily-publish --network host \\
  --read-only --tmpfs /tmp \\
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 768m \\
  {environment} \\
  agenthot-app {entrypoint} 3<&- &
runner=$!
unset payload
while kill -0 "$runner" >/dev/null 2>&1; do
  if ! read_heartbeat; then
    echo 'Transport heartbeat ended; stopping owned publisher' >&2
    exit 1
  fi
done
if wait "$runner"; then status=0; else status=$?; fi
runner=
exit "$status"
"""


def run_remote(mode, release, payload, deadline, adapter=None, port=None):
    # Forwarding and execution share one SSH lifetime. A server-side stdin lease also stops the
    # owned container if the client is killed or the network stops delivering channel traffic.
    forwards = ["-o", "ExitOnForwardFailure=yes", "-R", f"127.0.0.1:{REMOTE_PORT}:127.0.0.1:{port}"] if mode in {"collect", "probe"} else None
    command = "bash -c " + shlex.quote(remote_command(mode, release, remaining(deadline)))
    process = subprocess.Popen(ssh_command(command, forwards), stdin=subprocess.PIPE, text=True, start_new_session=True)
    try:
        process.stdin.write(json.dumps(payload) + "\n")
        process.stdin.flush()
        while process.poll() is None:
            if adapter is not None:
                if adapter.poll() is not None:
                    raise TransportError("The local Codex adapter exited; stopping publisher")
                try:
                    check_adapter(payload["token"], port, min(1, remaining(deadline)))
                except (urllib.error.URLError, TimeoutError) as error:
                    raise TransportError("The local Codex adapter is unavailable; stopping publisher") from error
            process.stdin.write(f"alive {int(time.time())}\n")
            process.stdin.flush()
            try:
                return process.wait(timeout=min(HEARTBEAT_SECONDS, remaining(deadline)))
            except subprocess.TimeoutExpired:
                pass
        return process.returncode
    except BrokenPipeError:
        return process.wait(timeout=5)
    finally:
        # EOF asks the remote shell to remove its exact CID before local forwarding is torn down.
        with contextlib.suppress(OSError):
            process.stdin.close()
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            stop_process(process)


def run(mode, before=None):
    started = time.monotonic()
    seconds = 30 if mode == "probe" else MAX_SECONDS
    if before is not None:
        if mode != "collect":
            raise TransportError("--before is only valid with --collect")
        try:
            cutoff = datetime.fromisoformat(before[:-1] + "+00:00" if before.endswith("Z") else before)
            if cutoff.utcoffset() is None:
                raise ValueError("timezone required")
        except (ValueError, TypeError, AttributeError) as error:
            raise TransportError("--before requires a timezone-qualified ISO timestamp") from error
        seconds = min(seconds, cutoff.timestamp() - time.time())
        if seconds <= 0:
            raise TransportError("Collection cutoff has already passed")
    deadline = started + seconds
    adapter = None
    with operation_lock():
        release = local_release()
        payload = {"expectedRelease": release}
        try:
            if mode in {"collect", "probe"}:
                remaining(deadline)
                token = secrets.token_urlsafe(48)
                port = unused_local_port()
                adapter = subprocess.Popen(
                    [node_binary(), str(ROOT / "modules/codex-cli/server.ts")], cwd=ROOT,
                    env=adapter_environment(token, port), stdin=subprocess.DEVNULL,
                    stdout=sys.stderr, start_new_session=True,
                )
                wait_for_adapter(adapter, token, port, deadline)
                payload.update(token=token, baseUrl=f"http://127.0.0.1:{REMOTE_PORT}/v1")
            return run_remote(mode, release, payload, deadline, adapter=adapter, port=port if adapter is not None else None)
        finally:
            stop_process(adapter)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--check", action="store_true", help="Read production status without an adapter or model calls")
    modes.add_argument("--probe", action="store_true", help="Verify authenticated reverse connectivity without collection or model calls")
    modes.add_argument("--collect", action="store_true", help="Collect and process without composing an issue")
    modes.add_argument("--publish", action="store_true", help="Publish the closed issue without collection or model calls")
    parser.add_argument("--before", help="Stop collection by this timezone-qualified ISO timestamp")
    args = parser.parse_args(argv)
    if args.before is not None and not args.collect:
        parser.error("--before is only valid with --collect")

    def interrupted(_signum, _frame):
        raise KeyboardInterrupt

    previous = signal.signal(signal.SIGTERM, interrupted)
    try:
        mode = "collect" if args.collect else "publish" if args.publish else "probe" if args.probe else "check"
        return run(mode) if args.before is None else run(mode, before=args.before)
    except (TransportError, OSError, subprocess.SubprocessError, KeyboardInterrupt) as error:
        message = "Daily publisher interrupted" if isinstance(error, KeyboardInterrupt) else str(error)
        print(json.dumps({"ok": False, "stage": "transport", "error": message}), file=sys.stderr)
        return 1
    finally:
        signal.signal(signal.SIGTERM, previous)


if __name__ == "__main__":
    sys.exit(main())
