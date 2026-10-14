#!/usr/bin/env python3
"""Run the production daily publisher through a temporary, local Codex adapter."""

import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import secrets
import select
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
        raise TransportError("Daily publisher exceeded its 90-minute deadline")
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


def wait_for_adapter(process, token, port, deadline):
    deadline = min(deadline, time.monotonic() + 20)
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/", headers={"Authorization": f"Bearer {token}"},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    while remaining(deadline):
        if process.poll() is not None:
            raise TransportError("The local Codex adapter exited during startup")
        try:
            with opener.open(request, timeout=min(1, remaining(deadline))):
                raise TransportError("Unexpected service on the local adapter port")
        except urllib.error.HTTPError as error:
            with error:
                if error.code == 404 and json.load(error) == {"error": {"message": "Not found"}}:
                    return
            raise TransportError("The local adapter did not accept its temporary token")
        except urllib.error.URLError:
            time.sleep(0.1)


def start_tunnel(port, deadline):
    process = subprocess.Popen(
        ssh_command(
            f"test \"$(ss -H -ltn '( sport = :{REMOTE_PORT} )' | awk '{{print $4}}')\" = "
            f"'127.0.0.1:{REMOTE_PORT}' || exit 1; "
            "printf 'agenthot-tunnel-ready\\n'; exec sleep 5400",
            ["-o", "ExitOnForwardFailure=yes", "-R", f"127.0.0.1:{REMOTE_PORT}:127.0.0.1:{port}"],
        ),
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, text=True, start_new_session=True,
    )
    try:
        ready, _, _ = select.select([process.stdout], [], [], min(30, remaining(deadline)))
        if not ready or process.stdout.readline().strip() != "agenthot-tunnel-ready":
            raise TransportError("The temporary SSH reverse tunnel did not become ready")
        return process
    except BaseException:
        stop_process(process)
        raise


def remote_command(mode, release, seconds):
    # Docker writes the cidfile only after this invocation creates its container.
    # Never remove an existing container by its shared daily-publish name.
    return f"""set -eu
cd /opt/agenthot
test "$(git rev-parse HEAD)" = {shlex.quote(release)} || {{ echo 'Production checkout does not match local HEAD' >&2; exit 1; }}
test "$(docker inspect --format '{{{{.Image}}}}' agenthot-api-1)" = "$(docker image inspect --format '{{{{.Id}}}}' agenthot-app)" || {{ echo 'Publisher image does not match the running API' >&2; exit 1; }}
api_release=$(docker inspect --format '{{{{range .Config.Env}}}}{{{{println .}}}}{{{{end}}}}' agenthot-api-1 | sed -n 's/^AIHOT_RELEASE=//p')
test "$api_release" = {shlex.quote(release)} || {{ echo 'Running API release does not match local HEAD' >&2; exit 1; }}
db_ip=$(docker inspect --format '{{{{with index .NetworkSettings.Networks "agenthot_default"}}}}{{{{.IPAddress}}}}{{{{end}}}}' agenthot-db-1)
test -n "$db_ip" || {{ echo 'Production database network address is unavailable' >&2; exit 1; }}
work=$(mktemp -d /tmp/agenthot-daily.XXXXXXXX)
cidfile="$work/container-id"
cleanup() {{
  status=$?
  trap - EXIT HUP INT TERM
  if test -s "$cidfile"; then
    cid=$(cat "$cidfile")
    if docker inspect "$cid" >/dev/null 2>&1; then
      docker rm -f "$cid" >/dev/null || status=1
    fi
  fi
  rm -f "$cidfile"
  rmdir "$work"
  exit "$status"
}}
trap cleanup EXIT
trap 'exit 143' HUP TERM
trap 'exit 130' INT
timeout --signal=TERM --kill-after=10s {max(1, int(seconds) - 20)}s docker run --rm -i \\
  --cidfile "$cidfile" --name agenthot-daily-publish --network host \\
  --env-file /opt/agenthot/.env --read-only --tmpfs /tmp \\
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 768m \\
  -v agenthot_data:/data -e AGENTHOT_DATABASE_HOST="$db_ip" \\
  agenthot-app node modules/daily-publish/remote.ts --{mode}
"""


def run(mode):
    deadline = time.monotonic() + MAX_SECONDS
    adapter = tunnel = None
    with operation_lock():
        release = local_release()
        payload = {"expectedRelease": release}
        try:
            if mode == "run":
                token = secrets.token_urlsafe(48)
                port = unused_local_port()
                adapter = subprocess.Popen(
                    [node_binary(), str(ROOT / "modules/codex-cli/server.ts")], cwd=ROOT,
                    env=adapter_environment(token, port), stdin=subprocess.DEVNULL,
                    stdout=sys.stderr, start_new_session=True,
                )
                wait_for_adapter(adapter, token, port, deadline)
                tunnel = start_tunnel(port, deadline)
                payload.update(token=token, baseUrl=f"http://127.0.0.1:{REMOTE_PORT}/v1")
            seconds = remaining(deadline)
            result = subprocess.run(
                ssh_command(remote_command(mode, release, seconds)),
                input=json.dumps(payload), text=True, timeout=seconds, check=False,
            )
            return result.returncode
        finally:
            try:
                stop_process(tunnel)
            finally:
                stop_process(adapter)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--check", action="store_true", help="Read production status without an adapter or model calls")
    modes.add_argument("--run", action="store_true", help="Run one bounded production collection/publication cycle")
    args = parser.parse_args(argv)

    def interrupted(_signum, _frame):
        raise KeyboardInterrupt

    previous = signal.signal(signal.SIGTERM, interrupted)
    try:
        return run("run" if args.run else "check")
    except (TransportError, OSError, subprocess.SubprocessError, KeyboardInterrupt) as error:
        message = "Daily publisher interrupted" if isinstance(error, KeyboardInterrupt) else str(error)
        print(json.dumps({"ok": False, "stage": "transport", "error": message}), file=sys.stderr)
        return 1
    finally:
        signal.signal(signal.SIGTERM, previous)


if __name__ == "__main__":
    sys.exit(main())
