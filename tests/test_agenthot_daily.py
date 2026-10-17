"""Offline transport tests: python3 -m unittest discover -s tests -p 'test_agenthot_daily.py'."""

import contextlib
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("agenthot_daily", Path(__file__).resolve().parents[1] / "scripts/agenthot-daily.py")
daily = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(daily)
RELEASE = "a" * 40
TOKEN = "fixture-token-that-must-not-enter-command-arguments"
NOW = daily.datetime.fromisoformat("2026-10-15T23:55:00+00:00").timestamp()


class TransportTests(unittest.TestCase):
    def test_remote_command_is_hardened_and_only_cleans_created_id(self):
        command = daily.remote_command("collect", RELEASE, 5400)
        for flag in ["--read-only", "--cap-drop ALL", "--security-opt no-new-privileges", "--pids-limit 256", "--memory 768m", "--network host", "--tmpfs /tmp", "--cidfile", "--name agenthot-daily-publish"]:
            self.assertIn(flag, command)
        self.assertIn('test -s "$cidfile"', command)
        self.assertIn('docker rm -f "$cid"', command)
        self.assertNotIn("docker rm -f agenthot-daily-publish", command)
        self.assertIn("agenthot-api-1", command)
        self.assertIn("git rev-parse HEAD", command)
        self.assertIn('container_seconds=$((deadline - $(date +%s) - 20))', command)
        self.assertIn('--signal=TERM --kill-after=10s "${container_seconds}s"', command)
        self.assertIn("modules/daily-publish/remote.ts --collect", command)
        self.assertIn("read -r -t 10 heartbeat heartbeat_at", command)
        self.assertNotIn("sleep 5400", command)
        self.assertNotIn(".codex", command)

    def test_ssh_requires_known_host_without_agent_or_multiplexing(self):
        command = daily.ssh_command("true")
        for option in ["StrictHostKeyChecking=yes", "BatchMode=yes", "ForwardAgent=no", "ControlPath=none"]:
            self.assertIn(option, command)
        self.assertEqual(command[-2:], ["hostinger-dokploy", "true"])

    def test_remote_shell_is_valid_without_executing_it(self):
        for mode in ["check", "collect", "publish", "probe"]:
            with self.subTest(mode=mode):
                command = daily.remote_command(mode, RELEASE, 60)
                result = subprocess.run(["bash", "-n"], input=command, text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual("ss -H -ltn" in command, mode in {"collect", "probe"})

    def test_probe_has_no_app_import_database_environment_or_model_endpoint(self):
        command = daily.remote_command("probe", RELEASE, 30)
        self.assertIn("node --input-type=module -e", command)
        for forbidden in ["remote.ts", "--env-file", "agenthot_data", "agenthot-db-1", "/chat/completions"]:
            self.assertNotIn(forbidden, command)
        self.assertIn("response.status !== 404", daily.PROBE_SCRIPT)
        self.assertIn("redirect: 'error'", daily.PROBE_SCRIPT)
        self.assertIn("http://127.0.0.1:14312/", daily.PROBE_SCRIPT)

    def test_adapter_environment_excludes_provider_and_project_secrets(self):
        with mock.patch.dict(os.environ, {"HOME": "/operator", "PATH": "/bin", "OPENAI_API_KEY": "private", "DATABASE_URL": "private", "CODEX_CLI_TOKEN": "stale"}, clear=True):
            env = daily.adapter_environment("temporary-token", 12345)
        self.assertEqual(env, {"HOME": "/operator", "PATH": "/bin", "CODEX_CLI_TOKEN": "temporary-token", "CODEX_CLI_PORT": "12345"})

    def base_mocks(self):
        stack = contextlib.ExitStack()
        stack.enter_context(mock.patch.object(daily, "operation_lock", contextlib.nullcontext))
        stack.enter_context(mock.patch.object(daily, "local_release", return_value=RELEASE))
        return stack

    def test_read_and_publish_modes_never_start_adapter_or_create_credentials(self):
        for mode in ["check", "publish"]:
            with self.subTest(mode=mode), self.base_mocks(), mock.patch.object(daily.subprocess, "Popen") as popen, mock.patch.object(daily, "node_binary") as node, mock.patch.object(daily.secrets, "token_urlsafe") as token, mock.patch.object(daily, "run_remote", return_value=0) as remote:
                self.assertEqual(daily.run(mode), 0)
            for unused in [popen, node, token]:
                unused.assert_not_called()
            self.assertEqual(remote.call_args.args[:3], (mode, RELEASE, {"expectedRelease": RELEASE}))
            self.assertEqual(remote.call_args.kwargs, {"adapter": None, "port": None})

    def test_cli_dispatches_each_explicit_mode(self):
        for mode in ["check", "collect", "publish", "probe"]:
            with self.subTest(mode=mode), mock.patch.object(daily, "run", return_value=7) as run:
                self.assertEqual(daily.main([f"--{mode}"]), 7)
            run.assert_called_once_with(mode)

    def test_cli_forwards_collection_cutoff(self):
        cutoff = "2026-10-16T08:00:00+08:00"
        with mock.patch.object(daily, "run", return_value=7) as run:
            self.assertEqual(daily.main(["--collect", "--before", cutoff]), 7)
        run.assert_called_once_with("collect", before=cutoff)

    def test_cutoff_is_rejected_for_other_modes_before_transport(self):
        for mode in ["check", "publish", "probe"]:
            with self.subTest(mode=mode), mock.patch.object(daily, "run") as run, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    daily.main([f"--{mode}", "--before", "2026-10-16T00:00:00Z"])
                self.assertEqual(raised.exception.code, 2)
                run.assert_not_called()
            with self.subTest(direct_mode=mode), mock.patch.object(daily, "operation_lock") as lock:
                with self.assertRaisesRegex(daily.TransportError, "only valid with --collect"):
                    daily.run(mode, before="2026-10-16T00:00:00Z")
                lock.assert_not_called()

    def test_invalid_naive_and_expired_cutoffs_start_nothing(self):
        for cutoff in ["", "not-a-date", "2026-02-30T00:00:00Z", "2026-10-16", "2026-10-16T08:00:00", "2026-10-15T23:55:00Z", "2026-10-15T20:00:00+08:00"]:
            with self.subTest(cutoff=cutoff), mock.patch.object(daily.time, "time", return_value=NOW), mock.patch.object(daily, "operation_lock") as lock, mock.patch.object(daily.subprocess, "Popen") as popen:
                with self.assertRaises(daily.TransportError):
                    daily.run("collect", before=cutoff)
                lock.assert_not_called()
                popen.assert_not_called()

    def test_timezone_cutoff_bounds_deadline_without_extending_run_limit(self):
        for cutoff, seconds in [("2026-10-16T00:00:00Z", 300), ("2026-10-16T08:00:00+08:00", 300), ("2026-10-15T20:00:00-04:00", 300), ("2026-10-17T00:00:00+00:00", daily.MAX_SECONDS)]:
            with self.subTest(cutoff=cutoff), self.base_mocks(), mock.patch.object(daily.time, "time", return_value=NOW), mock.patch.object(daily.time, "monotonic", return_value=100), mock.patch.object(daily, "node_binary", return_value="/node"), mock.patch.object(daily, "unused_local_port", return_value=12345), mock.patch.object(daily.subprocess, "Popen"), mock.patch.object(daily, "wait_for_adapter") as wait, mock.patch.object(daily, "run_remote", return_value=0) as remote, mock.patch.object(daily, "stop_process"):
                self.assertEqual(daily.run("collect", before=cutoff), 0)
                self.assertEqual(wait.call_args.args[-1], 100 + seconds)
                self.assertEqual(remote.call_args.args[-1], 100 + seconds)

    def test_cutoff_expiring_during_preflight_does_not_start_adapter(self):
        with self.base_mocks(), mock.patch.object(daily.time, "time", return_value=NOW), mock.patch.object(daily.time, "monotonic", side_effect=[100, 400]), mock.patch.object(daily.subprocess, "Popen") as popen, mock.patch.object(daily, "run_remote") as remote, mock.patch.object(daily, "stop_process"):
            with self.assertRaisesRegex(daily.TransportError, "run deadline"):
                daily.run("collect", before="2026-10-16T00:00:00Z")
            popen.assert_not_called()
            remote.assert_not_called()

    def test_removed_run_flag_is_rejected_before_any_transport(self):
        with mock.patch.object(daily, "run") as run, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                daily.main(["--run"])
        self.assertEqual(raised.exception.code, 2)
        run.assert_not_called()

    def test_adapter_is_always_cleaned_and_token_stays_out_of_argv(self):
        for mode in ["collect", "probe"]:
            for outcome in [7, daily.TransportError("stopped"), KeyboardInterrupt()]:
                adapter = mock.Mock()
                with self.subTest(mode=mode, outcome=type(outcome)), self.base_mocks(), mock.patch.object(daily.time, "monotonic", return_value=100), mock.patch.object(daily, "node_binary", return_value="/node"), mock.patch.object(daily, "unused_local_port", return_value=12345), mock.patch.object(daily.secrets, "token_urlsafe", return_value=TOKEN), mock.patch.object(daily.subprocess, "Popen", return_value=adapter) as popen, mock.patch.object(daily, "wait_for_adapter"), mock.patch.object(daily, "run_remote") as remote, mock.patch.object(daily, "stop_process") as stop:
                    if isinstance(outcome, int):
                        remote.return_value = outcome
                        self.assertEqual(daily.run(mode), outcome)
                    else:
                        remote.side_effect = outcome
                        with self.assertRaises(type(outcome)):
                            daily.run(mode)
                self.assertNotIn(TOKEN, " ".join(popen.call_args.args[0]))
                self.assertEqual(popen.call_args.kwargs["env"]["CODEX_CLI_TOKEN"], TOKEN)
                self.assertEqual(remote.call_args.args[2], {"token": TOKEN, "baseUrl": "http://127.0.0.1:14312/v1", "expectedRelease": RELEASE})
                self.assertEqual(remote.call_args.args[-1], 100 + (30 if mode == "probe" else daily.MAX_SECONDS))
                stop.assert_called_once_with(adapter)

    def test_one_ssh_process_owns_forwarding_execution_and_configuration_stdin(self):
        for mode in ["collect", "probe", "check", "publish"]:
            process = mock.Mock(returncode=0)
            process.poll.return_value = 0
            with self.subTest(mode=mode), mock.patch.object(daily.subprocess, "Popen", return_value=process) as popen:
                self.assertEqual(daily.run_remote(mode, RELEASE, {"token": TOKEN}, time.monotonic() + 30, port=12345), 0)
            popen.assert_called_once()
            command = popen.call_args.args[0]
            self.assertNotIn(TOKEN, " ".join(command))
            self.assertTrue(command[-1].startswith("bash -c "))
            self.assertEqual("-R" in command, mode in {"collect", "probe"})
            if mode in {"collect", "probe"}:
                self.assertIn("127.0.0.1:14312:127.0.0.1:12345", command)
                self.assertIn("ExitOnForwardFailure=yes", command)
            self.assertEqual(json.loads(process.stdin.write.call_args.args[0]), {"token": TOKEN})
            process.stdin.close.assert_called_once()

    def test_stop_process_escalates_only_owned_group(self):
        process = mock.Mock(pid=4321)
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("adapter", 5), 0]
        with mock.patch.object(daily.os, "killpg") as kill:
            daily.stop_process(process)
        self.assertEqual(kill.call_args_list, [mock.call(4321, signal.SIGTERM), mock.call(4321, signal.SIGKILL)])

    def test_concurrent_local_invocation_fails_before_startup(self):
        with mock.patch.object(daily.fcntl, "flock", side_effect=BlockingIOError), mock.patch.object(daily.Path, "mkdir"), mock.patch.object(daily.Path, "open", mock.mock_open()):
            with self.assertRaisesRegex(daily.TransportError, "already running"):
                with daily.operation_lock():
                    self.fail("Concurrent invocation entered the critical section")


