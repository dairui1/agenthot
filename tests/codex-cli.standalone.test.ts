import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createBridge, codexArgs, parseCompletion, runCompletion, BridgeError } from "../modules/codex-cli/bridge.ts";
import { digest } from "../modules/codex-cli/journal.ts";

const token = "local-adapter-test-token-0123456789";
let calls = 0;
const journalDir = await mkdtemp(path.join(tmpdir(), "agenthot-cli-test-journal-"));
const server = createBridge(token, async (input) => {
  calls += 1;
  return { content: input.json ? '{"attentionScore":75}' : "译文", usage: { input_tokens: 12, output_tokens: 8 } };
}, { journalDir });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/v1/chat/completions`;
after(async () => { await server.shutdown(); await rm(journalDir, { recursive: true, force: true }); });
const request = (body: unknown, key = token) => fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-agenthot-request-key": digest(randomUUID()), "x-agenthot-body-sha256": digest(JSON.stringify(body)) }, body: JSON.stringify(body) });
const base = { model: "gpt-6.1-sol", messages: [{ role: "user", content: "请评分" }] };

test("Codex runs isolated and has no shell, plugins, browser or inherited config", () => {
  const args = codexArgs("/tmp/isolated");
  for (const flag of ["--ephemeral", "--ignore-user-config", "--ignore-rules", "read-only", "never", "shell_tool", "unified_exec", "plugins", "browser_use", "computer_use"]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("--model") + 1], "gpt-6.1-sol");
  assert.ok(args.includes('shell_environment_policy.inherit="none"'));
});

test("the adapter never silently drops images or enables tool calls", () => {
  assert.throws(() => parseCompletion({ ...base, tools: [] }), BridgeError);
  assert.throws(() => parseCompletion({ ...base, stream: true }), BridgeError);
  assert.throws(() => parseCompletion({ ...base, model: "other" }), BridgeError);
  assert.throws(() => parseCompletion({ ...base, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }] }), BridgeError);
  assert.equal(parseCompletion({ ...base, messages: [{ role: "user", content: [{ type: "text", text: "材料" }] }] }).messages[0]!.content, "材料");
});

test("authentication and input validation reject before running Codex", async () => {
  const before = calls;
  assert.equal((await request(base, "wrong")).status, 401);
  assert.equal((await request({ ...base, model: "other" })).status, 400);
  assert.equal(calls, before);
});

test("OpenAI-compatible responses carry real usage and explicit CLI parameter limits", async () => {
  const res = await request({ ...base, response_format: { type: "json_object" }, temperature: 0.2, max_tokens: 1000 });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(JSON.parse(data.choices[0].message.content), { attentionScore: 75 });
  assert.equal(data.usage.total_tokens, 20);
  assert.equal(data._codex.temperatureApplied, false);
  assert.equal(data._codex.maxTokensApplied, false);
  const text = await (await request(base)).json();
  assert.equal(text.choices[0].message.content, "译文");
});

async function withFakeCli(source: string, fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "agenthot-fake-cli-"));
  const file = path.join(dir, "codex");
  const previous = process.env.CODEX_BIN;
  try {
    await writeFile(file, `#!${process.execPath}\n${source}`, { mode: 0o700 });
    process.env.CODEX_BIN = file;
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test("the CLI runner reads the schema wrapper and actual token usage", async () => {
  await withFakeCli(`const fs=require('node:fs');const i=process.argv.indexOf('--output-last-message');fs.writeFileSync(process.argv[i+1],JSON.stringify({content:'{"ok":true}'}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));`, async () => {
    const result = await runCompletion(parseCompletion({ ...base, response_format: { type: "json_object" } }), AbortSignal.timeout(3000));
    assert.equal(result.content, '{"ok":true}');
    assert.equal(result.usage?.output_tokens, 2);
  });
});

test("a timeout stops the CLI instead of leaving an orphaned request", async () => {
  await withFakeCli("setInterval(()=>{},1000);", async () => {
    await assert.rejects(runCompletion(parseCompletion(base), AbortSignal.timeout(80)), (error: unknown) => error instanceof BridgeError && error.status === 504);
  });
});

test("adapter shutdown terminates a real in-flight fake CLI before resolving", async () => {
  await withFakeCli("const fs=require('node:fs'),path=require('node:path');fs.writeFileSync(path.join(path.dirname(process.argv[1]),'pid'),String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);", async (dir) => {
    const instance = createBridge(token, runCompletion, { journalDir: path.join(dir, "journal") });
    await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(instance.address() as { port: number }).port}/v1/chat/completions`;
    const pending = fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-agenthot-request-key": digest("shutdown-fixture"), "x-agenthot-body-sha256": digest(JSON.stringify(base)) }, body: JSON.stringify(base) }).catch(() => null);
    try {
      let pid: number | undefined;
      for (let i = 0; i < 100 && !pid; i++) {
        try { pid = Number(await readFile(path.join(dir, "pid"), "utf8")); } catch { await delay(20); }
      }
      assert.ok(pid, "fake CLI started");
      await instance.shutdown();
      await pending;
      assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
    } finally { await instance.shutdown(); await pending; }
  });
});

test("tool activity is refused even when a CLI returns an apparently valid answer", async () => {
  await withFakeCli(`const fs=require('node:fs');const i=process.argv.indexOf('--output-last-message');fs.writeFileSync(process.argv[i+1],JSON.stringify({content:'answer'}));console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution'}}));`, async () => {
    await assert.rejects(runCompletion(parseCompletion(base), AbortSignal.timeout(3000)), /Unexpected tool activity/);
  });
});
