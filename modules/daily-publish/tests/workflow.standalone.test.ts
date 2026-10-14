import assert from "node:assert/strict";
import { test } from "node:test";
import { check, pendingSummary, REQUIRED_MODELS, RUN_LIMIT, runDaily, type Dependencies, type PendingArticle, type Snapshot } from "../workflow.ts";

const NOW = "2026-10-14T01:00:00.000Z";
const article = (id: string, overrides: Partial<PendingArticle> = {}): PendingArticle => ({ id, sourceId: "rss-approved", processingState: "new",
  groupingStatus: "pending", bodyStatus: "ok", backfill: false, retryAt: null, discoveredAt: NOW, blockedReceipt: false, attemptTag: null, ...overrides });

function fixture(items: PendingArticle[] = []) {
  const state: Snapshot = { at: NOW, allowlist: ["rss-approved"], sources: [
    { id: "rss-approved", kind: "rss", participationMode: "editorial", enabled: true, health: "ok", lastOkAt: NOW },
    { id: "agentlab", kind: "external", participationMode: "editorial", enabled: true, health: "ok", lastOkAt: NOW },
    { id: "rss-unapproved", kind: "rss", participationMode: "editorial", enabled: true, health: "ok", lastOkAt: NOW },
  ], budget: { perMinute: 12, perHour: 60, perDay: 120 }, valves: { COLLECT_ENABLED: "true", MODEL_CALLS_ENABLED: "true",
    FEISHU_CONTENT_PUSH_ENABLED: "false", FEISHU_INTERNAL_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false" },
  models: Object.fromEntries(REQUIRED_MODELS.map(step => [step, "gpt-6.1-sol"])), adapterConfigured: true, otherPaidProviders: false,
  pending: items, due: { key: "2026-10-14", exists: false, entries: null } };
  const calls: string[] = [];
  const deps: Dependencies = {
    snapshot: async () => structuredClone({ ...state, pending: state.pending.filter(item => ["new", "failed"].includes(item.processingState)
      || item.processingState === "analyzed" && item.groupingStatus !== "complete") }),
    collect: async sourceId => { calls.push(`collect:${sourceId}`); return { sourceId, status: "ok", found: 0, created: 0, revised: 0 }; },
    extract: async id => { calls.push(`extract:${id}`); state.pending.find(item => item.id === id)!.bodyStatus = "ok"; return "ok"; },
    process: async (id, attemptTag) => {
      calls.push(`process:${id}${attemptTag ? `:${attemptTag}` : ""}`);
      state.pending.find(item => item.id === id)!.processingState = "analyzed";
      return { state: "pass" };
    },
    group: async id => { calls.push(`group:${id}`); state.pending.find(item => item.id === id)!.groupingStatus = "complete"; return { verdict: "new-story" }; },
    compose: async key => {
      calls.push(`compose:${key}`);
      state.due = { key, exists: true, entries: state.due.entries ?? 1 };
      return { key, entries: state.due.entries! };
    },
  };
  return { state, calls, deps };
}

test("check is read-only and reports disabled source state, budget and the due issue", () => {
  const f = fixture([article("a")]);
  f.state.sources[0].enabled = false;
  const result = check(f.state);
  assert.equal(result.ready, false);
  assert.equal(result.sources[0].enabled, false);
  assert.equal(result.pending.total, 0);
  assert.equal(result.budget?.perDay, 120);
  assert.equal(result.due.key, "2026-10-14");
  assert.deepEqual(f.calls, []);
});

test("collection diagnostics do not copy private provider errors into scheduler output", async () => {
  const f = fixture();
  f.deps.collect = async sourceId => ({ sourceId, status: "failed", found: 0, created: 0, revised: 0,
    error: "provider-private-details" });
  const result = await runDaily(f.deps);
  assert.equal(result.status, "incomplete");
  assert.equal(JSON.stringify(result).includes("provider-private-details"), false);
  assert.deepEqual(Object.keys(result.collected[0]), ["sourceId", "status", "found", "created", "revised"]);
});

test("check allows closed action valves and no transient adapter, but reports what a run requires", () => {
  const f = fixture();
  f.state.valves.COLLECT_ENABLED = "false";
  f.state.valves.MODEL_CALLS_ENABLED = "false";
  f.state.adapterConfigured = false;
  const result = check(f.state);
  assert.equal(result.ready, true);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.runWouldRequire, ["COLLECT_ENABLED must be true", "MODEL_CALLS_ENABLED must be true", "The Codex CLI adapter must be configured"]);
  assert.deepEqual(f.calls, []);
});

