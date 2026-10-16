"""Offline transport tests: python3 -m unittest discover -s tests -p 'test_agenthot_daily.py'."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("agenthot_daily", Path(__file__).resolve().parents[1] / "scripts/agenthot-daily.py")
daily = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(daily)
RELEASE = "a" * 40
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
        self.assertIn("--signal=TERM --kill-after=10s 5380s", command)
        self.assertIn("modules/daily-publish/remote.ts --collect", command)
        self.assertNotIn(".codex", command)

    def test_ssh_requires_known_host_without_agent_or_multiplexing(self):
        command = daily.ssh_command("true")
        self.assertIn("StrictHostKeyChecking=yes", command)
        self.assertIn("BatchMode=yes", command)
        self.assertIn("ForwardAgent=no", command)
        self.assertIn("ControlPath=none", command)
        self.assertEqual(command[-2:], ["hostinger-dokploy", "true"])

    def test_remote_shell_is_valid_without_executing_it(self):
        for mode in ["check", "collect", "publish"]:
            with self.subTest(mode=mode):
                result = subprocess.run(["sh", "-n"], input=daily.remote_command(mode, RELEASE, 60), text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"modules/daily-publish/remote.ts --{mode}", daily.remote_command(mode, RELEASE, 60))

    def test_adapter_environment_excludes_provider_and_project_secrets(self):
        with mock.patch.dict(os.environ, {"HOME": "/operator", "PATH": "/bin", "OPENAI_API_KEY": "private", "DATABASE_URL": "private", "CODEX_CLI_TOKEN": "stale"}, clear=True):
            env = daily.adapter_environment("temporary-token", 12345)
        self.assertEqual(env, {"HOME": "/operator", "PATH": "/bin", "CODEX_CLI_TOKEN": "temporary-token", "CODEX_CLI_PORT": "12345"})

    def base_mocks(self):
        stack = contextlib.ExitStack()
        stack.enter_context(mock.patch.object(daily, "operation_lock", contextlib.nullcontext))
        stack.enter_context(mock.patch.object(daily, "local_release", return_value=RELEASE))
        return stack

    def test_check_never_starts_adapter_or_tunnel(self):
        with self.base_mocks(), mock.patch.object(daily.subprocess, "Popen") as popen, mock.patch.object(daily, "start_tunnel") as tunnel, mock.patch.object(daily.subprocess, "run", return_value=mock.Mock(returncode=0)) as run:
            self.assertEqual(daily.run("check"), 0)
        popen.assert_not_called()
        tunnel.assert_not_called()
        self.assertEqual(json.loads(run.call_args.kwargs["input"]), {"expectedRelease": RELEASE})
        self.assertIn("--check", run.call_args.args[0][-1])

    def test_publish_never_starts_adapter_or_tunnel_or_creates_credentials(self):
        with self.base_mocks(), mock.patch.object(daily.subprocess, "Popen") as popen, mock.patch.object(daily, "start_tunnel") as tunnel, mock.patch.object(daily, "node_binary") as node, mock.patch.object(daily, "unused_local_port") as port, mock.patch.object(daily.secrets, "token_urlsafe") as token, mock.patch.object(daily, "wait_for_adapter") as wait, mock.patch.object(daily.subprocess, "run", return_value=mock.Mock(returncode=0)) as run:
            self.assertEqual(daily.run("publish"), 0)
        for unused in [popen, tunnel, node, port, token, wait]:
            unused.assert_not_called()
        self.assertEqual(json.loads(run.call_args.kwargs["input"]), {"expectedRelease": RELEASE})
        self.assertIn("modules/daily-publish/remote.ts --publish", run.call_args.args[0][-1])
        self.assertNotIn("CODEX_CLI_TOKEN", run.call_args.args[0][-1])
        self.assertNotIn("CODEX_CLI_BASE_URL", run.call_args.args[0][-1])

    def test_cli_dispatches_each_explicit_phase(self):
        for mode in ["check", "collect", "publish"]:
            with self.subTest(mode=mode), mock.patch.object(daily, "run", return_value=7) as run:
                self.assertEqual(daily.main([f"--{mode}"]), 7)
            run.assert_called_once_with(mode)

    def test_cli_forwards_collection_cutoff(self):
        cutoff = "2026-10-16T08:00:00+08:00"
        with mock.patch.object(daily, "run", return_value=7) as run:
            self.assertEqual(daily.main(["--collect", "--before", cutoff]), 7)
        run.assert_called_once_with("collect", before=cutoff)

    def test_cutoff_is_rejected_for_other_modes_before_transport(self):
        for mode in ["check", "publish"]:
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
            with self.subTest(cutoff=cutoff), mock.patch.object(daily.time, "time", return_value=NOW), mock.patch.object(daily, "operation_lock") as lock, mock.patch.object(daily.subprocess, "Popen") as popen, mock.patch.object(daily.subprocess, "run") as run:
                with self.assertRaises(daily.TransportError):
                    daily.run("collect", before=cutoff)
                for unused in [lock, popen, run]:
                    unused.assert_not_called()

    def test_timezone_cutoff_bounds_local_and_remote_timeouts_without_extending_run_limit(self):
        for cutoff, seconds in [("2026-10-16T00:00:00Z", 300), ("2026-10-16T08:00:00+08:00", 300), ("2026-10-15T20:00:00-04:00", 300), ("2026-10-17T00:00:00+00:00", daily.MAX_SECONDS)]:
            with self.subTest(cutoff=cutoff), self.base_mocks(), mock.patch.object(daily.time, "time", return_value=NOW), mock.patch.object(daily.time, "monotonic", return_value=100), mock.patch.object(daily, "node_binary", return_value="/node"), mock.patch.object(daily, "unused_local_port", return_value=12345), mock.patch.object(daily.subprocess, "Popen"), mock.patch.object(daily, "wait_for_adapter") as wait, mock.patch.object(daily, "start_tunnel") as tunnel, mock.patch.object(daily.subprocess, "run", return_value=mock.Mock(returncode=0)) as run, mock.patch.object(daily, "stop_process"):
                self.assertEqual(daily.run("collect", before=cutoff), 0)
                self.assertEqual(wait.call_args.args[-1], 100 + seconds)
                tunnel.assert_called_once_with(12345, 100 + seconds)
                self.assertEqual(run.call_args.kwargs["timeout"], seconds)
                self.assertIn(f"--signal=TERM --kill-after=10s {seconds - 20}s", run.call_args.args[0][-1])

    def test_cutoff_expiring_during_preflight_does_not_start_adapter(self):
        with self.base_mocks(), mock.patch.object(daily.time, "time", return_value=NOW), mock.patch.object(daily.time, "monotonic", side_effect=[100, 400]), mock.patch.object(daily.subprocess, "Popen") as popen, mock.patch.object(daily, "start_tunnel") as tunnel, mock.patch.object(daily, "stop_process"):
            with self.assertRaisesRegex(daily.TransportError, "run deadline"):
                daily.run("collect", before="2026-10-16T00:00:00Z")
            popen.assert_not_called()
            tunnel.assert_not_called()

    def test_cutoff_timeout_still_cleans_only_owned_tunnel_and_adapter(self):
        adapter, tunnel = mock.Mock(), mock.Mock()
        with self.base_mocks(), mock.patch.object(daily.time, "time", return_value=NOW), mock.patch.object(daily.time, "monotonic", return_value=100), mock.patch.object(daily, "node_binary", return_value="/node"), mock.patch.object(daily, "unused_local_port", return_value=12345), mock.patch.object(daily.subprocess, "Popen", return_value=adapter), mock.patch.object(daily, "wait_for_adapter"), mock.patch.object(daily, "start_tunnel", return_value=tunnel), mock.patch.object(daily.subprocess, "run", side_effect=subprocess.TimeoutExpired("ssh", 300)) as run, mock.patch.object(daily, "stop_process") as stop:
            with self.assertRaises(subprocess.TimeoutExpired):
                daily.run("collect", before="2026-10-16T00:00:00Z")
        self.assertEqual(run.call_args.kwargs["timeout"], 300)
        self.assertEqual(stop.call_args_list, [mock.call(tunnel), mock.call(adapter)])

    def test_removed_run_flag_is_rejected_before_any_transport(self):
        with mock.patch.object(daily, "run") as run, mock.patch.object(daily, "operation_lock") as lock, contextlib.redirect_stderr(io.StringIO()) as stderr:
            with self.assertRaises(SystemExit) as raised:
                daily.main(["--run"])
        self.assertEqual(raised.exception.code, 2)
        self.assertIn("--collect", stderr.getvalue())
        self.assertIn("--publish", stderr.getvalue())
        run.assert_not_called()
        lock.assert_not_called()

    def test_collect_only_sends_token_in_environment_and_stdin_and_cleans_up(self):
        adapter, tunnel = mock.Mock(), mock.Mock()
        with self.base_mocks(), mock.patch.object(daily, "node_binary", return_value="/node"), mock.patch.object(daily, "unused_local_port", return_value=12345), mock.patch.object(daily.secrets, "token_urlsafe", return_value="temporary-secret"), mock.patch.object(daily.subprocess, "Popen", return_value=adapter) as popen, mock.patch.object(daily, "wait_for_adapter"), mock.patch.object(daily, "start_tunnel", return_value=tunnel), mock.patch.object(daily.subprocess, "run", return_value=mock.Mock(returncode=7)) as run, mock.patch.object(daily, "stop_process") as stop:
            self.assertEqual(daily.run("collect"), 7)
        self.assertNotIn("temporary-secret", " ".join(popen.call_args.args[0]))
        self.assertEqual(popen.call_args.kwargs["env"]["CODEX_CLI_TOKEN"], "temporary-secret")
        self.assertNotIn("temporary-secret", " ".join(run.call_args.args[0]))
        self.assertEqual(json.loads(run.call_args.kwargs["input"]), {"token": "temporary-secret", "baseUrl": "http://127.0.0.1:14312/v1", "expectedRelease": RELEASE})
        self.assertIn("modules/daily-publish/remote.ts --collect", run.call_args.args[0][-1])
        self.assertLessEqual(run.call_args.kwargs["timeout"], daily.MAX_SECONDS)
        self.assertEqual(stop.call_args_list, [mock.call(tunnel), mock.call(adapter)])

    def test_adapter_is_stopped_when_tunnel_start_fails(self):
        adapter = mock.Mock()
        with self.base_mocks(), mock.patch.object(daily, "node_binary", return_value="/node"), mock.patch.object(daily, "unused_local_port", return_value=12345), mock.patch.object(daily.subprocess, "Popen", return_value=adapter), mock.patch.object(daily, "wait_for_adapter"), mock.patch.object(daily, "start_tunnel", side_effect=daily.TransportError("failed")), mock.patch.object(daily, "stop_process") as stop:
            with self.assertRaises(daily.TransportError):
                daily.run("collect")
        self.assertEqual(stop.call_args_list, [mock.call(None), mock.call(adapter)])

    def test_tunnel_failure_stops_only_its_process(self):
        tunnel = mock.Mock(stdout=io.StringIO(""))
        with mock.patch.object(daily.subprocess, "Popen", return_value=tunnel) as popen, mock.patch.object(daily.select, "select", return_value=([], [], [])), mock.patch.object(daily, "stop_process") as stop:
            with self.assertRaises(daily.TransportError):
                daily.start_tunnel(12345, daily.time.monotonic() + 60)
        self.assertIn("127.0.0.1:14312:127.0.0.1:12345", popen.call_args.args[0])
        self.assertIn("ExitOnForwardFailure=yes", popen.call_args.args[0])
        self.assertIn("ss -H -ltn", popen.call_args.args[0][-1])
        self.assertIn("'127.0.0.1:14312'", popen.call_args.args[0][-1])
        stop.assert_called_once_with(tunnel)

    def test_stop_process_escalates_only_owned_group(self):
        process = mock.Mock(pid=4321)
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("adapter", 5), 0]
        with mock.patch.object(daily.os, "killpg") as kill:
            daily.stop_process(process)
        self.assertEqual(kill.call_args_list, [mock.call(4321, signal.SIGTERM), mock.call(4321, signal.SIGKILL)])

    def test_remote_timeout_still_cleans_up(self):
        adapter, tunnel = mock.Mock(), mock.Mock()
        with self.base_mocks(), mock.patch.object(daily, "node_binary", return_value="/node"), mock.patch.object(daily, "unused_local_port", return_value=12345), mock.patch.object(daily.subprocess, "Popen", return_value=adapter), mock.patch.object(daily, "wait_for_adapter"), mock.patch.object(daily, "start_tunnel", return_value=tunnel), mock.patch.object(daily.subprocess, "run", side_effect=subprocess.TimeoutExpired("ssh", 5400)), mock.patch.object(daily, "stop_process") as stop:
            with self.assertRaises(subprocess.TimeoutExpired):
                daily.run("collect")
        self.assertEqual(stop.call_args_list, [mock.call(tunnel), mock.call(adapter)])

    def test_adapter_cleanup_survives_tunnel_cleanup_failure(self):
        adapter, tunnel = mock.Mock(), mock.Mock()
        with self.base_mocks(), mock.patch.object(daily, "node_binary", return_value="/node"), mock.patch.object(daily, "unused_local_port", return_value=12345), mock.patch.object(daily.subprocess, "Popen", return_value=adapter), mock.patch.object(daily, "wait_for_adapter"), mock.patch.object(daily, "start_tunnel", return_value=tunnel), mock.patch.object(daily.subprocess, "run", return_value=mock.Mock(returncode=0)), mock.patch.object(daily, "stop_process", side_effect=[OSError("stop failed"), None]) as stop:
            with self.assertRaises(OSError):
                daily.run("collect")
        self.assertEqual(stop.call_args_list, [mock.call(tunnel), mock.call(adapter)])

    def test_concurrent_local_invocation_fails_before_startup(self):
        with mock.patch.object(daily.fcntl, "flock", side_effect=BlockingIOError), mock.patch.object(daily.Path, "mkdir"), mock.patch.object(daily.Path, "open", mock.mock_open()):
            with self.assertRaisesRegex(daily.TransportError, "already running"):
                with daily.operation_lock():
                    self.fail("Concurrent invocation entered the critical section")


if __name__ == "__main__":
    unittest.main()
