import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBridge, BridgeError, type Completion } from "../modules/codex-cli/bridge.ts";
import { CompletionJournal, digest, JournalBlocked } from "../modules/codex-cli/journal.ts";

const token = "journal-local-test-token-0123456789";
const body = { model: "gpt-6.1-sol", messages: [{ role: "user", content: "private-prompt-fixture" }] };
const bodyHash = digest(JSON.stringify(body));
const key = digest("logical-receipt-fixture");
const response = { id: `codex-${key}`, choices: [{ message: { content: "fixture answer" } }] };
const temporary = () => mkdtemp(path.join(tmpdir(), "agenthot-journal-test-"));
type Runner = (input: Completion, signal: AbortSignal) => Promise<{ content: string; usage: Record<string, unknown> | null }>;
async function bridge(directory: string, run: Runner) {
  const server = createBridge(token, run, { journalDir: directory });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat/completions`;
  return { server, request: (requestKey = key, value = body, hash = digest(JSON.stringify(value))) => fetch(url, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-agenthot-request-key": requestKey, "x-agenthot-body-sha256": hash }, body: JSON.stringify(value),
  }) };
}

test("journal reservations survive restarts, stay private and never contain prompts or credentials", async () => {
  const dir = await temporary();
  try {
    const journal = new CompletionJournal(dir);
    const reserved = await journal.reserve(key, bodyHash);
    assert.ok("reservation" in reserved);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(dir, `${key}.json`))).mode & 0o777, 0o600);
    const stored = await readFile(path.join(dir, `${key}.json`), "utf8");
    assert.ok(!stored.includes(body.messages[0]!.content) && !stored.includes(token));
    await assert.rejects(new CompletionJournal(dir).reserve(key, bodyHash), JournalBlocked);
    await journal.unknown(reserved.reservation);
    await assert.rejects(new CompletionJournal(dir).reserve(key, bodyHash), JournalBlocked);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("every concurrent reservation waits for the entire directory chain, including precreated parents", async (t) => {
  const dir = await temporary();
  const parent = path.join(dir, ".data");
  const journalDir = path.join(parent, "receipts");
  await mkdir(parent);
  const parentStat = await stat(parent);
  const identity = (value: { dev: number; ino: number }) => `${value.dev}:${value.ino}`;
  const parentIdentity = identity(parentStat);
  const seen = new Map<string, number>();
  const handle = await open(parent, "r");
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  const originalSync = prototype.sync;
  await handle.close();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let bothWaiting!: () => void;
  const waiting = new Promise<void>((resolve) => { bothWaiting = resolve; });
  const mock = t.mock.method(prototype, "sync", async function (this: FileHandle) {
    const current = await this.stat();
    const id = identity(current);
    if (current.isDirectory()) seen.set(id, (seen.get(id) ?? 0) + 1);
    if (id === parentIdentity) {
      if (seen.get(id) === 2) bothWaiting();
      await gate;
    }
    return originalSync.call(this);
  });
  const first = new CompletionJournal(journalDir).reserve(digest("first"), bodyHash);
  const second = new CompletionJournal(journalDir).reserve(digest("second"), bodyHash);
  try {
    await Promise.race([waiting, delay(2000).then(() => { throw new Error("Both reservations must wait for parent fsync"); })]);
    assert.deepEqual(await readdir(journalDir), [], "no reservation, hence no spawn, before durable parents");
    release();
    await Promise.all([first, second]);
    for (let directory = path.resolve(journalDir); ; directory = path.dirname(directory)) {
      assert.ok((seen.get(identity(await stat(directory))) ?? 0) >= 2, `both reservations synced ${directory}`);
      if (directory === path.dirname(directory)) break;
    }
  } finally {
    release();
    await Promise.allSettled([first, second]);
    mock.mock.restore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("only a fully persisted, hash-verified completion can replay without a CLI", async () => {
  const dir = await temporary();
  try {
    const journal = new CompletionJournal(dir);
    const reserved = await journal.reserve(key, bodyHash);
    assert.ok("reservation" in reserved);
    await journal.complete(reserved.reservation, response);
    await journal.unknown(reserved.reservation);
    assert.deepEqual(await new CompletionJournal(dir).reserve(key, bodyHash), { response });
    await assert.rejects(journal.reserve(key, digest("different body")), JournalBlocked);
    const file = path.join(dir, `${key}.json`);
    const saved = JSON.parse(await readFile(file, "utf8"));
    saved.response.id = "tampered";
    await writeFile(file, JSON.stringify(saved));
    await assert.rejects(journal.reserve(key, bodyHash), JournalBlocked);
    await writeFile(file, "{partial");
    await assert.rejects(journal.reserve(key, bodyHash));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("completed HTTP responses replay identically after adapter restart; distinct attempts remain independent", async () => {
  const dir = await temporary();
  let calls = 0;
  const run: Runner = async () => ({ content: `answer-${++calls}`, usage: { input_tokens: 1, output_tokens: 2 } });
  const first = await bridge(dir, run);
  try {
    const answer = await (await first.request()).json();
    assert.deepEqual(await (await first.request()).json(), answer);
    assert.equal(calls, 1);
    await first.server.shutdown();
    const second = await bridge(dir, run);
    try {
      assert.deepEqual(await (await second.request()).json(), answer);
      assert.equal(calls, 1);
      assert.equal((await second.request(digest("score-2"))).status, 200);
      assert.equal(calls, 2, "identical body does not merge two scoring attempts");
    } finally { await second.server.shutdown(); }
  } finally { await first.server.shutdown(); await rm(dir, { recursive: true, force: true }); }
});

test("concurrent requests cannot start the same reservation twice", async () => {
  const dir = await temporary();
  let calls = 0;
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const finish = new Promise<void>((resolve) => { release = resolve; });
  const instance = await bridge(dir, async () => { calls++; started(); await finish; return { content: "done", usage: null }; });
  try {
    const first = instance.request();
    await running;
    await assert.rejects(instance.request());
    assert.equal(calls, 1);
    release();
    assert.equal((await first).status, 200);
    assert.equal((await instance.request()).status, 200);
    assert.equal(calls, 1);
  } finally { release(); await instance.server.shutdown(); await rm(dir, { recursive: true, force: true }); }
});

test("unknown outcomes, changed bodies and invalid digests never become safe HTTP rejections", async () => {
  const dir = await temporary();
  let calls = 0;
  const instance = await bridge(dir, async () => { calls++; throw new BridgeError("fixture timeout", 504); });
  try {
    await assert.rejects(instance.request());
    await assert.rejects(instance.request());
    await assert.rejects(instance.request(key, { ...body, messages: [{ role: "user", content: "changed" }] }));
    await assert.rejects(instance.request(digest("new-key"), body, digest("wrong")));
    assert.equal(calls, 1);
    assert.equal((await readdir(dir)).length, 1);
    const stored = JSON.parse(await readFile(path.join(dir, `${key}.json`), "utf8"));
    assert.equal(stored.state, "unknown");
  } finally { await instance.server.shutdown(); await rm(dir, { recursive: true, force: true }); }
});

test("shutdown aborts in-flight runners and waits for cleanup instead of leaving orphaned work", async () => {
  const dir = await temporary();
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  let cleaned = false;
  const instance = await bridge(dir, async (_input, signal) => {
    started();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => setTimeout(resolve, 20), { once: true }));
    cleaned = true;
    throw new BridgeError("interrupted", 504);
  });
  try {
    const request = instance.request().catch(() => null);
    await running;
    await instance.server.shutdown();
    assert.equal(cleaned, true);
    await request;
    assert.equal(JSON.parse(await readFile(path.join(dir, `${key}.json`), "utf8")).state, "unknown");
  } finally { await instance.server.shutdown(); await rm(dir, { recursive: true, force: true }); }
});
