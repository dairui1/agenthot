import "./setup.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { z } from "zod";
import { closeDb, sql } from "@aihot/backend/db";
import { updateBudget } from "@aihot/backend/admin/settings";
import { chatJson } from "@aihot/backend/providers/llm";
import { BudgetExceededError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { autoReleaseUnknownReceipts } from "@aihot/backend/operations/recover";
import { sha256 } from "@aihot/backend/lib/ids";
import { createBridge, BridgeError } from "../modules/codex-cli/bridge.ts";

after(closeDb);
const setup = () => execFileSync(process.execPath, ["modules/codex-cli/setup.ts"], { env: process.env, encoding: "utf8" });

test("Codex setup initializes an audited budget and preserves operator changes", async () => {
  setup();
  const [first] = await sql`SELECT per_minute,per_hour,per_day FROM budgets WHERE service=${"codex-cli"}`;
  assert.deepEqual(first, { per_minute: 12, per_hour: 60, per_day: 120 });
  await updateBudget("codex-cli", { perMinute: 2, perHour: 10, perDay: 20, reason: "test operator choice" }, "test-codex");
  setup();
  const [kept] = await sql`SELECT per_minute,per_hour,per_day FROM budgets WHERE service=${"codex-cli"}`;
  assert.deepEqual(kept, { per_minute: 2, per_hour: 10, per_day: 20 });
});

test("a stopped Codex budget refuses before contacting the CLI adapter", async () => {
  await updateBudget("codex-cli", { perMinute: 0, perHour: 0, perDay: 0, reason: "test stop" }, "test-codex");
  process.env.CODEX_CLI_BASE_URL = "http://127.0.0.1:1/v1";
  process.env.CODEX_CLI_TOKEN = "local-test-only-token-0123456789";
  await assert.rejects(chatJson({ model: "gpt-6.1-sol", purpose: "test_codex", subject: "fixture", promptVersion: "test", system: "test", user: "test", schema: z.object({}) }), BudgetExceededError);
  assert.equal((await sql`SELECT id FROM receipts WHERE purpose=${"test_codex"}`).length, 0);
});

test("an interrupted CLI retains an unknown receipt instead of permitting a silent retry", async () => {
  await updateBudget("codex-cli", { perMinute: 12, perHour: 60, perDay: 120, reason: "test restore" }, "test-codex");
  const token = "local-test-only-token-0123456789-abcdef";
  const journalDir = await mkdtemp(path.join(tmpdir(), "agenthot-budget-journal-"));
  let calls = 0;
  const bridge = createBridge(token, async () => { calls++; throw new BridgeError("Timed out", 504); }, { journalDir });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  process.env.CODEX_CLI_BASE_URL = `http://127.0.0.1:${(bridge.address() as { port: number }).port}/v1`;
  process.env.CODEX_CLI_TOKEN = token;
  try {
    const request = { model: "gpt-6.1-sol", purpose: "test_codex_timeout", subject: "fixture", promptVersion: "test", system: "test", user: "test", schema: z.object({}) };
    await assert.rejects(chatJson(request), ReceiptUnknownError);
    const [receipt] = await sql`SELECT id,status FROM receipts WHERE purpose=${"test_codex_timeout"}`;
    assert.equal(receipt!.status, "unknown");
    await sql`UPDATE receipts SET updated_at=now()-interval '31 minutes' WHERE id=${receipt!.id}`;
    await autoReleaseUnknownReceipts();
    assert.equal((await sql`SELECT status FROM receipts WHERE id=${receipt!.id}`)[0]!.status, "unknown");
    await assert.rejects(chatJson(request), ReceiptUnknownError);
    assert.equal(calls, 1, "unknown Codex requests never auto-release or resend");
  } finally { await bridge.shutdown(); await rm(journalDir, { recursive: true, force: true }); }
});

test("Codex transport binds the unchanged logical key and body without collapsing two scoring attempts", async () => {
  const journalDir = await mkdtemp(path.join(tmpdir(), "agenthot-budget-journal-"));
  const token = "local-test-only-token-0123456789-abcdef";
  let calls = 0;
  const bridge = createBridge(token, async () => { calls++; return { content: '{"ok":true}', usage: null }; }, { journalDir });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  process.env.CODEX_CLI_BASE_URL = `http://127.0.0.1:${(bridge.address() as { port: number }).port}/v1`;
  process.env.CODEX_CLI_TOKEN = token;
  const request = { model: "gpt-6.1-sol", purpose: "test_codex_identity", subject: "fixture", promptVersion: "test", system: "private-system-fixture", user: "private-user-fixture", schema: z.object({ ok: z.boolean() }) };
  try {
    const first = await chatJson({ ...request, attemptTag: "score-1" });
    const second = await chatJson({ ...request, attemptTag: "score-2" });
    assert.equal(calls, 2);
    assert.notEqual(first.receiptId, second.receiptId);
    assert.equal((await chatJson({ ...request, attemptTag: "score-1" })).reused, true);
    assert.equal(calls, 2);
    const rows = await sql`SELECT logical_key, request AS request_summary FROM receipts WHERE purpose=${request.purpose} ORDER BY id`;
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0]!.request_summary.transportRequestKey, rows[1]!.request_summary.transportRequestKey);
    assert.equal(rows[0]!.request_summary.transportBodyHash, rows[1]!.request_summary.transportBodyHash);
    for (const row of rows) {
      assert.equal(row.request_summary.transportRequestKey, sha256(row.logical_key));
      assert.ok(!JSON.stringify(row.request_summary).includes(request.user));
      const entry = JSON.parse(await readFile(path.join(journalDir, `${row.request_summary.transportRequestKey}.json`), "utf8"));
      assert.equal(entry.state, "completed");
      assert.equal(entry.bodyHash, row.request_summary.transportBodyHash);
      assert.equal(entry.response.id, `codex-${row.request_summary.transportRequestKey}`);
    }
    assert.equal((await readdir(journalDir)).length, 2);
  } finally { await bridge.shutdown(); await rm(journalDir, { recursive: true, force: true }); }
});
