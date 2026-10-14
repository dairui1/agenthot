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


class TransportTests(unittest.TestCase):
    def test_remote_command_is_hardened_and_only_cleans_created_id(self):
        command = daily.remote_command("run", RELEASE, 5400)
        for flag in ["--read-only", "--cap-drop ALL", "--security-opt no-new-privileges", "--pids-limit 256", "--memory 768m", "--network host", "--tmpfs /tmp", "--cidfile", "--name agenthot-daily-publish"]:
            self.assertIn(flag, command)
        self.assertIn('test -s "$cidfile"', command)
        self.assertIn('docker rm -f "$cid"', command)
        self.assertNotIn("docker rm -f agenthot-daily-publish", command)
        self.assertIn("agenthot-api-1", command)
        self.assertIn("git rev-parse HEAD", command)
        self.assertIn("--signal=TERM --kill-after=10s 5380s", command)
        self.assertIn("modules/daily-publish/remote.ts --run", command)
        self.assertNotIn(".codex", command)

    def test_ssh_requires_known_host_without_agent_or_multiplexing(self):
        command = daily.ssh_command("true")
        self.assertIn("StrictHostKeyChecking=yes", command)
        self.assertIn("BatchMode=yes", command)
        self.assertIn("ForwardAgent=no", command)
        self.assertIn("ControlPath=none", command)
        self.assertEqual(command[-2:], ["hostinger-dokploy", "true"])

    def test_remote_shell_is_valid_without_executing_it(self):
        result = subprocess.run(["sh", "-n"], input=daily.remote_command("check", RELEASE, 60), text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)

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

    def test_run_only_sends_token_in_environment_and_stdin_and_cleans_up(self):
        adapter, tunnel = mock.Mock(), mock.Mock()
        with self.base_mocks(), mock.patch.object(daily, "node_binary", return_value="/node"), mock.patch.object(daily, "unused_local_port", return_value=12345), mock.patch.object(daily.secrets, "token_urlsafe", return_value="temporary-secret"), mock.patch.object(daily.subprocess, "Popen", return_value=adapter) as popen, mock.patch.object(daily, "wait_for_adapter"), mock.patch.object(daily, "start_tunnel", return_value=tunnel), mock.patch.object(daily.subprocess, "run", return_value=mock.Mock(returncode=7)) as run, mock.patch.object(daily, "stop_process") as stop:
            self.assertEqual(daily.run("run"), 7)
        self.assertNotIn("temporary-secret", " ".join(popen.call_args.args[0]))
        self.assertEqual(popen.call_args.kwargs["env"]["CODEX_CLI_TOKEN"], "temporary-secret")
        self.assertNotIn("temporary-secret", " ".join(run.call_args.args[0]))
        self.assertEqual(json.loads(run.call_args.kwargs["input"]), {"token": "temporary-secret", "baseUrl": "http://127.0.0.1:14312/v1", "expectedRelease": RELEASE})
        self.assertLessEqual(run.call_args.kwargs["timeout"], daily.MAX_SECONDS)
        self.assertEqual(stop.call_args_list, [mock.call(tunnel), mock.call(adapter)])

    def test_adapter_is_stopped_when_tunnel_start_fails(self):
        adapter = mock.Mock()
        with self.base_mocks(), mock.patch.object(daily, "node_binary", return_value="/node"), mock.patch.object(daily, "unused_local_port", return_value=12345), mock.patch.object(daily.subprocess, "Popen", return_value=adapter), mock.patch.object(daily, "wait_for_adapter"), mock.patch.object(daily, "start_tunnel", side_effect=daily.TransportError("failed")), mock.patch.object(daily, "stop_process") as stop:
            with self.assertRaises(daily.TransportError):
                daily.run("run")
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
                daily.run("run")
        self.assertEqual(stop.call_args_list, [mock.call(tunnel), mock.call(adapter)])

    def test_adapter_cleanup_survives_tunnel_cleanup_failure(self):
        adapter, tunnel = mock.Mock(), mock.Mock()
        with self.base_mocks(), mock.patch.object(daily, "node_binary", return_value="/node"), mock.patch.object(daily, "unused_local_port", return_value=12345), mock.patch.object(daily.subprocess, "Popen", return_value=adapter), mock.patch.object(daily, "wait_for_adapter"), mock.patch.object(daily, "start_tunnel", return_value=tunnel), mock.patch.object(daily.subprocess, "run", return_value=mock.Mock(returncode=0)), mock.patch.object(daily, "stop_process", side_effect=[OSError("stop failed"), None]) as stop:
            with self.assertRaises(OSError):
                daily.run("run")
        self.assertEqual(stop.call_args_list, [mock.call(tunnel), mock.call(adapter)])

    def test_concurrent_local_invocation_fails_before_startup(self):
        with mock.patch.object(daily.fcntl, "flock", side_effect=BlockingIOError), mock.patch.object(daily.Path, "mkdir"), mock.patch.object(daily.Path, "open", mock.mock_open()):
            with self.assertRaisesRegex(daily.TransportError, "already running"):
                with daily.operation_lock():
                    self.fail("Concurrent invocation entered the critical section")


if __name__ == "__main__":
    unittest.main()
