import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { publishArticle } from "@aihot/backend/publication/publish";
import { exportMarkdown, loadItemDetail } from "@aihot/backend/publication/detail";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { gate } from "../../../tests/setup.ts";
import { SOURCE_ID, type Snapshot } from "../contract.ts";
import { agentlab } from "../server.ts";
import { ensureSource, syncAgentLab, syncHealth } from "../sync.ts";
import { feed, item, NOW, removal } from "./fixtures.ts";

installModules([agentlab]);
beforeEach(async () => { await sql`TRUNCATE sources, articles CASCADE`; });
after(async () => { await stopBoss(); await closeDb(); });
const sync = (snapshot: Snapshot) => syncAgentLab({ load: async () => snapshot, now: NOW });
const later = (changes: Partial<Snapshot> = {}) => feed({ exportedAt: "2026-10-07T02:00:00.000Z", ...changes });
async function current() {
  const [row] = await sql`SELECT a.id, a.revision, a.backfill, a.published_at, p.visibility, p.eligible, p.selected,
    p.score, p.summary, p.title, p.body_mode, p.analysis_id FROM articles a JOIN publications p ON p.article_id = a.id WHERE a.source_id = ${SOURCE_ID}`;
  return row;
}
async function counts() {
  const [row] = await sql`SELECT (SELECT count(*)::int FROM articles) AS articles,
    (SELECT count(*)::int FROM article_revisions) AS revisions, (SELECT count(*)::int FROM analyses) AS analyses,
    (SELECT count(*)::int FROM receipts) AS receipts, (SELECT count(*)::int FROM selected_ledger) AS ledger`;
  return row;
}

test("imports into original publication as attributed summaries without models, scores, selection or full text", async () => {
  assert.equal((await sync(feed())).created, 1);
  const row = await current();
  assert.equal(row.backfill, true);
  assert.equal(row.visibility, "public"); assert.equal(row.eligible, true);
  assert.equal(row.selected, false); assert.equal(row.score, null); assert.equal(row.body_mode, "summary");
  const [analysis] = await sql`SELECT origin, model, receipt_ids FROM analyses WHERE article_id = ${row.id}`;
  assert.equal(analysis.origin, "rule"); assert.equal(analysis.model, null); assert.deepEqual(analysis.receipt_ids, []);
  const detail = await loadItemDetail(row.id);
  assert.equal(detail.kind, "found");
  if (detail.kind === "found") { assert.equal(detail.item.provenance?.name, "AgentLab"); assert.equal(detail.item.body, null); }
  assert.match((await exportMarkdown(row.id))!.body, /AgentLab/);
  const first = await counts();
  assert.equal(first.receipts, 0); assert.equal(first.ledger, 0);
  const repeated = await sync(feed());
  assert.equal(repeated.created, 0); assert.equal(repeated.updated, 0);
  assert.deepEqual(await counts(), first);
});

