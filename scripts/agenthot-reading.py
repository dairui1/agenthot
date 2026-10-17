#!/usr/bin/env python3
"""Check or enrich at most twelve explicitly selected article readings."""

import argparse
import importlib.util
import json
from pathlib import Path
import re
import signal
import subprocess
import sys
import time


SPEC = importlib.util.spec_from_file_location("agenthot_daily_transport", Path(__file__).with_name("agenthot-daily.py"))
daily = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(daily)
MAX_BYTES = 32768
MAX_SECONDS = 45 * 60
ID = re.compile(r"[a-z0-9]{20,32}\Z")
HASH = re.compile(r"[a-f0-9]{64}\Z")


def validate_manifest(value, mode):
    if mode not in {"check", "run"} or not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1:
        raise daily.TransportError("Invalid reading manifest")
    if set(value) == {"version", "articleIds"} and mode == "check":
        ids = value["articleIds"]
    elif set(value) == {"version", "items"} and isinstance(value["items"], list):
        ids = []
        for item in value["items"]:
            required = {"articleId", "revision", "analysisId", "materialHash"}
            if not isinstance(item, dict) or not required.issubset(item) or set(item) - required - {"planHash"}:
                raise daily.TransportError("Invalid reading binding")
            if any(type(item[key]) is not int or item[key] < 1 for key in ["revision", "analysisId"]):
                raise daily.TransportError("Invalid reading revision or analysis identity")
            if not isinstance(item["materialHash"], str) or not HASH.fullmatch(item["materialHash"]):
                raise daily.TransportError("Invalid reading material hash")
            if mode == "run" or "planHash" in item:
                if not isinstance(item.get("planHash"), str) or not HASH.fullmatch(item["planHash"]):
                    raise daily.TransportError("Run requires each approved reading plan hash")
            ids.append(item["articleId"])
    else:
        raise daily.TransportError("Run requires exact checked article bindings")
    if not isinstance(ids, list) or not 1 <= len(ids) <= 12 or any(not isinstance(value, str) or not ID.fullmatch(value) for value in ids) or len(set(ids)) != len(ids):
        raise daily.TransportError("Reading manifest requires one to twelve distinct article IDs")
    return value


def run(mode, manifest):
    manifest = validate_manifest(manifest, mode)
    deadline = time.monotonic() + (60 if mode == "check" else MAX_SECONDS)
    adapter = None
    with daily.operation_lock():
        release = daily.local_release()
        payload = {"expectedRelease": release, "manifest": manifest}
        try:
            if mode == "run":
                daily.remaining(deadline)
                token = daily.secrets.token_urlsafe(48)
                port = daily.unused_local_port()
                adapter = subprocess.Popen(
                    [daily.node_binary(), str(daily.ROOT / "modules/codex-cli/server.ts")], cwd=daily.ROOT,
                    env=daily.adapter_environment(token, port), stdin=subprocess.DEVNULL,
                    stdout=sys.stderr, start_new_session=True,
                )
                daily.wait_for_adapter(adapter, token, port, deadline)
                payload.update(token=token, baseUrl=f"http://127.0.0.1:{daily.REMOTE_PORT}/v1")
            return daily.run_remote(mode, release, payload, deadline, adapter=adapter,
                                    port=port if adapter is not None else None, entrypoint="reading")
        finally:
            daily.stop_process(adapter)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--check", metavar="MANIFEST", help="Resolve or verify explicit article bindings without model calls")
    modes.add_argument("--run", metavar="MANIFEST", help="Write only the checked bindings; stop at the first failure")
    args = parser.parse_args(argv)

    def interrupted(_signum, _frame):
        raise KeyboardInterrupt

    previous = signal.signal(signal.SIGTERM, interrupted)
    try:
        path = Path(args.check or args.run)
        with path.open("rb") as handle:
            data = handle.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise daily.TransportError("Reading manifest exceeds its size limit")
        return run("check" if args.check else "run", json.loads(data))
    except (daily.TransportError, ValueError, OSError, subprocess.SubprocessError, KeyboardInterrupt):
        print(json.dumps({"ok": False, "stage": "transport", "error": "Reading operation stopped; inspect its receipts before any retry"}), file=sys.stderr)
        return 1
    finally:
        signal.signal(signal.SIGTERM, previous)


if __name__ == "__main__":
    sys.exit(main())
