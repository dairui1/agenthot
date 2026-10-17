import assert from "node:assert/strict";
import { test } from "node:test";
import { checkManifest, runManifest, ReadingBatchError } from "../cli.ts";
import { readingEnvironment } from "../remote.ts";

const RELEASE = "a".repeat(40);
const TOKEN = "b".repeat(48);
const FIRST = "a".repeat(25), SECOND = "b".repeat(25), THIRD = "c".repeat(25);
const env = { AIHOT_RELEASE: RELEASE, SITE_URL: "https://agenthot.dairui1.com", AGENTHOT_DATABASE_HOST: "172.19.0.2",
  POSTGRES_PASSWORD: "fixture/password", MODEL_CALLS_ENABLED: "true", COLLECT_ENABLED: "true", AGENTLAB_SYNC_ENABLED: "true",
  CODEX_CLI_TOKEN: "stale", CODEX_CLI_BASE_URL: "https://untrusted.example/v1", UNDERSTAND_MODEL: "unexpected" };
const config = { expectedRelease: RELEASE, token: TOKEN, baseUrl: "http://127.0.0.1:14312/v1" };
const binding = (articleId = FIRST) => ({ articleId, revision: 1, analysisId: 7, materialHash: "d".repeat(64) });
const plan = (articleId = FIRST, existing = false) => ({ ...binding(articleId), planHash: "e".repeat(64), existing });
const manifest = (ids = [FIRST, SECOND]) => ({ version: 1, items: ids.map(articleId => {
  const { existing: _existing, ...item } = plan(articleId);
  return item;
}) });
const result = (articleId: string, status = "written") => ({ ...binding(articleId), status, receiptId: 1,
  generatedAt: "2026-10-17T08:00:00.000Z" });

test("reading check closes inherited valves and strips stale adapter credentials", () => {
  const checked = readingEnvironment({ expectedRelease: RELEASE }, "--check", env);
  for (const key of ["MODEL_CALLS_ENABLED", "COLLECT_ENABLED", "AGENTLAB_SYNC_ENABLED", "FEISHU_CONTENT_PUSH_ENABLED", "FEISHU_INTERNAL_ENABLED", "INDEXNOW_SUBMIT_ENABLED"]) assert.equal(checked[key], "false");
  assert.equal(checked.CODEX_CLI_TOKEN, undefined);
  assert.equal(checked.CODEX_CLI_BASE_URL, undefined);
  assert.equal(checked.UNDERSTAND_MODEL, "gpt-6.1-sol");
});

test("reading run opens only the model valve and requires the fixed authenticated loopback", () => {
  const checked = readingEnvironment(config, "--run", env);
  assert.equal(checked.MODEL_CALLS_ENABLED, "true");
  assert.equal(checked.CODEX_CLI_TOKEN, TOKEN);
  assert.equal(checked.CODEX_CLI_BASE_URL, config.baseUrl);
  assert.equal(checked.UNDERSTAND_MODEL, "gpt-6.1-sol");
  for (const key of ["COLLECT_ENABLED", "AGENTLAB_SYNC_ENABLED", "FEISHU_CONTENT_PUSH_ENABLED", "FEISHU_INTERNAL_ENABLED", "INDEXNOW_SUBMIT_ENABLED"]) assert.equal(checked[key], "false");
  for (const invalid of [{ expectedRelease: RELEASE }, { ...config, token: "short" }, { ...config, baseUrl: "https://untrusted.example/v1" }]) {
    assert.throws(() => readingEnvironment(invalid, "--run", env), /adapter/);
  }
});

test("reading cannot use a collection mode or bypass the production identity checks", () => {
  assert.throws(() => readingEnvironment(config, "--collect", env), /reading mode/);
  for (const mode of ["--check", "--run"]) {
    assert.throws(() => readingEnvironment({ ...config, expectedRelease: "f".repeat(40) }, mode, env), /release/);
    assert.throws(() => readingEnvironment(config, mode, { ...env, SITE_URL: "https://other.example" }), /site/);
    assert.throws(() => readingEnvironment(config, mode, { ...env, AGENTHOT_DATABASE_HOST: "localhost/path" }), /database/);
  }
});

