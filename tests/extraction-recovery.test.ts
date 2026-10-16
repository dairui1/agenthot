// The one-shot publisher must retain the worker's bounded extraction retries when no Jina is configured.
import { pointModels, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { rerun } from "@aihot/backend/admin/content";
import { processExtraction } from "@aihot/backend/jobs/content";
import { getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { production } from "../modules/daily-publish/production.ts";

const sourceId = `extract-recovery-${tag()}`;
let readable = false;
let hits = 0;
const body = "This source describes a coding agent release with implementation details and reproducible checks. ".repeat(12);
const page = http.createServer((req, res) => {
  hits += 1;
  if (req.url === "/challenge") {
    res.writeHead(403, { "content-type": "text/html", "cf-mitigated": "challenge" });
    res.end("<html><body>Challenge fixture, not article content.</body></html>");
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(readable ? `<html><head><title>Agent release</title></head><body><article><h1>Agent release</h1><p>${body}</p></article></body></html>` : "<html><body>Empty</body></html>");
});
await new Promise<void>(resolve => page.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
delete process.env.JINA_API_KEY;
config.allowPrivateNetworkFetch = true;

before(async () => {
  await getBoss();
  await sql`INSERT INTO sources(id,name,kind,participation_mode,config)
    VALUES (${sourceId},'Extraction recovery','rss','editorial','{"fetchPublicContent":true}')`;
});
after(async () => { page.close(); await stopBoss(); await closeDb(); });

test("daily extraction persists two retries then stops a body-less article before scoring", async () => {
  const { articleId } = await upsertMaterial({ sourceId, url: `${base}/unreadable`, title: "Agent release", excerpt: "The original feed summary.", via: "fetch", publishedAt: new Date() });
  const attemptTag = `admin:${tag()}`;
  await sql`UPDATE articles SET processing_attempt_tag=${attemptTag} WHERE id=${articleId}`;
  for (const attempts of [1, 2]) {
    assert.equal(await production.extract(articleId), "retrying");
    const [row] = await sql`SELECT body_status,processing_state,processing_attempts,processing_retry_at,processing_queued_at,processing_error
      FROM articles WHERE id=${articleId}`;
    assert.equal(row!.body_status, "pending");
    assert.equal(row!.processing_state, "new");
    assert.equal(row!.processing_attempts, attempts);
    assert.equal(row!.processing_queued_at, null);
    assert.equal(row!.processing_error, "extract: Source body unavailable: empty_body");
    const wait = new Date(row!.processing_retry_at).getTime() - Date.now();
    assert.ok(wait > 9 * 60_000 && wait <= 10 * 60_000, "the existing ten-minute retry delay must survive the one-shot run");
    assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=${articleId}`).length, 0);
    // The next daily run is due later; do not wait for wall-clock backoff in the fixture.
    await sql`UPDATE articles SET processing_retry_at=now()-interval '1 minute' WHERE id=${articleId}`;
  }
  assert.equal(await production.extract(articleId), "unconfirmed");
  const [row] = await sql`SELECT body_status,processing_attempts,processing_retry_at,processing_attempt_tag,excerpt
    FROM articles WHERE id=${articleId}`;
  assert.deepEqual({ ...row }, { body_status: "unconfirmed", processing_attempts: 0, processing_retry_at: null,
    processing_attempt_tag: attemptTag, excerpt: "The original feed summary." });
  const [job] = await sql`SELECT data FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=${articleId}`;
  assert.deepEqual(job!.data, { articleId, attemptTag });
  assert.equal(hits, 3);
  assert.deepEqual(await production.process(articleId, attemptTag), { state: "awaiting-source" });
  const [stopped] = await sql`SELECT processing_state,processing_error,processing_retry_at,processing_queued_at,processing_attempt_tag FROM articles WHERE id=${articleId}`;
  assert.deepEqual({ ...stopped }, { processing_state: "failed", processing_error: "awaiting-source: empty_body", processing_retry_at: null,
    processing_queued_at: null, processing_attempt_tag: attemptTag });
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id=${articleId}`).length, 0);
  assert.equal((await sql`SELECT 1 FROM receipts`).length, 0, "missing optional credentials must not start any paid request");
});

test("a later readable page resets extraction retry state and queues analysis without buying a model call", async () => {
  readable = true;
  const { articleId } = await upsertMaterial({ sourceId, url: `${base}/recovered`, title: "Agent release", via: "fetch", publishedAt: new Date() });
  await sql`UPDATE articles SET processing_attempts=2,processing_retry_at=now()-interval '1 minute' WHERE id=${articleId}`;
  assert.deepEqual(await processExtraction(articleId), { state: "ok" });
  const [row] = await sql`SELECT body_status,processing_attempts,processing_retry_at FROM articles WHERE id=${articleId}`;
  assert.deepEqual({ ...row }, { body_status: "ok", processing_attempts: 0, processing_retry_at: null });
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=${articleId}`).length, 1);
  assert.equal((await sql`SELECT 1 FROM receipts`).length, 0);
});

test("shared extraction ignores an article that no longer exists", async () => {
  assert.deepEqual(await processExtraction(`missing-${tag()}`), { state: "missing" });
});

test("an access challenge stays distinguishable from low-quality news and cannot buy a score", async () => {
  const { articleId } = await upsertMaterial({ sourceId, url: `${base}/challenge`, title: "Agent release behind a challenge", excerpt: "A feed summary, not the full article.", via: "fetch", publishedAt: new Date() });
  for (const expected of ["retrying", "retrying", "unconfirmed"]) assert.equal(await production.extract(articleId), expected);
  const [extracted] = await sql`SELECT processing_error FROM articles WHERE id=${articleId}`;
  assert.equal(extracted!.processing_error, "extract: Source body unavailable: access_challenge (HTTP 403)");
  assert.deepEqual(await production.process(articleId), { state: "awaiting-source" });
  assert.deepEqual(await production.process(articleId), { state: "awaiting-source" }, "repeated processing preserves the diagnosis without a paid retry");
  const [row] = await sql`SELECT processing_state,processing_error FROM articles WHERE id=${articleId}`;
  assert.deepEqual({ ...row }, { processing_state: "failed", processing_error: "awaiting-source: access_challenge" });
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id=${articleId}`).length, 0);
  assert.equal((await sql`SELECT 1 FROM receipts`).length, 0);
});

test("legacy unconfirmed failures are safely classified without copying their original error", async () => {
  const { articleId } = await upsertMaterial({ sourceId, url: `${base}/legacy`, title: "Article with missing evidence", excerpt: "Feed summary", via: "fetch", bodyStatus: "unconfirmed", publishedAt: new Date() });
  await sql`UPDATE articles SET processing_error='old provider error with private details' WHERE id=${articleId}`;
  assert.deepEqual(await production.process(articleId), { state: "awaiting-source" });
  assert.equal((await sql`SELECT processing_error FROM articles WHERE id=${articleId}`)[0]!.processing_error, "awaiting-source: unconfirmed");
  assert.equal((await sql`SELECT 1 FROM receipts`).length, 0);
});

test("an audited review of a body-less legacy score preserves completed receipts and analysis history", async () => {
  const { articleId } = await upsertMaterial({ sourceId, url: `${base}/old-score`, title: "Previously scored summary", excerpt: "Feed summary", via: "fetch", bodyStatus: "unconfirmed", publishedAt: new Date() });
  const [receipt] = await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status,response)
    VALUES (${`legacy-${tag()}`},'fixture','score_article',${`article:${articleId}@1`},'completed','{"attentionScore":18}') RETURNING *`;
  const [analysis] = await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,score,selected,receipt_ids)
    VALUES (${articleId},1,'model','pass',18,false,${[receipt!.id]}) RETURNING *`;
  const requestId = `source-review-${tag()}`;
  await rerun(articleId, "analyze", requestId, "test");
  assert.deepEqual(await production.process(articleId, `admin:${requestId}`), { state: "awaiting-source" });
  assert.deepEqual((await sql`SELECT * FROM receipts WHERE id=${receipt!.id}`)[0], receipt);
  assert.deepEqual([...(await sql`SELECT * FROM analyses WHERE article_id=${articleId}`)], [analysis]);
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject=${`content:${articleId}`} AND request_id=${requestId}`).length, 1);
});

test("a complete feed body still reaches the normal model pipeline without page extraction", async () => {
  const provider = await stub(() => ({ choices: [{ message: { content: JSON.stringify({ label: "BLOCK", reason: "local fixture" }) } }] }));
  pointModels(provider.url);
  try {
    const { articleId } = await upsertMaterial({ sourceId, url: `${base}/full-feed`, title: "Complete feed article", bodyText: body,
      bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
    const beforeHits = hits;
    assert.deepEqual(await production.process(articleId), { state: "block" });
    assert.equal(provider.hits(), 1);
    assert.equal(hits, beforeHits);
    assert.equal((await sql`SELECT processing_error FROM articles WHERE id=${articleId}`)[0]!.processing_error, null);
  } finally { await provider.close(); }
});
