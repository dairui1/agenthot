import { editionAt, gate } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb, sql } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { publishArticle, publishArticleTx } from "@aihot/backend/publication/publish";
import { loadReport } from "@aihot/backend/publication/reports";
import { composeDaily } from "@aihot/backend/reports/compose";
import { arrangeDaily, dailyEdition } from "@aihot/backend/reports/edition";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { agentlab } from "../server.ts";
import { reconcileDailyAdmissions, releaseUrls } from "../daily.ts";
import { SOURCE_ID, type Snapshot } from "../contract.ts";
import { syncAgentLab } from "../sync.ts";
import { feed, item, NOW, removal } from "./fixtures.ts";

process.env.MODEL_CALLS_ENABLED = "false";
process.env.COLLECT_ENABLED = "false";
const DATE = "2026-10-08";
const end = editionAt("daily", DATE);
const start = editionAt("daily", DATE, -86400);
installModules([agentlab]);
beforeEach(async () => {
  installModules([agentlab]);
  await sql`DELETE FROM reports`;
  await sql`TRUNCATE sources, articles CASCADE`;
});
after(async () => { installModules([]); await stopBoss(); await closeDb(); });

const sync = (snapshot: Snapshot) => syncAgentLab({ load: async () => snapshot, now: new Date() });
const later = (changes: Partial<Snapshot> = {}) => feed({ exportedAt: "2026-10-07T02:00:00.000Z", ...changes });
const current = async () => (await sql`SELECT a.id, a.discovered_at, a.timeline_at, a.published_at, a.backfill,
  p.selected, p.score, p.title, p.summary, p.analysis_id, i.daily_visible_at
  FROM articles a JOIN publications p ON p.article_id = a.id JOIN agentlab_items i ON i.article_id = a.id
  WHERE a.source_id = ${SOURCE_ID}`)[0]!;
const edition = () => dailyEdition(DATE, start, end);
async function live() {
  await sync(feed({ items: [] }));
  await sync(later());
  return current();
}