test("closed collection/model valves, enabled notifications and absent or unbounded budgets stop before collection", async () => {
  const mutations: Array<(state: Snapshot) => void> = [
    state => { state.valves.COLLECT_ENABLED = "false"; },
    state => { state.valves.MODEL_CALLS_ENABLED = undefined; },
    state => { state.valves.FEISHU_INTERNAL_ENABLED = "true"; },
    state => { state.valves.INDEXNOW_SUBMIT_ENABLED = "true"; },
    state => { state.budget = null; },
    state => { state.budget!.perDay = Infinity; },
    state => { state.budget!.perHour = 0; },
    state => { state.models.score = "default"; },
    state => { state.models.groupReview = "deepseek-flash"; },
    state => { state.adapterConfigured = false; },
    state => { state.otherPaidProviders = true; },
  ];
  for (const mutate of mutations) {
    const f = fixture([article("a")]);
    mutate(f.state);
    assert.equal((await runDaily(f.deps)).status, "blocked");
    assert.deepEqual(f.calls, []);
  }
});

test("only enabled allowlisted editorial RSS sources are collected; paused sources and AgentLab are untouched", async () => {
  const f = fixture([article("a"), article("other", { sourceId: "agentlab" }), article("extra", { sourceId: "rss-unapproved" })]);
  f.state.allowlist.push("rss-paused", "rss-signal");
  f.state.sources.push({ ...f.state.sources[0], id: "rss-paused", enabled: false },
    { ...f.state.sources[0], id: "rss-signal", participationMode: "hot_signal" });
  const result = await runDaily(f.deps);
  assert.equal(result.status, "complete");
  assert.deepEqual(f.calls, ["collect:rss-approved", "process:a", "group:a", "compose:2026-10-14"]);
});

test("source pause during collection prevents its articles from being processed", async () => {
  const f = fixture([article("a")]);
  f.deps.collect = async sourceId => {
    f.calls.push(`collect:${sourceId}`);
    f.state.sources[0].enabled = false;
    return { sourceId, status: "ok", found: 0, created: 0, revised: 0 };
  };
  assert.equal((await runDaily(f.deps)).status, "incomplete");
  assert.deepEqual(f.calls, ["collect:rss-approved"]);
});

test("a successful repeated run reuses the existing issue and never reprocesses completed articles", async () => {
  const f = fixture([article("a", { bodyStatus: "pending", attemptTag: "reviewed-attempt" })]);
  const first = await runDaily(f.deps);
  const second = await runDaily(f.deps);
  assert.equal(first.status, "complete");
  assert.equal(first.report?.existing, false);
  assert.equal(second.status, "complete");
  assert.equal(second.report?.existing, true);
  assert.equal(f.calls.filter(call => call.startsWith("process:")).length, 1);
  assert.equal(f.calls.filter(call => call.startsWith("extract:")).length, 1);
  assert.ok(f.calls.includes("process:a:reviewed-attempt"));
});

test("backfill is never processed and the live per-run limit leaves an explicit incomplete result", async () => {
  const f = fixture([article("history", { backfill: true }), ...Array.from({ length: RUN_LIMIT + 1 }, (_, i) => article(`live-${String(i).padStart(2, "0")}`))]);
  const result = await runDaily(f.deps);
  assert.equal(result.status, "incomplete");
  assert.equal(result.processed.length, RUN_LIMIT);
  assert.equal(result.remaining?.total, 1);
  assert.equal(result.remaining?.historicalPending, 1);
  assert.ok(result.processed.every(item => item.id.startsWith("live-")));
  assert.ok(!f.calls.some(call => call.startsWith("compose:")));
});

test("future retry, failed articles and unresolved receipts are reported without automatic retries", async () => {
  const f = fixture([
    article("retry-later", { retryAt: "2026-10-15T00:00:00Z" }),
    article("failed", { processingState: "failed" }),
    article("unknown-receipt", { blockedReceipt: true }),
    article("failed-group", { processingState: "analyzed", groupingStatus: "failed", blockedReceipt: true }),
  ]);
  const before = structuredClone(f.state.pending);
  const result = await runDaily(f.deps);
  assert.equal(result.status, "incomplete");
  assert.equal(result.remaining?.deferred, 1);
  assert.equal(result.remaining?.blockedReceipts, 2);
  assert.equal(result.remaining?.failed, 2);
  assert.deepEqual(f.state.pending, before);
  assert.deepEqual(f.calls, ["collect:rss-approved"]);
});

