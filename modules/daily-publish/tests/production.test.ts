import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { releaseUnknownReceipt } from "@aihot/backend/providers/receipts";
import { beijingAt } from "@aihot/contracts/time";
import { EDITION_TIMES } from "@aihot/site";
import { SOURCE_ALLOWLIST, snapshot } from "../production.ts";
import { pendingSummary, REQUIRED_MODELS, type Dependencies } from "../workflow.ts";
import { runRecorded } from "../execute.ts";

const SOURCE = SOURCE_ALLOWLIST[0];
beforeEach(async () => {
  await sql`TRUNCATE sources, articles, receipts, job_runs CASCADE`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode) VALUES (${SOURCE}, 'Daily fixture', 'rss', 'T1', 'editorial')`;
});
after(closeDb);

async function material(key: string, backfill?: string) {
  return upsertMaterial({ sourceId: SOURCE, via: "fetch", url: `https://example.com/daily/${key}`, title: key,
    publishedAt: new Date(), bodyText: `Body ${key}`, bodyStatus: "ok", backfill });
}

async function receipt(subject: string, key: string, status = "unknown", createdAt = new Date()) {
  const [row] = await sql<{ id: number }[]>`INSERT INTO receipts (logical_key, service, purpose, subject, status, created_at)
    VALUES (${key}, 'codex-cli', 'group_article', ${subject}, ${status}, ${createdAt}) RETURNING id`;
  return row.id;
}

test("pending and unknown receipts block only their current revision; a released failed receipt permits retry", async () => {
  const { articleId } = await material("revision");
  await sql`UPDATE articles SET revision = 2 WHERE id = ${articleId}`;
  await sql`INSERT INTO article_revisions (article_id, revision, content_hash, title, created_at)
    VALUES (${articleId}, 2, 'revision-two', 'Revision two', '2026-10-01T00:00:00Z')`;
  await receipt(`article:${articleId}@1`, "older-version");
  await receipt(`article:${articleId}:fact:10`, "older-unversioned", "unknown", new Date("2026-09-30T00:00:00Z"));
  assert.equal((await snapshot()).pending[0].blockedReceipt, false);

  const current = await receipt(`article:${articleId}@2`, "current-version");
  assert.equal((await snapshot()).pending[0].blockedReceipt, true);
  await releaseUnknownReceipt(sql, current, "Explicit test operator release");
  assert.equal((await snapshot()).pending[0].blockedReceipt, false);

  const grouping = await receipt(`article:${articleId}`, "current-unversioned", "pending");
  assert.equal((await snapshot()).pending[0].blockedReceipt, true);
  await sql`UPDATE receipts SET status = 'completed' WHERE id = ${grouping}`;
  const linked = await receipt("story:10:11", "linked-grouping");
  await sql`UPDATE articles SET grouping_receipt_id = ${linked} WHERE id = ${articleId}`;
  assert.equal((await snapshot()).pending[0].blockedReceipt, true);
});

test("history is only counted, paused sources disappear from pending work, and snapshot writes nothing", async () => {
  const { articleId } = await material("history", "first-import");
  await receipt(`article:${articleId}@1`, "historical-unknown");
  const [before] = await sql`SELECT (SELECT count(*)::int FROM articles) AS articles, (SELECT count(*)::int FROM receipts) AS receipts,
    (SELECT count(*)::int FROM reports) AS reports, (SELECT count(*)::int FROM fetch_runs) AS fetches, (SELECT count(*)::int FROM job_runs) AS jobs`;
  const status = await snapshot();
  assert.equal(pendingSummary(status).historicalPending, 1);
  assert.equal(pendingSummary(status).total, 0);
  const [after] = await sql`SELECT (SELECT count(*)::int FROM articles) AS articles, (SELECT count(*)::int FROM receipts) AS receipts,
    (SELECT count(*)::int FROM reports) AS reports, (SELECT count(*)::int FROM fetch_runs) AS fetches, (SELECT count(*)::int FROM job_runs) AS jobs`;
  assert.deepEqual(after, before);
  await sql`UPDATE sources SET enabled = false WHERE id = ${SOURCE}`;
  const paused = await snapshot();
  assert.equal(paused.sources[0].enabled, false);
  assert.equal(paused.pending.length, 0);
});

test("snapshot includes analyzed live items only when their passing analysis still needs grouping", async () => {
  const { articleId } = await material("grouping");
  await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id = ${articleId}`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance) VALUES (${articleId}, 1, 'rule', 'pass')`;
  assert.equal(pendingSummary(await snapshot()).candidates[0].id, articleId);
  await sql`UPDATE articles SET grouping_status = 'complete' WHERE id = ${articleId}`;
  assert.equal(pendingSummary(await snapshot()).total, 0);
});

test("snapshot exposes the stored article timeline and the actual due edition cutoff", async () => {
  const { articleId } = await material("timeline");
  const timeline = "2026-10-14T00:00:00.000Z";
  await sql`UPDATE articles SET timeline_at = ${timeline}::timestamptz WHERE id = ${articleId}`;
  const state = await snapshot();
  assert.equal(Date.parse(state.pending[0].timelineAt!), Date.parse(timeline));
  assert.equal(state.due.windowEnd, beijingAt(state.due.key, EDITION_TIMES.daily).toISOString());
  assert.equal(Date.parse(state.due.windowEnd) - Date.parse(state.due.windowStart), 86400000);
  assert.ok(Date.parse(state.due.windowEnd) <= Date.parse(state.at));
});

