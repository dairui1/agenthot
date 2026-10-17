import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const privateMarker = "private-envelope-fixture-never-print";
const release = "a".repeat(40);
const run = (input: string) => spawnSync(process.execPath, ["modules/daily-publish/manual-late-remote.ts"], {
  input, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, AIHOT_RELEASE: release }, timeout: 5000,
});
for (const [name, input] of [
  ["malformed input", `${privateMarker}{`],
  ["oversized input", privateMarker.repeat(3000)],
  ["unapproved envelope fields", JSON.stringify({ expectedRelease: release, manifest: { expectedRelease: release }, token: privateMarker })],
  ["release mismatch", JSON.stringify({ expectedRelease: "b".repeat(40), manifest: { expectedRelease: "b".repeat(40), reason: privateMarker } })],
  ["invalid approval", JSON.stringify({ expectedRelease: release, manifest: { expectedRelease: release }, approve: { privateMarker } })],
]) test(`manual remote refuses ${name} before connecting to a database or model`, () => {
  const result = run(input!);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.ok(!result.stderr.includes(privateMarker));
  assert.equal(JSON.parse(result.stderr).status, "refused");
});
