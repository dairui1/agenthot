import assert from "node:assert/strict";
import { test } from "node:test";
import { remoteEnvironment } from "../remote-config.ts";

const expectedRelease = "a".repeat(40);
const env = {
  AIHOT_RELEASE: expectedRelease,
  SITE_URL: "https://agenthot.dairui1.com",
  AGENTHOT_DATABASE_HOST: "172.19.0.2",
  POSTGRES_PASSWORD: "a/b@c",
};
const config = { expectedRelease, token: "b".repeat(40), baseUrl: "http://127.0.0.1:14312/v1" };

test("remote daily process enables only its bounded collection and model valves", () => {
  const configured = remoteEnvironment(config, "--run", env);
  assert.equal(configured.COLLECT_ENABLED, "true");
  assert.equal(configured.MODEL_CALLS_ENABLED, "true");
  assert.equal(configured.FEISHU_CONTENT_PUSH_ENABLED, "false");
  assert.equal(configured.FEISHU_INTERNAL_ENABLED, "false");
  assert.equal(configured.INDEXNOW_SUBMIT_ENABLED, "false");
  assert.equal(configured.SCORE_MODEL, "gpt-6.1-sol");
  assert.equal(configured.DATABASE_URL, "postgres://aihot:a%2Fb%40c@172.19.0.2:5432/aihot");
  assert.equal(configured.AIHOT_DATA_DIR, "/data");
  assert.equal(configured.CODEX_CLI_TOKEN, config.token);
});

test("read-only check neither requires nor forwards adapter credentials", () => {
  const configured = remoteEnvironment({ expectedRelease }, "--check", { ...env, CODEX_CLI_TOKEN: "old" });
  assert.equal(configured.COLLECT_ENABLED, "false");
  assert.equal(configured.MODEL_CALLS_ENABLED, "false");
  assert.equal(configured.CODEX_CLI_TOKEN, undefined);
  assert.equal(configured.CODEX_CLI_BASE_URL, undefined);
});

test("remote run rejects a different release, site, malformed host or remote model endpoint", () => {
  assert.throws(() => remoteEnvironment({ ...config, expectedRelease: "c".repeat(40) }, "--run", env), /release/);
  assert.throws(() => remoteEnvironment(config, "--run", { ...env, SITE_URL: "https://example.com" }), /site/);
  assert.throws(() => remoteEnvironment(config, "--run", { ...env, AGENTHOT_DATABASE_HOST: "db/path" }), /database/);
  assert.throws(() => remoteEnvironment({ ...config, baseUrl: "https://example.com/v1" }, "--run", env), /adapter/);
  assert.throws(() => remoteEnvironment({ ...config, token: "short" }, "--run", env), /adapter/);
  assert.throws(() => remoteEnvironment(config, "--other", env), /Expected/);
});