test("run bookkeeping marks incomplete publication failed, and only a completed result is successful", async () => {
  const state = await snapshot();
  state.models = Object.fromEntries(REQUIRED_MODELS.map(step => [step, "gpt-6.1-sol"]));
  state.budget = { perMinute: 12, perHour: 60, perDay: 120 };
  state.valves = { COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false", FEISHU_INTERNAL_ENABLED: "false",
    FEISHU_CONTENT_PUSH_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false" };
  state.adapterConfigured = false;
  const end = Date.parse(state.due.windowEnd);
  state.preparation = { status: "ok", collectionVerified: true, startedAt: new Date(end - 90 * 60_000).toISOString(),
    finishedAt: new Date(end - 30 * 60_000).toISOString(), sourceIds: [SOURCE] };
  state.otherPaidProviders = false;
  const deps: Dependencies = {
    snapshot: async () => state,
    collect: async sourceId => ({ sourceId, status: "ok", found: 0, created: 0, revised: 0 }),
    extract: async () => { throw new Error("No extraction expected"); },
    process: async () => { throw new Error("No analysis expected"); },
    group: async () => { throw new Error("No grouping expected"); },
    compose: async key => { throw new Error(`daily ${key}: nothing judged in its window`); },
  };
  const outputs: string[] = [];
  await assert.rejects(runRecorded(deps, "publish", result => outputs.push(result.status)), /awaiting-first-live-issue/);
  const [failed] = await sql`SELECT job, status, error, detail FROM job_runs ORDER BY id DESC LIMIT 1`;
  assert.equal(failed.job, "agenthot.daily-publish");
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /No judged live news/);
  assert.equal(failed.detail.status, "awaiting-first-live-issue");
  assert.deepEqual(outputs, ["awaiting-first-live-issue"]);

  deps.compose = async key => ({ key, entries: 1 });
  await runRecorded(deps, "publish", result => outputs.push(result.status));
  const [complete] = await sql`SELECT status, detail FROM job_runs ORDER BY id DESC LIMIT 1`;
  assert.equal(complete.status, "ok");
  assert.equal(complete.detail.status, "complete");
  assert.equal(complete.detail.report.entries, 1);
});

test("snapshot uses latest pre-cutoff collection attempt, not an older success or a late run", async () => {
  const state = await snapshot();
  const end = Date.parse(state.due.windowEnd);
  const started = new Date(end - 90 * 60_000);
  const finished = new Date(end - 70 * 60_000);
  await sql`INSERT INTO job_runs (job, status, started_at, finished_at, detail)
    VALUES ('agenthot.daily-collect', 'ok', ${started}, ${finished}, ${sql.json({ collectionVerified: true, collected: [{ sourceId: SOURCE, status: "ok" }] })})`;
  assert.deepEqual((await snapshot()).preparation?.sourceIds, [SOURCE]);
  await sql`INSERT INTO job_runs (job, status, started_at, finished_at)
    VALUES ('agenthot.daily-collect', 'failed', ${new Date(end - 60 * 60_000)}, ${new Date(end - 50 * 60_000)})`;
  assert.equal((await snapshot()).preparation?.status, "failed");
  await sql`INSERT INTO job_runs (job, status, started_at, finished_at)
    VALUES ('agenthot.daily-collect', 'ok', ${new Date(end + 60_000)}, ${new Date(end + 120_000)})`;
  assert.equal((await snapshot()).preparation?.status, "failed");
});

test("snapshot counts material insufficiency without exposing stored errors", async () => {
  const { articleId } = await material("awaiting-source");
  await sql`UPDATE articles SET processing_state = 'failed', body_text = NULL, body_status = 'unconfirmed',
    processing_error = 'awaiting-source: access_challenge' WHERE id = ${articleId}`;
  const state = await snapshot();
  assert.equal(pendingSummary(state).awaitingSource, 1);
  assert.equal(JSON.stringify(state).includes("access_challenge"), false);
});

test("failed collection-phase bookkeeping preserves verified coverage and visible material debt", async () => {
  const { articleId } = await material("material-debt");
  await sql`UPDATE articles SET processing_state = 'failed', body_text = NULL, body_status = 'unconfirmed',
    processing_error = 'awaiting-source: access_challenge' WHERE id = ${articleId}`;
  const state = await snapshot();
  state.models = Object.fromEntries(REQUIRED_MODELS.map(step => [step, "gpt-6.1-sol"]));
  state.budget = { perMinute: 12, perHour: 60, perDay: 120 };
  state.valves = { COLLECT_ENABLED: "true", MODEL_CALLS_ENABLED: "true", FEISHU_INTERNAL_ENABLED: "false",
    FEISHU_CONTENT_PUSH_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false" };
  state.adapterConfigured = true;
  state.otherPaidProviders = false;
  const unexpected = async () => { throw new Error("No body/model/publication call expected"); };
  const deps: Dependencies = { snapshot: async () => state,
    collect: async sourceId => ({ sourceId, status: "ok", found: 0, created: 0, revised: 0 }),
    extract: unexpected, process: unexpected, group: unexpected, compose: unexpected };
  await assert.rejects(runRecorded(deps, "collect", () => {}), /incomplete/);
  const [run] = await sql`SELECT job, status, detail FROM job_runs ORDER BY id DESC LIMIT 1`;
  assert.equal(run.job, "agenthot.daily-collect");
  assert.equal(run.status, "failed");
  assert.equal(run.detail.collectionVerified, true);
  assert.equal(run.detail.remaining.awaitingSource, 1);
  assert.equal(run.detail.collected[0].sourceId, SOURCE);
});