async function officialRelease(version = "1.0.0", at = new Date()) {
  const source = "official-codex-releases";
  const id = `official-codex-${version.replaceAll(".", "-")}`;
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${source}, 'Codex releases', 'rss', 'T1') ON CONFLICT DO NOTHING`;
  const url = `https://github.com/openai/codex/releases/tag/${version}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, grouping_status)
    VALUES (${id}, ${source}, ${id}, ${url}, ${id}, ${at}, ${at}, 'complete')`;
  await sql`INSERT INTO publications (article_id, title, summary, source_id, channel, url, discovered_at, timeline_at, sort_at, eligible, selected, visible_after, visibility, score)
    VALUES (${id}, ${id}, 'Official release evidence', ${source}, 'news', ${url}, ${at}, ${at}, ${at}, true, true, ${at}, 'public', 80)`;
  return id;
}

test("fresh reviewed live AgentLab material enters the daily without score, selection or model calls", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const row = await live();
  assert.equal(row.backfill, false);
  assert.equal(row.selected, false);
  assert.equal(row.score, null);
  assert.equal(row.daily_visible_at.toISOString(), NOW.toISOString());
  const result = await edition();
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]!.entry.itemId, row.id);
  assert.equal(result.entries[0]!.entry.score, null);
  assert.equal(result.entries[0]!.entry.fillIn, undefined);
  assert.equal(result.stats.selectedReports, 0);
  assert.equal(result.stats.suppliedReports, 1);
  await composeDaily(DATE);
  assert.equal((await loadReport("daily", DATE))?.sections[0]?.items[0]?.itemId, row.id);
  const [count] = await sql`SELECT (SELECT count(*)::int FROM receipts) AS receipts,
    (SELECT count(*)::int FROM selected_ledger) AS ledger, (SELECT count(*)::int FROM analyses WHERE origin = 'model') AS models`;
  assert.deepEqual(count, { receipts: 0, ledger: 0, models: 0 });
});

test("first imports and unstamped legacy projections remain outside daily candidates", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  await sync(feed());
  assert.equal((await current()).daily_visible_at, null);
  assert.equal((await edition()).entries.length, 0);
  await assert.rejects(composeDaily(DATE), /nothing judged/);
  await sql`TRUNCATE sources, articles CASCADE`;
  const row = await live();
  await sql`UPDATE agentlab_items SET daily_visible_at = NULL WHERE article_id = ${row.id}`;
  assert.equal((await edition()).entries.length, 0);
});

test("repeat sync and title corrections preserve admission time and manual copy overrides", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const row = await live();
  t.mock.timers.tick(3600000);
  await sync(later());
  await sql`INSERT INTO editorial_overrides (article_id, fields, reason) VALUES (${row.id}, '{"title":"Editor title","summary":"Editor summary"}', 'editor correction')`;
  await sync(later({ exportedAt: "2026-10-07T03:00:00.000Z", items: [item({ title: "Upstream correction", importance: "high" })] }));
  const corrected = await current();
  assert.equal(corrected.daily_visible_at.toISOString(), row.daily_visible_at.toISOString());
  assert.equal(corrected.title, "Editor title");
  assert.equal(corrected.summary, "Editor summary");
  assert.equal(corrected.score, null, "upstream importance never becomes an AgentHot score");
  const result = await edition();
  assert.equal(result.entries[0]!.entry.title, "Editor title");
  await composeDaily(DATE);
  assert.equal((await dailyEdition("2026-10-09", start, end)).entries.length, 0, "the same release is not repeated in a later issue");
});

test("withdrawal and restoration across the cutoff use the new actual admission time", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const row = await live();
  await composeDaily(DATE);
  await sync(later({ exportedAt: "2026-10-07T03:00:00.000Z", items: [], withdrawn: [removal(item().id, "withdrawn")] }));
  assert.equal((await current()).daily_visible_at, null);
  assert.equal((await edition()).entries.length, 0);
  assert.equal((await loadReport("daily", DATE))?.sections[0]?.items[0]?.available, false);
  t.mock.timers.setTime(end.getTime() + 3600000);
  await sync(later({ exportedAt: "2026-10-08T00:30:00.000Z" }));
  assert.equal((await current()).daily_visible_at.toISOString(), new Date().toISOString());
  assert.equal((await edition()).entries.length, 0, "restoration must not backdate into the closed window");
  await sql`DELETE FROM reports`;
  const next = await dailyEdition("2026-10-09", end, editionAt("daily", "2026-10-09"));
  assert.deepEqual(next.entries.map(entry => entry.entry.itemId), [row.id]);
});

test("captured dates, stale evidence and explicit suppression never qualify through the module", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  await sync(feed({ items: [] }));
  await sync(later({ items: [item({ dateKind: "captured" })] }));
  assert.equal((await edition()).entries.length, 0);
  await sync(later({ exportedAt: "2026-10-07T03:00:00.000Z", items: [item({ sourceFreshness: "stale" })] }));
  assert.equal((await edition()).entries.length, 0);
  await sync(later({ exportedAt: "2026-10-07T04:00:00.000Z" }));
  assert.equal((await edition()).entries.length, 1);
  await sync(later({ exportedAt: "2026-10-07T05:00:00.000Z", items: [], suppressed: [removal(item().id, "incomplete")] }));
  assert.equal((await edition()).entries.length, 0);
});

test("explicit deselection and later independent judgements are not bypassed by imported provenance", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const row = await live();
  await sql`INSERT INTO editorial_overrides (article_id, fields, reason) VALUES (${row.id}, '{"selected":false}', 'editor excludes it')`;
  await publishArticle(row.id);
  assert.equal((await edition()).entries.length, 0);
  assert.equal((await current()).daily_visible_at, null);
  await sql`DELETE FROM editorial_overrides WHERE article_id = ${row.id}`;
  t.mock.timers.tick(60000);
  await publishArticle(row.id);
  assert.equal((await current()).daily_visible_at.toISOString(), new Date().toISOString());
  assert.equal((await edition()).entries.length, 1);
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, title_zh, summary_zh, selected)
    SELECT id, revision, 'rule', 'pass', 'Independent decision', 'Independent decision summary', false FROM articles WHERE id = ${row.id}`;
  await publishArticle(row.id);
  assert.equal((await edition()).entries.length, 0);
});

test("an independently selected article supplied by the module is counted once, not re-scored", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const row = await live();
  await sql`INSERT INTO editorial_overrides (article_id, fields, reason) VALUES (${row.id}, '{"selected":true,"score":82}', 'explicit editor decision')`;
  await publishArticle(row.id);
  const result = await edition();
  assert.equal(result.entries.length, 1);
  assert.equal(result.stats.selectedReports, 1);
  assert.equal(result.stats.suppliedReports, 0);
  assert.equal(result.entries[0]!.entry.score, 82);
});

