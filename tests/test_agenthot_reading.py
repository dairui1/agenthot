"""Offline reading transport tests; no production or model requests."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import time
import unittest
from unittest import mock

import test_agenthot_daily as transport


SPEC = importlib.util.spec_from_file_location("agenthot_reading", Path(__file__).resolve().parents[1] / "scripts/agenthot-reading.py")
reading = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reading)
daily = reading.daily
RELEASE = "a" * 40
TOKEN = "temporary-adapter-token-not-for-command-lines"
ITEM = {"articleId": "a" * 25, "revision": 1, "analysisId": 7, "materialHash": "b" * 64, "planHash": "c" * 64}
MANIFEST = {"version": 1, "items": [ITEM]}


class ReadingTransportTests(unittest.TestCase):
    def test_reading_uses_only_enumerated_entrypoint_and_keeps_all_transport_guards(self):
        for mode in ["check", "run"]:
            command = daily.remote_command(mode, RELEASE, 1800, entrypoint="reading")
            self.assertIn(f"node modules/reading/remote.ts --{mode}", command)
            self.assertNotIn("modules/daily-publish/remote.ts", command)
            self.assertEqual("ss -H -ltn" in command, mode == "run")
            for proof in ["--name agenthot-daily-publish", "--read-only", "--cap-drop ALL", "--cidfile", 'docker rm -f "$cid"',
                          "api_image=", "publisher_image=", "api_release=", "git rev-parse HEAD", "fresh_after=", "container_seconds=$((deadline -"]:
                self.assertIn(proof, command)
            parsed = subprocess.run(["bash", "-n"], input=command, text=True, capture_output=True)
            self.assertEqual(parsed.returncode, 0, parsed.stderr)
        for entrypoint, mode in [("shell; echo unsafe", "run"), ("reading", "collect"), ("daily", "run"), ("reading", "publish")]:
            with self.subTest(entrypoint=entrypoint, mode=mode), mock.patch.object(daily.subprocess, "Popen") as popen:
                with self.assertRaises(daily.TransportError):
                    daily.run_remote(mode, RELEASE, {}, time.monotonic() + 60, entrypoint=entrypoint)
                popen.assert_not_called()

    def test_check_resolves_explicit_ids_without_adapter_or_token(self):
        selection = {"version": 1, "articleIds": [ITEM["articleId"]]}
        with mock.patch.object(daily, "operation_lock", contextlib.nullcontext), mock.patch.object(daily, "local_release", return_value=RELEASE), \
                mock.patch.object(daily.subprocess, "Popen") as popen, mock.patch.object(daily.secrets, "token_urlsafe") as token, \
                mock.patch.object(daily, "run_remote", return_value=0) as remote, mock.patch.object(reading.time, "monotonic", return_value=100):
            self.assertEqual(reading.run("check", selection), 0)
        popen.assert_not_called()
        token.assert_not_called()
        self.assertEqual(remote.call_args.args, ("check", RELEASE, {"expectedRelease": RELEASE, "manifest": selection}, 160))
        self.assertEqual(remote.call_args.kwargs, {"adapter": None, "port": None, "entrypoint": "reading"})

    def test_run_is_bounded_and_cleans_adapter_on_every_exit(self):
        for outcome in [0, daily.TransportError("fixture failure"), KeyboardInterrupt()]:
            adapter = mock.Mock()
            with self.subTest(outcome=type(outcome)), mock.patch.object(daily, "operation_lock", contextlib.nullcontext), \
                    mock.patch.object(daily, "local_release", return_value=RELEASE), mock.patch.object(reading.time, "monotonic", return_value=100), \
                    mock.patch.object(daily, "node_binary", return_value="/node"), mock.patch.object(daily, "unused_local_port", return_value=12345), \
                    mock.patch.object(daily.secrets, "token_urlsafe", return_value=TOKEN), mock.patch.object(daily.subprocess, "Popen", return_value=adapter) as popen, \
                    mock.patch.object(daily, "wait_for_adapter"), mock.patch.object(daily, "stop_process") as stop, mock.patch.object(daily, "run_remote") as remote:
                if isinstance(outcome, int):
                    remote.return_value = outcome
                    self.assertEqual(reading.run("run", MANIFEST), 0)
                else:
                    remote.side_effect = outcome
                    with self.assertRaises(type(outcome)):
                        reading.run("run", MANIFEST)
                self.assertEqual(remote.call_args.args[0], "run")
                self.assertEqual(remote.call_args.args[-1], 100 + reading.MAX_SECONDS)
                self.assertEqual(remote.call_args.args[2]["manifest"], MANIFEST)
                self.assertEqual(remote.call_args.args[2]["token"], TOKEN)
                self.assertEqual(remote.call_args.kwargs["entrypoint"], "reading")
                self.assertNotIn(TOKEN, " ".join(popen.call_args.args[0]))
                stop.assert_called_once_with(adapter)

    def test_malformed_duplicate_unbounded_or_unapproved_run_starts_nothing(self):
        for manifest in [{"version": 1, "articleIds": ["fixture-article"]}, {"version": 1, "items": []},
                         {"version": 1, "items": [ITEM, ITEM]}, {"version": 1, "items": [{**ITEM, "revision": True}]},
                         {"version": 1, "items": [{**ITEM, "planHash": "wrong"}]},
                         {"version": 1, "items": [{**ITEM, "articleId": str(i)} for i in range(13)]}]:
            with self.subTest(manifest=manifest), mock.patch.object(daily, "operation_lock") as lock, mock.patch.object(daily.subprocess, "Popen") as popen:
                with self.assertRaises(daily.TransportError):
                    reading.run("run", manifest)
                lock.assert_not_called()
                popen.assert_not_called()

    def test_cli_errors_are_sanitized_and_restore_signal_handler(self):
        with mock.patch.object(reading.Path, "open", mock.mock_open(read_data=b"{private malformed input")), \
                mock.patch.object(reading.signal, "signal", return_value="previous") as handler, contextlib.redirect_stderr(io.StringIO()) as output:
            self.assertEqual(reading.main(["--check", "selection.json"]), 1)
        self.assertNotIn("private", output.getvalue())
        self.assertEqual(json.loads(output.getvalue())["stage"], "transport")
        self.assertEqual(handler.call_args.args[-1], "previous")


class ReadingLeaseTests(unittest.TestCase):
    setUp = transport.RemoteLeaseTests.setUp
    tearDown = transport.RemoteLeaseTests.tearDown
    start = transport.RemoteLeaseTests.start
    stop_heartbeat = transport.RemoteLeaseTests.stop_heartbeat
    wait_started = transport.RemoteLeaseTests.wait_started
    assert_cleaned = transport.RemoteLeaseTests.assert_cleaned

    def script(self):
        return daily.remote_command("run", RELEASE, 60, entrypoint="reading").replace("cd /opt/agenthot", "cd " + daily.shlex.quote(str(self.root)))

    def test_reading_stdin_eof_stops_activity_and_only_its_cid(self):
        process = self.start()
        self.wait_started()
        self.stop_heartbeat(process)
        process.stdin.close()
        self.assertEqual(process.wait(timeout=3), 1)
        self.assert_cleaned()

    def test_reading_expired_lease_stops_activity_without_client_exit(self):
        with mock.patch.object(daily, "LEASE_SECONDS", 1):
            process = self.start()
        self.wait_started()
        self.stop_heartbeat(process)
        self.assertEqual(process.wait(timeout=4), 1)
        self.assert_cleaned()


if __name__ == "__main__":
    unittest.main()
