import "./setup.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, test } from "node:test";
import { z } from "zod";
import { closeDb, sql } from "@aihot/backend/db";
import { updateBudget } from "@aihot/backend/admin/settings";
import { chatJson } from "@aihot/backend/providers/llm";
import { BudgetExceededError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
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
  const bridge = createBridge(token, async () => { throw new BridgeError("Timed out", 504); });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  process.env.CODEX_CLI_BASE_URL = `http://127.0.0.1:${(bridge.address() as { port: number }).port}/v1`;
  process.env.CODEX_CLI_TOKEN = token;
  try {
    await assert.rejects(chatJson({ model: "gpt-6.1-sol", purpose: "test_codex_timeout", subject: "fixture", promptVersion: "test", system: "test", user: "test", schema: z.object({}) }), ReceiptUnknownError);
    const [receipt] = await sql`SELECT status FROM receipts WHERE purpose=${"test_codex_timeout"}`;
    assert.equal(receipt!.status, "unknown");
  } finally { await new Promise<void>((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve())); }
});