test("AgentLab allocation is per project without changing the actual source or global edition limits", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  await sync(feed({ items: [] }));
  const release = (agentId: string, version: string) => item({
    id: `agentlab:release:${agentId}:${version}`, agentId, version,
    url: `https://agentlab.dairui1.com/?mode=compare&agent=${agentId}&version=${version}`,
    sources: [{ url: `https://github.com/org/${agentId}/releases/tag/${version}`, sourceType: "official-release" }],
  });
  await sync(later({ items: [release("codex", "1"), release("codex", "2"), release("codex", "3"), release("claude", "1"), release("gemini", "1")] }));
  const arranged = arrangeDaily((await edition()).entries);
  assert.equal(arranged.main.length, 4, "two Codex entries plus one from each other project");
  assert.equal(arranged.flashes.length, 1);
  assert.equal(arranged.main.every(entry => entry.entry.sourceId === SOURCE_ID && entry.entry.sourceName === "AgentLab"), true);
  assert.equal(arranged.main.every(entry => entry.entry.score === null), true);
});

test("exact official release evidence deduplicates same-day AgentLab and GitHub candidates, not other tags", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  await live();
  const official = await officialRelease();
  await officialRelease("2.0.0");
  const result = await edition();
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries.some(entry => entry.entry.itemId === official), true, "the official representative keeps its provenance");
  assert.deepEqual(releaseUrls(item({ sources: [
    { sourceType: "official-release", url: "https://github.com/openai/codex" },
    { sourceType: "official-release", url: "https://github.com/openai/codex/tree/main" },
    { sourceType: "official-release", url: "https://github.com/openai/codex/releases/tag/1.0.0?utm_source=test#notes" },
    { sourceType: "official-release", url: "https://github.com/openai/codex/releases/tag/0.9.0" },
  ] })), ["https://github.com/openai/codex/releases/tag/1.0.0"]);
});

test("release equivalence requires current official version evidence, not baselines or ambiguous releases", () => {
  const evidence = (tag: string, repo = "openai/codex") => ({ sourceType: "official-release", url: `https://github.com/${repo}/releases/tag/${tag}` });
  assert.deepEqual(releaseUrls(item({ sources: [evidence("rust-v1.0.0")] })), [evidence("rust-v1.0.0").url]);
  assert.deepEqual(releaseUrls(item({ sources: [evidence("rust-v0.9.0")] })), []);
  assert.deepEqual(releaseUrls(item({ sources: [evidence("py-v1.0.0")] })), []);
  assert.deepEqual(releaseUrls(item({ sources: [{ ...evidence("1.0.0"), sourceType: "comparison-baseline" }] })), []);
  assert.deepEqual(releaseUrls(item({ sources: [evidence("1.0.0"), evidence("1.0.0", "other/project")] })), []);
});

test("ordinary candidates sharing an overview URL are not merged without declared release equivalence", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  await officialRelease("1.0.0");
  await officialRelease("2.0.0");
  await sql`UPDATE publications SET url = 'https://github.com/openai/codex'`;
  assert.equal((await edition()).entries.length, 2);
  await composeDaily(DATE);
  t.mock.timers.setTime(end.getTime() + 1000);
  const next = await officialRelease("3.0.0");
  await sql`UPDATE publications SET url = 'https://github.com/openai/codex' WHERE article_id = ${next}`;
  assert.equal((await dailyEdition("2026-10-09", end, editionAt("daily", "2026-10-09"))).entries.length, 1);
});

test("exact release identities suppress duplicates in either arrival order across daily issues", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  await live();
  await composeDaily(DATE);
  t.mock.timers.setTime(end.getTime() + 1000);
  await officialRelease();
  assert.equal((await dailyEdition("2026-10-09", end, editionAt("daily", "2026-10-09"))).entries.length, 0);
  await sql`DELETE FROM reports`;
  await sql`TRUNCATE sources, articles CASCADE`;
  t.mock.timers.setTime(NOW.getTime());
  await sync(feed({ items: [] }));
  await officialRelease();
  await composeDaily(DATE);
  t.mock.timers.setTime(end.getTime() + 1000);
  await sync(later());
  assert.equal((await dailyEdition("2026-10-09", end, editionAt("daily", "2026-10-09"))).entries.length, 0);
});