test("processing failure states propagate instead of being mistaken for successful execution", async () => {
  for (const state of ["waiting", "retrying", "failed", "unknown-receipt", "fetching-body", "stale", "missing"]) {
    const f = fixture([article("a")]);
    f.deps.process = async () => ({ state });
    const result = await runDaily(f.deps);
    assert.equal(result.status, "incomplete", state);
    assert.ok(result.problems.some(problem => problem === `Processing ${state}: a`));
    assert.equal(result.report, null);
  }
});

test("a failed collection, extraction or grouping cannot publish an incomplete issue", async () => {
  for (const failure of ["collect", "extract", "group"] as const) {
    const f = fixture([article("a", { bodyStatus: "pending" })]);
    if (failure === "collect") f.deps.collect = async sourceId => ({ sourceId, status: "failed", found: 0, created: 0, revised: 0 });
    if (failure === "extract") f.deps.extract = async () => { throw new Error("provider-private-details"); };
    if (failure === "group") f.deps.group = async () => { throw new Error("provider-private-details"); };
    const result = await runDaily(f.deps);
    assert.equal(result.status, "incomplete", failure);
    assert.equal(result.report, null);
    assert.ok(!JSON.stringify(result).includes("provider-private-details"));
  }
});

test("extraction retry is incomplete and never falls through to analysis", async () => {
  const f = fixture([article("a", { bodyStatus: "pending" })]);
  f.deps.extract = async () => "retrying";
  const result = await runDaily(f.deps);
  assert.equal(result.status, "incomplete");
  assert.equal(result.processed[0].state, "extraction-incomplete");
  assert.ok(!f.calls.some(call => call.startsWith("process:")));
});

test("an exhausted extraction marked unconfirmed can continue through analysis and grouping", async () => {
  const f = fixture([article("a", { bodyStatus: "pending" })]);
  f.deps.extract = async () => { f.state.pending[0].bodyStatus = "unconfirmed"; return "unconfirmed"; };
  const result = await runDaily(f.deps);
  assert.equal(result.status, "complete");
  assert.equal(result.processed[0].extraction, "unconfirmed");
  assert.ok(f.calls.includes("process:a"));
  assert.ok(f.calls.includes("group:a"));
});

test("no judged live material is awaiting first live issue, never a fabricated quiet issue", async () => {
  const f = fixture([article("history", { backfill: true, blockedReceipt: true, processingState: "failed" })]);
  f.deps.compose = async key => { throw new Error(`daily ${key}: nothing judged in its window`); };
  const result = await runDaily(f.deps);
  assert.equal(result.status, "awaiting-first-live-issue");
  assert.equal(result.report, null);
  assert.equal(f.state.due.exists, false);
  assert.equal(result.remaining?.historicalPending, 1);
  assert.equal(result.remaining?.total, 0);
  assert.deepEqual(f.calls, ["collect:rss-approved"]);
});

test("analyzed live items resume grouping without extraction or repeated analysis", async () => {
  const f = fixture([article("pending-group", { processingState: "analyzed", bodyStatus: "pending" }),
    article("interrupted-group", { processingState: "analyzed", groupingStatus: "failed" })]);
  const result = await runDaily(f.deps);
  assert.equal(result.status, "complete");
  assert.ok(result.processed.every(item => item.state === "group-only"));
  assert.ok(!f.calls.some(call => /^(process|extract):/.test(call)));
  assert.equal(f.calls.filter(call => call.startsWith("group:")).length, 2);
});

test("model or source changes are rechecked before the next article", async () => {
  const f = fixture([article("a"), article("b")]);
  const process = f.deps.process;
  f.deps.process = async (id, tag) => {
    const result = await process(id, tag);
    f.state.models.groupReview = "default";
    return result;
  };
  const result = await runDaily(f.deps);
  assert.equal(result.status, "incomplete");
  assert.equal(result.processed.length, 1);
  assert.ok(result.problems.includes("groupReview must use gpt-6.1-sol"));
});

test("only pending bodies are extracted and ready retries retain their existing state until processing", () => {
  const f = fixture([article("later", { retryAt: "2026-10-15T00:00:00Z" }), article("due", { retryAt: "2026-10-14T00:00:00Z" })]);
  assert.deepEqual(pendingSummary(f.state).candidates.map(item => item.id), ["due"]);
  assert.equal(f.state.pending[1].retryAt, "2026-10-14T00:00:00Z");
});