test("read-only explicit IDs resolve exact reusable bindings without invoking write", async () => {
  const checked: string[] = [];
  const output = await checkManifest({ version: 1, articleIds: [FIRST, SECOND] }, "check", {
    check: async articleId => { checked.push(articleId); return plan(articleId, articleId === SECOND); },
    write: async () => { throw new Error("Writing is not permitted during check"); },
  });
  assert.deepEqual(checked, [FIRST, SECOND]);
  assert.deepEqual(output, { ...manifest(), existing: [SECOND] });
});

test("malformed, duplicate, oversized or unapproved manifests fail before state lookup", async () => {
  let calls = 0;
  const deps = { check: async () => { calls++; return plan(); }, write: async () => result(FIRST) };
  for (const value of [{ version: 1, items: [] }, manifest([FIRST, FIRST]), manifest(Array.from({ length: 13 }, (_, index) => String(index).padStart(25, "0"))),
    { version: 1, articleIds: [FIRST] }, { version: 1, items: [binding()] }, { ...manifest(), command: "collect" },
    { version: 1, items: [{ ...manifest().items[0], revision: 2.5 }] }]) {
    await assert.rejects(runManifest(value, deps));
  }
  assert.equal(calls, 0);
});

test("all article bindings are rechecked before the first paid operation", async () => {
  const checked: string[] = [], written: string[] = [];
  await assert.rejects(runManifest(manifest(), {
    check: async articleId => { checked.push(articleId); return { ...plan(articleId), revision: articleId === SECOND ? 2 : 1 }; },
    write: async value => { const item = value as ReturnType<typeof binding>; written.push(item.articleId); return result(item.articleId); },
  }), ReadingBatchError);
  assert.deepEqual(checked, [FIRST, SECOND]);
  assert.deepEqual(written, []);
});

for (const changed of ["analysisId", "materialHash", "planHash"] as const) {
  test(`changed ${changed} refuses the old approval`, async () => {
    await assert.rejects(runManifest(manifest([FIRST]), {
      check: async () => ({ ...plan(), [changed]: changed === "analysisId" ? 9 : "f".repeat(64) }),
      write: async () => { throw new Error("Must not write changed evidence"); },
    }), ReadingBatchError);
  });
}

test("the first uncertain request stops the batch, retains completed results and hides raw errors", async () => {
  const written: string[] = [];
  await assert.rejects(runManifest(manifest([FIRST, SECOND, THIRD]), {
    check: async articleId => plan(articleId),
    write: async value => {
      const item = value as ReturnType<typeof binding>;
      written.push(item.articleId);
      if (item.articleId === SECOND) throw new Error("private upstream error with credentials");
      return result(item.articleId);
    },
  }), error => {
    assert.ok(error instanceof ReadingBatchError);
    assert.equal(error.articleId, SECOND);
    assert.deepEqual(error.completed, [result(FIRST)]);
    assert.ok(!error.message.includes("credentials"));
    return true;
  });
  assert.deepEqual(written, [FIRST, SECOND]);
});

test("an existing validated reading can reuse the same bound manifest without a replacement request", async () => {
  const written: string[] = [];
  const output = await runManifest(manifest([FIRST]), {
    check: async () => ({ ...plan(FIRST, true), planHash: "f".repeat(64) }),
    write: async (value, approved) => {
      assert.equal(approved, "f".repeat(64));
      const item = value as ReturnType<typeof binding>;
      written.push(item.articleId);
      return result(item.articleId, "reused");
    },
  });
  assert.deepEqual(written, [FIRST]);
  assert.deepEqual(output, [result(FIRST, "reused")]);
});

test("pre-existing unresolved receipt failure stops all new writing during preflight", async () => {
  let writes = 0;
  await assert.rejects(runManifest(manifest(), {
    check: async articleId => { if (articleId === SECOND) throw new Error("article has an unknown receipt"); return plan(articleId); },
    write: async () => { writes++; return result(FIRST); },
  }), ReadingBatchError);
  assert.equal(writes, 0);
});