test("bounded reconcile previews by default and stamps only recent compliant live IDs without changing timelines", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const row = await live();
  await sql`UPDATE agentlab_items SET daily_visible_at = NULL WHERE article_id = ${row.id}`;
  t.mock.timers.tick(60000);
  const preview = await reconcileDailyAdmissions([row.id, row.id]);
  assert.deepEqual(preview.eligible, [row.id]);
  assert.deepEqual(preview.stamped, []);
  assert.equal((await current()).daily_visible_at, null);
  const applied = await reconcileDailyAdmissions([row.id], { apply: true });
  assert.deepEqual(applied.stamped, [row.id]);
  const restored = await current();
  assert.equal(restored.daily_visible_at.toISOString(), new Date().toISOString());
  for (const field of ["timeline_at", "published_at", "discovered_at"]) assert.deepEqual(restored[field], row[field]);
  assert.deepEqual((await reconcileDailyAdmissions([row.id], { apply: true })).stamped, []);
  await sql`UPDATE agentlab_items SET daily_visible_at = NULL WHERE article_id = ${row.id}`;
  t.mock.timers.tick(86400000);
  assert.deepEqual((await reconcileDailyAdmissions([row.id], { apply: true })).eligible, [], "old material is not reintroduced as today");
});

test("candidate hooks cannot bypass the common publication, backfill or actual-cutoff gates", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const row = await live();
  let releasedAt = end;
  installModules([{ name: "test-candidate", dailyReportCandidates: async () => [{ articleId: row.id, releasedAt }] }]);
  assert.equal((await edition()).entries.length, 0, "an admission exactly at the cutoff belongs to the next window");
  releasedAt = new Date(end.getTime() - 1);
  assert.equal((await edition()).entries.length, 1);
  await sql`UPDATE publications SET backfill = true WHERE article_id = ${row.id}`;
  assert.equal((await edition()).entries.length, 0);
  await sql`UPDATE publications SET backfill = false, visibility = 'withdrawn' WHERE article_id = ${row.id}`;
  assert.equal((await edition()).entries.length, 0);
  await sql`UPDATE publications SET visibility = 'public', eligible = false WHERE article_id = ${row.id}`;
  assert.equal((await edition()).entries.length, 0);
});

test("an AgentLab publication waiting across the cutoff stamps after the lock, not at import start", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(end.getTime() - 1000) });
  await sync(feed({ items: [] }));
  const acquired = gate<number>();
  const release = gate();
  const holding = sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('report_candidates'))`;
    acquired.open((await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
    await release.promise;
  });
  let operation: ReturnType<typeof sync> | undefined;
  try {
    const blocker = await acquired.promise;
    operation = sync(later());
    const deadline = performance.now() + 5000;
    while (!(await sql`SELECT 1 FROM pg_stat_activity WHERE ${blocker} = ANY(pg_blocking_pids(pid))`)[0]) {
      if (performance.now() > deadline) assert.fail("publication did not reach its held lock");
      await delay(10);
    }
    t.mock.timers.setTime(end.getTime() + 1000);
    release.open();
    await holding;
    await operation;
    assert.equal((await current()).daily_visible_at.toISOString(), new Date().toISOString());
    assert.equal((await edition()).entries.length, 0);
  } finally {
    release.open();
    await Promise.allSettled([holding, operation]);
  }
});

test("a correction waiting for an editor's exclusion cannot restore its stale admission stamp", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const row = await live();
  const acquired = gate<number>();
  const release = gate();
  const editing = sql.begin(async tx => {
    await tx`SELECT id FROM articles WHERE id = ${row.id} FOR UPDATE`;
    acquired.open((await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
    await release.promise;
    await tx`INSERT INTO analyses (article_id, input_revision, origin, relevance, selected)
      SELECT id, revision, 'rule', 'block', false FROM articles WHERE id = ${row.id}`;
    await publishArticleTx(tx, row.id);
    assert.equal((await tx`SELECT daily_visible_at FROM agentlab_items WHERE article_id = ${row.id}`)[0]!.daily_visible_at, null);
  });
  let operation: ReturnType<typeof sync> | undefined;
  try {
    const blocker = await acquired.promise;
    operation = sync(later({ exportedAt: "2026-10-07T03:00:00.000Z", items: [item({ title: "New reviewed revision" })] }));
    const deadline = performance.now() + 5000;
    while (!(await sql`SELECT 1 FROM pg_stat_activity WHERE ${blocker} = ANY(pg_blocking_pids(pid))`)[0]) {
      if (performance.now() > deadline) assert.fail("sync did not reach the held article lock");
      await delay(10);
    }
    t.mock.timers.tick(3600000);
    release.open();
    await editing;
    await operation;
    assert.equal((await current()).daily_visible_at.toISOString(), new Date().toISOString());
  } finally {
    release.open();
    await Promise.allSettled([editing, operation]);
  }
});