# These executables emulate only the external command boundaries. Bash, stdin EOF,
# signals, subprocess waiting and the container's ongoing activity are real.
FAKE_COMMAND = r'''
import contextlib, json, os, pathlib, signal, sys, time
root = pathlib.Path(os.environ["FAKE_ROOT"])
args = sys.argv[1:]
name = pathlib.Path(sys.argv[0]).name
if name == "git":
    time.sleep(float(os.environ.get("FAKE_PREFLIGHT_DELAY", "0")))
    print("a" * 40)
elif name == "ss":
    print("LISTEN 0 1 127.0.0.1:14312 0.0.0.0:*")
elif name == "timeout":
    index = next(index for index, arg in enumerate(args) if not arg.startswith("--")) + 1
    os.execvp(args[index], args[index:])
elif name == "docker":
    if args[:2] == ["image", "inspect"]:
        if os.environ.get("FAKE_IMAGE_FAIL"):
            sys.exit(1)
        print("image-id")
    elif args[0] == "inspect" and "--format" in args:
        fmt = args[args.index("--format") + 1]
        if fmt == "{{.Image}}" and os.environ.get("FAKE_IMAGE_FAIL"):
            sys.exit(1)
        print("image-id" if fmt == "{{.Image}}" else "172.22.0.2" if "IPAddress" in fmt else "AIHOT_RELEASE=" + "a" * 40)
    elif args[0] == "inspect":
        sys.exit(0 if (root / "container-pid").exists() else 1)
    elif args[0] == "run":
        if os.environ.get("FAKE_EXISTING"):
            sys.exit(125)
        pathlib.Path(args[args.index("--cidfile") + 1]).write_text("owned-fixture")
        (root / "container-pid").write_text(str(os.getpid()))
        config = json.load(sys.stdin)
        (root / "input-fields").write_text(json.dumps(sorted(config)))
        if os.environ.get("FAKE_FINISH"):
            time.sleep(.1)
            sys.exit(0)
        while True:
            with (root / "activity").open("a") as output:
                output.write("fixture request\n")
            time.sleep(.02)
    elif args[0] == "rm":
        with (root / "removed").open("a") as output:
            output.write(args[-1] + "\n")
        if args[-1] != "owned-fixture":
            sys.exit(99)
        pidfile = root / "container-pid"
        if pidfile.exists():
            with contextlib.suppress(ProcessLookupError):
                os.kill(int(pidfile.read_text()), signal.SIGTERM)
            pidfile.unlink()
'''


class RemoteLeaseTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        for name in ["git", "ss", "timeout", "docker"]:
            command = self.root / name
            command.write_text(f"#!{sys.executable}\n" + FAKE_COMMAND)
            command.chmod(0o700)
        self.env = {**os.environ, "FAKE_ROOT": str(self.root), "PATH": str(self.root) + os.pathsep + os.environ["PATH"]}
        self.children = []
        self.heartbeats = []

    def tearDown(self):
        for _process, event, worker in self.heartbeats:
            event.set()
            worker.join(timeout=1)
        for child in self.children:
            daily.stop_process(child)
            for stream in [child.stdin, child.stdout, child.stderr]:
                if stream is not None:
                    stream.close()
        pidfile = self.root / "container-pid"
        if pidfile.exists():
            with contextlib.suppress(ProcessLookupError):
                os.kill(int(pidfile.read_text()), signal.SIGKILL)
        self.directory.cleanup()

    def script(self, mode="collect"):
        return daily.remote_command(mode, RELEASE, 60).replace("cd /opt/agenthot", "cd " + daily.shlex.quote(str(self.root)))

    def start(self):
        process = subprocess.Popen(["bash", "-c", self.script()], env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        self.children.append(process)
        process.stdin.write(json.dumps({"expectedRelease": RELEASE, "token": TOKEN}) + "\n")
        process.stdin.flush()
        event = threading.Event()

        def heartbeat():
            while not event.is_set():
                try:
                    process.stdin.write(f"alive {int(time.time())}\n")
                    process.stdin.flush()
                except (OSError, ValueError):
                    return
                event.wait(.1)

        worker = threading.Thread(target=heartbeat)
        self.heartbeats.append((process, event, worker))
        worker.start()
        return process

    def stop_heartbeat(self, process):
        for child, event, worker in self.heartbeats:
            if child is process:
                event.set()
                worker.join(timeout=1)

    def wait_started(self):
        deadline = time.monotonic() + 5
        while not (self.root / "input-fields").exists():
            if time.monotonic() >= deadline:
                self.fail("Fake publisher did not start")
            time.sleep(.01)

    def assert_cleaned(self):
        self.assertEqual((self.root / "removed").read_text(), "owned-fixture\n")
        self.assertFalse((self.root / "container-pid").exists())
        activity = self.root / "activity"
        if activity.exists():
            before = activity.read_text()
            time.sleep(.06)
            self.assertEqual(activity.read_text(), before)

    def test_client_stdin_eof_stops_activity_and_cleans_only_owned_container(self):
        process = self.start()
        self.wait_started()
        self.stop_heartbeat(process)
        process.stdin.close()
        self.assertEqual(process.wait(timeout=3), 1)
        self.assert_cleaned()
        self.assertEqual(json.loads((self.root / "input-fields").read_text()), ["expectedRelease", "token"])
        self.assertNotIn(TOKEN, process.stdout.read() + process.stderr.read())

    def test_lost_heartbeat_stops_remote_even_when_ssh_stdin_remains_open(self):
        with mock.patch.object(daily, "LEASE_SECONDS", 1):
            process = self.start()
        self.wait_started()
        self.stop_heartbeat(process)
        self.assertEqual(process.wait(timeout=4), 1)
        self.assert_cleaned()

    def test_remote_sigterm_interrupts_wait_and_cleans_owned_container(self):
        process = self.start()
        self.wait_started()
        process.terminate()
        self.assertEqual(process.wait(timeout=3), 143)
        self.assert_cleaned()

    def test_existing_container_is_not_removed(self):
        self.env["FAKE_EXISTING"] = "1"
        with mock.patch.dict(os.environ, self.env, clear=True), mock.patch.object(daily, "ssh_command", return_value=["bash", "-c", self.script("publish")]), mock.patch.object(daily, "HEARTBEAT_SECONDS", .05):
            self.assertEqual(daily.run_remote("publish", RELEASE, {"expectedRelease": RELEASE}, time.monotonic() + 5), 125)
        self.assertFalse((self.root / "removed").exists())

    def test_normal_completion_separates_configuration_from_heartbeats(self):
        self.env["FAKE_FINISH"] = "1"
        with mock.patch.dict(os.environ, self.env, clear=True), mock.patch.object(daily, "ssh_command", return_value=["bash", "-c", self.script("publish")]), mock.patch.object(daily, "HEARTBEAT_SECONDS", .05):
            self.assertEqual(daily.run_remote("publish", RELEASE, {"expectedRelease": RELEASE}, time.monotonic() + 5), 0)
        self.assert_cleaned()
        self.assertEqual(json.loads((self.root / "input-fields").read_text()), ["expectedRelease"])

    def test_adapter_exit_closes_lease_and_stops_publisher(self):
        adapter = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True)
        self.children.append(adapter)

        def exit_after_start():
            self.wait_started()
            adapter.terminate()

        worker = threading.Thread(target=exit_after_start)
        worker.start()
        try:
            with mock.patch.dict(os.environ, self.env, clear=True), mock.patch.object(daily, "ssh_command", return_value=["bash", "-c", self.script()]), mock.patch.object(daily, "check_adapter"), mock.patch.object(daily, "HEARTBEAT_SECONDS", .05):
                with self.assertRaisesRegex(daily.TransportError, "adapter exited"):
                    daily.run_remote("collect", RELEASE, {"expectedRelease": RELEASE, "token": TOKEN}, time.monotonic() + 5, adapter=adapter, port=12345)
        finally:
            worker.join(timeout=6)
        self.assert_cleaned()

    def test_adapter_health_failure_closes_lease_and_stops_publisher(self):
        def health(*_args):
            if (self.root / "input-fields").exists():
                raise daily.urllib.error.URLError("fixture unavailable")

        with mock.patch.dict(os.environ, self.env, clear=True), mock.patch.object(daily, "ssh_command", return_value=["bash", "-c", self.script()]), mock.patch.object(daily, "check_adapter", side_effect=health), mock.patch.object(daily, "HEARTBEAT_SECONDS", .05):
            with self.assertRaisesRegex(daily.TransportError, "adapter is unavailable"):
                daily.run_remote("collect", RELEASE, {"expectedRelease": RELEASE, "token": TOKEN}, time.monotonic() + 5, adapter=mock.Mock(poll=lambda: None), port=12345)
        self.assert_cleaned()

    def test_local_deadline_stops_owned_remote_activity(self):
        with mock.patch.dict(os.environ, self.env, clear=True), mock.patch.object(daily, "ssh_command", return_value=["bash", "-c", self.script("publish")]), mock.patch.object(daily, "HEARTBEAT_SECONDS", .05):
            with self.assertRaisesRegex(daily.TransportError, "run deadline"):
                daily.run_remote("publish", RELEASE, {"expectedRelease": RELEASE}, time.monotonic() + 4)
        self.assert_cleaned()

    def test_local_sigterm_closes_lease_before_ssh_shutdown(self):
        launcher = f"""import contextlib, importlib.util, sys
spec = importlib.util.spec_from_file_location('daily', {str(SPEC.origin)!r})
daily = importlib.util.module_from_spec(spec)
spec.loader.exec_module(daily)
daily.operation_lock = contextlib.nullcontext
daily.local_release = lambda: {'a' * 40!r}
daily.ssh_command = lambda *args: ['bash', '-c', {self.script('publish')!r}]
sys.exit(daily.main(['--publish']))
"""
        process = subprocess.Popen([sys.executable, "-c", launcher], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        self.children.append(process)
        self.wait_started()
        process.terminate()
        self.assertEqual(process.wait(timeout=5), 1)
        self.assert_cleaned()
        self.assertIn("Daily publisher interrupted", process.stderr.read())

    def test_preflight_crossing_absolute_deadline_never_starts_container(self):
        self.env["FAKE_PREFLIGHT_DELAY"] = "2"
        with mock.patch.object(daily.time, "time", return_value=time.time() - 59):
            script = self.script("publish")
        with mock.patch.dict(os.environ, self.env, clear=True), mock.patch.object(daily, "ssh_command", return_value=["bash", "-c", script]), mock.patch.object(daily, "HEARTBEAT_SECONDS", .05):
            self.assertEqual(daily.run_remote("publish", RELEASE, {"expectedRelease": RELEASE}, time.monotonic() + 8), 1)
        self.assertFalse((self.root / "input-fields").exists())
        self.assertFalse((self.root / "container-pid").exists())
        self.assertFalse((self.root / "removed").exists())

    def test_both_image_queries_failing_cannot_pass_as_equal_empty_strings(self):
        self.env["FAKE_IMAGE_FAIL"] = "1"
        with mock.patch.dict(os.environ, self.env, clear=True), mock.patch.object(daily, "ssh_command", return_value=["bash", "-c", self.script("publish")]), mock.patch.object(daily, "HEARTBEAT_SECONDS", .05):
            self.assertEqual(daily.run_remote("publish", RELEASE, {"expectedRelease": RELEASE}, time.monotonic() + 5), 1)
        self.assertFalse((self.root / "input-fields").exists())
        self.assertFalse((self.root / "container-pid").exists())
        self.assertFalse((self.root / "removed").exists())

    def test_disconnected_client_after_preflight_cannot_use_buffered_old_heartbeat(self):
        self.env["FAKE_PREFLIGHT_DELAY"] = "1"
        process = subprocess.Popen(["bash", "-c", self.script()], env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        self.children.append(process)
        process.stdin.write(json.dumps({"expectedRelease": RELEASE, "token": TOKEN}) + f"\nalive {int(time.time())}\n")
        process.stdin.close()
        self.assertEqual(process.wait(timeout=5), 1)
        self.assertFalse((self.root / "input-fields").exists())
        self.assertFalse((self.root / "container-pid").exists())
        self.assertFalse((self.root / "removed").exists())


class AdapterHealthTests(unittest.TestCase):
    def test_authenticated_health_is_not_a_completion_request(self):
        requests = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append((self.command, self.path))
                self.send_response(404 if self.headers.get("Authorization") == f"Bearer {TOKEN}" else 401)
                self.end_headers()
                self.wfile.write(b'{"error":{"message":"Not found"}}')

            def log_message(self, *_args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever)
        worker.start()
        try:
            daily.check_adapter(TOKEN, server.server_port, 1)
            with self.assertRaisesRegex(daily.TransportError, "temporary token"):
                daily.check_adapter("wrong", server.server_port, 1)
        finally:
            server.shutdown()
            server.server_close()
            worker.join()
        self.assertEqual(requests, [("GET", "/"), ("GET", "/")])

    def test_remote_probe_uses_authenticated_get_and_fails_closed(self):
        requests = []
        response = {"status": 404, "body": b'{"error":{"message":"Not found"}}'}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append((self.command, self.path))
                self.send_response(response["status"] if self.headers.get("Authorization") == f"Bearer {TOKEN}" else 401)
                self.send_header("Location", "/must-not-follow")
                self.end_headers()
                self.wfile.write(response["body"])

            def log_message(self, *_args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever)
        worker.start()
        try:
            script = daily.PROBE_SCRIPT.replace(":14312", f":{server.server_port}")
            for token, status, body, expected in [(TOKEN, 404, b'{"error":{"message":"Not found"}}', 0), ("wrong", 404, b'{}', 1), (TOKEN, 200, b'{}', 1), (TOKEN, 404, b'{}', 1), (TOKEN, 302, b'{}', 1)]:
                with self.subTest(status=status, expected=expected):
                    response.update(status=status, body=body)
                    result = subprocess.run([daily.node_binary(), "--input-type=module", "-e", script], input=json.dumps({"token": token, "baseUrl": f"http://127.0.0.1:{server.server_port}/v1"}), text=True, capture_output=True, timeout=10)
                    self.assertEqual(result.returncode, expected, result.stderr)
                    self.assertNotIn(TOKEN, result.stdout + result.stderr)
                    data = json.loads(result.stdout if expected == 0 else result.stderr)
                    self.assertEqual(data["ok"], expected == 0)
        finally:
            server.shutdown()
            server.server_close()
            worker.join()
        self.assertEqual(requests, [("GET", "/")] * 5)


if __name__ == "__main__":
    unittest.main()