test("corrections and intentional reverts update the same material; unchanged sync preserves later editorial analysis", async () => {
  await sync(feed()); const first = await current();
  await sync(later({ items: [item({ summary: "A corrected analysis" })] }));
  const corrected = await current();
  assert.equal(corrected.id, first.id); assert.equal(corrected.summary, "A corrected analysis");
  assert.equal(corrected.revision, first.revision + 1);
  await sync(later({ exportedAt: "2026-10-07T03:00:00.000Z" }));
  const reverted = await current();
  assert.equal(reverted.summary, item().summary); assert.equal(reverted.revision, first.revision + 2);
  const before = await counts();
  await sync(later({ exportedAt: "2026-10-07T04:00:00.000Z" }));
  assert.deepEqual(await counts(), before);
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, title_zh, summary_zh, selected)
    VALUES (${first.id}, ${reverted.revision}, 'rule', 'pass', 'Later editor analysis', 'Independent later judgement', false)`;
  await publishArticle(first.id);
  const judged = await current();
  await sync(later({ exportedAt: "2026-10-07T05:00:00.000Z" }));
  assert.equal((await current()).analysis_id, judged.analysis_id);
  assert.equal((await current()).title, "Later editor analysis");
});

test("a live item's corrected historical date returns it to the original timeline backfill policy", async () => {
  await sync(feed({ items: [] }));
  await sync(later());
  assert.equal((await current()).backfill, false);
  const older = item({ publishedAt: "2026-09-01T00:00:00.000Z" });
  await sync(later({ exportedAt: "2026-10-07T03:00:00.000Z", items: [older] }));
  const row = await current();
  assert.equal(row.backfill, true);
  const [material] = await sql`SELECT timeline_at, backfill_reason FROM articles WHERE id = ${row.id}`;
  assert.equal(material.timeline_at.toISOString(), older.publishedAt);
  assert.equal(material.backfill_reason, "stale-on-discovery");
});

test("explicit withdrawal cannot be overridden or restored by republish; reinstatement preserves manual withdrawal", async () => {
  await sync(feed()); const row = await current();
  await sql`INSERT INTO editorial_overrides (article_id, fields, visibility, reason) VALUES (${row.id}, '{"title":"Editor title"}', 'public', 'manual')`;
  await sync(later({ items: [], withdrawn: [removal(item().id, "upstream correction")] }));
  assert.equal((await current()).visibility, "withdrawn");
  assert.equal((await loadItemDetail(row.id)).kind, "not_found");
  assert.equal(await exportMarkdown(row.id), null);
  await publishArticle(row.id); assert.equal((await current()).visibility, "withdrawn");
  await sql`UPDATE editorial_overrides SET visibility = 'withdrawn' WHERE article_id = ${row.id}`;
  await sync(later({ exportedAt: "2026-10-07T03:00:00.000Z" }));
  const restored = await current(); assert.equal(restored.visibility, "withdrawn"); assert.equal(restored.title, "Editor title");
  await sql`UPDATE editorial_overrides SET visibility = NULL WHERE article_id = ${row.id}`;
  await publishArticle(row.id); assert.equal((await current()).visibility, "public");
});

test("omission does not withdraw; explicit suppression and stale evidence do, and fresh evidence reinstates", async () => {
  await sync(feed()); const row = await current();
  await sync(later({ items: [] })); assert.equal((await current()).visibility, "public");
  await sync(later({ exportedAt: "2026-10-07T03:00:00.000Z", items: [], suppressed: [removal(item().id, "analysis-incomplete")] }));
  assert.equal((await current()).visibility, "withdrawn");
  await sync(later({ exportedAt: "2026-10-07T04:00:00.000Z", items: [item({ sourceFreshness: "stale" })] }));
  assert.equal((await current()).visibility, "withdrawn");
  await sync(later({ exportedAt: "2026-10-07T05:00:00.000Z" }));
  assert.equal((await current()).visibility, "public"); assert.equal((await current()).id, row.id);
});

test("captured-only dates remain private and never masquerade as release publication dates", async () => {
  await sync(feed({ items: [item({ dateKind: "captured" })] }));
  assert.equal((await current()).visibility, "withdrawn"); assert.equal((await current()).published_at, null);
});

test("invalid and rollback snapshots leave all content and last-good cursor untouched and surface failure health", async () => {
  await sync(feed()); const before = await counts();
  const [source] = await sql`SELECT cursor, last_ok_at FROM sources WHERE id = ${SOURCE_ID}`;
  await assert.rejects(sync(later({ items: [item(), item()] })), /Duplicate/);
  await assert.rejects(sync(feed({ exportedAt: "2026-10-06T22:00:00.000Z" })), /predates/);
  await assert.rejects(sync(feed({ items: [item({ summary: "Same generation, changed content" })] })), /conflicts/);
  await assert.rejects(sync(feed({ exportedAt: "2026-10-07T01:00:00.000+00:00", items: [item({ summary: "Same instant, another timezone spelling" })] })), /conflicts/);
  assert.deepEqual(await counts(), before);
  const [after] = await sql`SELECT cursor, last_ok_at, last_error FROM sources WHERE id = ${SOURCE_ID}`;
  assert.deepEqual(after.cursor, source.cursor); assert.deepEqual(after.last_ok_at, source.last_ok_at); assert.ok(after.last_error);
  assert.equal((await syncHealth(NOW)).healthy, false);
  await sync(feed()); assert.equal((await syncHealth(NOW)).healthy, true);
  assert.equal((await syncHealth(new Date(NOW.getTime() + 91 * 60000))).healthy, false);
});

test("disabled source stays disabled without any network request; simultaneous imports do not duplicate work", async () => {
  await ensureSource(); await sql`UPDATE sources SET enabled = false, health = 'paused' WHERE id = ${SOURCE_ID}`;
  assert.equal((await syncAgentLab({ load: async () => { throw new Error("must not load"); }, now: NOW })).reason, "paused");
  assert.equal((await syncHealth(NOW)).healthy, true);
  await sql`UPDATE sources SET enabled = true WHERE id = ${SOURCE_ID}`;
  const entered = gate(); const release = gate();
  const first = syncAgentLab({ now: NOW, load: async () => { entered.open(); await release.promise; return feed(); } });
  await entered.promise;
  const second = await sync(feed()); assert.equal(second.reason, "already-running");
  release.open(); await first;
  assert.equal((await counts()).articles, 1); assert.equal((await counts()).analyses, 1);
});
