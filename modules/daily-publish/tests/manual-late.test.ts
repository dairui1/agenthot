import "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { PRESETS } from "@aihot/site/models";
import { SELECTION } from "@aihot/industry/selection";

for (const name of ["COLLECT_ENABLED", "MODEL_CALLS_ENABLED", "FEISHU_CONTENT_PUSH_ENABLED", "FEISHU_INTERNAL_ENABLED", "INDEXNOW_SUBMIT_ENABLED", "AGENTLAB_SYNC_ENABLED"]) process.env[name] = "false";
for (const preset of Object.values(PRESETS)) {
  delete process.env[preset.baseUrlEnv];
  delete process.env[preset.apiKeyEnv];
}
delete process.env.EMBEDDING_API_KEY;
delete process.env.JINA_API_KEY;
process.env.AIHOT_RELEASE = "a".repeat(40);

const { sql, closeDb } = await import("@aihot/backend/db");
const { stopBoss } = await import("@aihot/backend/jobs/queue");
const { upsertMaterial } = await import("@aihot/backend/content/materials");
const { publishArticle } = await import("@aihot/backend/publication/publish");
const { SOURCE_ALLOWLIST } = await import("../production.ts");
const { ManualLateManifest, checkManualLate, publishManualLate, PUBLICATION_NOTE } = await import("../manual-late.ts");

const KEY = "2026-10-17";
const START = "2026-10-16T00:00:00.000Z";
const END = "2026-10-17T00:00:00.000Z";
const AT = new Date("2026-10-16T23:00:00.000Z");
const RELEASED = new Date("2026-10-16T23:10:00.000Z");
const LATE = new Date("2026-10-17T01:31:00.000Z");
const UNKNOWN = ["fa4v2t1os1og6k7au99b4kp7l", "c2udksc6ittp9jga39hq6d1nt", "er0v5nwjtmc6lefxmyu9aigoe",
  "l1rrm674p9ghgitgg0w5qgo0z", "h7svk7xf8x5jx323k33gvlaa0", "jpvwg7bmbd5s3nnog7qg4l1v9", "zpys85vwpodowuem77h4p8m4k"];
const BODY = ["w3xktocf7ss3wftrzrypts5ua", "dtfjim8c741us6k11a7piyp2e", "bofvckacxyk65enbm8htlyjct", "gn3aqpl5riltkgpf7im4h2gh0"];
const EXCLUDED = [...UNKNOWN, ...BODY];
const SOURCES = [...SOURCE_ALLOWLIST].sort();
const SOURCE = SOURCES[0]!;
type Manifest = ReturnType<typeof ManualLateManifest.parse>;
let fixture: { manifest: Manifest; selected: string; lowScore: string };
let fetchCalls = 0;

async function judged(label: string, selected: boolean) {
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/manual-late/${label}`,
    title: `Manual late ${label}`, bodyText: `Verified fixture material ${label}`, bodyStatus: "ok", via: "fetch",
    publishedAt: AT, discoveredAt: AT });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, created_at)
    VALUES (${articleId}, 1, 'rule', 'pass', 'industry', ${`Title ${label}`}, ${`Summary ${label}`}, ${selected ? 90 : 25}, ${selected}, ${AT})`;
  await sql`UPDATE article_revisions SET created_at=${AT} WHERE article_id=${articleId}`;
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id=${articleId}`;
  const published = await publishArticle(articleId, { now: RELEASED, releasedAt: RELEASED });
  assert.equal(published?.selected, selected);
  return articleId;
}

async function seed() {
  assert.equal(SOURCES.length, 18);
  await sql`TRUNCATE sources, articles, receipts, reports, job_runs, audit_log RESTART IDENTITY CASCADE`;
  for (const id of SOURCES) {
    await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, health, created_at, last_ok_at)
      VALUES (${id}, ${`Fixture ${id}`}, ${id.startsWith("json-") ? "json_list" : "rss"}, 'T1', 'editorial', true, 'ok',
        '2026-10-01T00:00:00Z', '2026-10-16T22:33:00Z')`;
  }
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('codex-cli', 12, 60, 120)
    ON CONFLICT (service) DO UPDATE SET per_minute=12, per_hour=60, per_day=120`;
  const detail = { phase: "collect", status: "incomplete", collectionVerified: false,
    collected: SOURCES.map(sourceId => ({ sourceId, status: "ok", found: 2, created: 0, revised: 0 })),
    processed: UNKNOWN.map(id => ({ id, state: "unknown-receipt" })), remaining: { total: 11 }, report: null };
  await sql`INSERT INTO job_runs (id, job, status, started_at, finished_at, detail)
    VALUES (11, 'agenthot.daily-collect', 'failed', '2026-10-16T22:30:00Z', '2026-10-16T23:00:00Z', ${sql.json(detail)})`;
  for (const id of SOURCES) {
    await sql`INSERT INTO fetch_runs (source_id, status, started_at, finished_at, found_count, new_count, detail)
      VALUES (${id}, 'ok', '2026-10-16T22:32:00Z', '2026-10-16T22:33:00Z', 2, 0, '{"httpStatus":200}')`;
  }
  for (const [index, id] of EXCLUDED.entries()) {
    const unknown = index < UNKNOWN.length;
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, revision, discovered_at, timeline_at,
      published_at, body_status, body_text, processing_state, processing_attempts, processing_error)
      VALUES (${id}, ${SOURCE}, ${`manual-late:${id}`}, ${`https://example.com/manual-late/${id}`}, ${`Excluded ${index}`}, 1,
        ${AT}, ${AT}, ${AT}, ${unknown ? "ok" : "pending"}, ${unknown ? "Confirmed fixture body" : null},
        ${unknown ? "failed" : "new"}, ${unknown ? 0 : 1},
        ${unknown ? `receipt ${97 + index} outcome unknown` : "extract: Source body unavailable: access_denied (HTTP 403)"})`;
    await sql`INSERT INTO article_revisions (article_id, revision, title, created_at)
      VALUES (${id}, 1, ${`Excluded ${index}`}, '2026-10-16T22:00:00Z')`;
    if (unknown) {
      await sql`INSERT INTO receipts (id, logical_key, service, model, purpose, subject, status, attempts, created_at)
        VALUES (${97 + index}, ${`fixture-unknown-${index}`}, 'codex-cli', 'gpt-6.1-sol', 'prefilter_article',
          ${`article:${id}@1`}, 'unknown', 1, '2026-10-16T22:44:24Z')`;
      await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status, latency_ms, started_at, finished_at)
        VALUES (${97 + index}, 1, 'codex-cli', 'gpt-6.1-sol', 'unknown', 120000, '2026-10-16T22:44:24Z', '2026-10-16T22:46:24Z')`;
    }
  }
  const selected = await judged("selected", true);
  const lowScore = await judged("low-score", false);
  const manifest = await sql.begin(async tx => {
    await tx`SET LOCAL timezone='UTC'`;
    const [job] = await tx`SELECT encode(sha256(convert_to(detail::text,'UTF8')),'hex') AS hash FROM job_runs WHERE id=11`;
    const [sources] = await tx`SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_object('id',id,'enabled',enabled,'kind',kind,
      'participationMode',participation_mode,'health',health,'lastOkAt',last_ok_at,'createdAt',created_at) ORDER BY id)::text,'UTF8')),'hex') AS hash
      FROM sources WHERE id=ANY(${SOURCES}::text[])`;
    const fetches = await tx`SELECT id, source_id AS "sourceId", encode(sha256(convert_to(jsonb_build_object('id',id,
      'sourceId',source_id,'status',status,'startedAt',started_at,'finishedAt',finished_at,'foundCount',found_count,
      'newCount',new_count,'detail',detail)::text,'UTF8')),'hex') AS "evidenceHash" FROM fetch_runs ORDER BY source_id`;
    const bodies = await tx`SELECT id, encode(sha256(convert_to(jsonb_build_object('processingError',processing_error,
      'bodyText',body_text,'bodyStatus',body_status,'processingState',processing_state,
      'processingAttempts',processing_attempts,'revision',revision)::text,'UTF8')),'hex') AS hash
      FROM articles WHERE id=ANY(${BODY}::text[]) ORDER BY id`;
    return ManualLateManifest.parse({ version: 1, requestId: `fixture-${randomUUID()}`, expectedRelease: process.env.AIHOT_RELEASE,
      key: KEY, windowStart: START, windowEnd: END, actor: "user-approved-operator",
      reason: "User-approved fixture exclusion of seven unresolved outcomes and four inaccessible bodies; no new model requests.",
      collection: { jobId: 11, detailHash: job!.hash, sourcesHash: sources!.hash, sourceIds: SOURCES, fetches },
      exclusions: [...UNKNOWN.map((articleId, index) => ({ articleId, revision: 1, kind: "unknown", receiptId: 97 + index })),
        ...bodies.map(row => ({ articleId: row.id, revision: 1, kind: "body-403", evidenceHash: row.hash }))] });
  });
  return { manifest, selected, lowScore };
}

beforeEach(async () => {
  fetchCalls = 0;
  mock.method(globalThis, "fetch", async () => { fetchCalls++; throw new Error("Manual late must not call the network"); });
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-17T04:00:00Z") });
  fixture = await seed();
});
afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
  assert.equal(fetchCalls, 0, "No provider or collection request is permitted");
});
after(async () => { await stopBoss(); await closeDb(); });

async function preservedState() {
  const [state] = await sql`SELECT
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM articles a WHERE id=ANY(${EXCLUDED}::text[])) AS articles,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM receipts r) AS receipts,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM receipt_attempts t) AS attempts,
    (SELECT jsonb_agg(to_jsonb(b) ORDER BY service) FROM budgets b) AS budgets,
    (SELECT to_jsonb(j) FROM job_runs j WHERE id=11) AS collection`;
  return state;
}

async function counts() {
  const [row] = await sql`SELECT (SELECT count(*)::int FROM reports) AS reports,
    (SELECT count(*)::int FROM report_revisions) AS revisions,
    (SELECT count(*)::int FROM audit_log) AS audits,
    (SELECT count(*)::int FROM job_runs WHERE job='agenthot.daily-manual-late') AS jobs`;
  return row;
}

test("check and late publication preserve eleven failures, all receipts, budgets and editorial selection", async () => {
  const before = await preservedState();
  const selection = structuredClone(SELECTION);
  const checked = await checkManualLate(fixture.manifest);
  assert.equal(checked.status, "ready");
  assert.ok(checked.mainCount > 0);
  assert.deepEqual(await counts(), { reports: 0, revisions: 0, audits: 0, jobs: 0 });
  assert.deepEqual(await preservedState(), before);
  const result = await publishManualLate(fixture.manifest, checked.planHash);
  assert.equal(result.status, "published");
  assert.deepEqual(await preservedState(), before);
  assert.deepEqual(SELECTION, selection);
  const [report] = await sql`SELECT id, revision, origin, window_start, window_end, content FROM reports WHERE kind='daily' AND key=${KEY}`;
  assert.equal(report!.revision, 1);
  assert.equal(report!.origin, "manual");
  assert.equal(report!.window_start.toISOString(), START);
  assert.equal(report!.window_end.toISOString(), END);
  assert.equal(report!.content.publicationNote, PUBLICATION_NOTE);
  const itemIds = [...report!.content.sections.flatMap((section: { items: Array<{ itemId: string }> }) => section.items), ...report!.content.flashes].map((item: { itemId: string }) => item.itemId);
  assert.ok(itemIds.includes(fixture.selected));
  assert.ok(!itemIds.includes(fixture.lowScore));
  assert.ok(EXCLUDED.every(id => !itemIds.includes(id)));
  const [audit] = await sql`SELECT actor, action, subject, reason, after, request_id FROM audit_log`;
  const [job] = await sql`SELECT id, status, detail FROM job_runs WHERE job='agenthot.daily-manual-late'`;
  assert.equal(audit!.actor, fixture.manifest.actor);
  assert.equal(audit!.action, "report.manual-late");
  assert.equal(audit!.request_id, fixture.manifest.requestId);
  assert.equal(audit!.after.reportId, report!.id);
  assert.equal(audit!.after.runId, job!.id);
  assert.equal(audit!.after.planHash, checked.planHash);
  assert.equal(job!.status, "ok");
  assert.equal(job!.detail.reportId, report!.id);
  assert.deepEqual(await counts(), { reports: 1, revisions: 0, audits: 1, jobs: 1 });
});

test("same manifest and approval replay does not create a new job, audit or report revision", async () => {
  const checked = await checkManualLate(fixture.manifest);
  await publishManualLate(fixture.manifest, checked.planHash);
  const before = await counts();
  const [saved] = await sql`SELECT to_jsonb(r) AS row FROM reports r WHERE kind='daily' AND key=${KEY}`;
  const repeated = await publishManualLate(fixture.manifest, checked.planHash);
  assert.equal(repeated.status, "already-published");
  assert.deepEqual(await counts(), before);
  const [after] = await sql`SELECT to_jsonb(r) AS row FROM reports r WHERE kind='daily' AND key=${KEY}`;
  assert.deepEqual(after, saved);
});

test("concurrent publishers cannot commit two jobs or revisions for the same approved plan", async () => {
  const checked = await checkManualLate(fixture.manifest);
  const results = await Promise.allSettled([
    publishManualLate(fixture.manifest, checked.planHash),
    publishManualLate(fixture.manifest, checked.planHash),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled" && result.value.status === "published").length, 1);
  assert.deepEqual(await counts(), { reports: 1, revisions: 0, audits: 1, jobs: 1 });
  const replay = await publishManualLate(fixture.manifest, checked.planHash);
  assert.equal(replay.status, "already-published");
  assert.deepEqual(await counts(), { reports: 1, revisions: 0, audits: 1, jobs: 1 });
});

test("audit insertion failure rolls report and manual job back in the same transaction", async () => {
  const checked = await checkManualLate(fixture.manifest);
  const before = await preservedState();
  await sql`ALTER TABLE audit_log ADD CONSTRAINT manual_late_test_reject CHECK (false) NOT VALID`;
  try {
    await assert.rejects(publishManualLate(fixture.manifest, checked.planHash));
  } finally {
    await sql`ALTER TABLE audit_log DROP CONSTRAINT manual_late_test_reject`;
  }
  assert.deepEqual(await counts(), { reports: 0, revisions: 0, audits: 0, jobs: 0 });
  assert.deepEqual(await preservedState(), before);
});

test("an existing ordinary issue is never replaced by the incident override", async () => {
  const checked = await checkManualLate(fixture.manifest);
  await sql`INSERT INTO reports (kind,key,window_start,window_end,content,generated_at,origin)
    VALUES ('daily',${KEY},${START},${END},'{"fixture":"existing"}',now(),'imported')`;
  const [before] = await sql`SELECT to_jsonb(r) AS row FROM reports r`;
  await assert.rejects(checkManualLate(fixture.manifest), /already exists/);
  await assert.rejects(publishManualLate(fixture.manifest, checked.planHash), /already exists/);
  const [after] = await sql`SELECT to_jsonb(r) AS row FROM reports r`;
  assert.deepEqual(after, before);
  assert.deepEqual(await counts(), { reports: 1, revisions: 0, audits: 0, jobs: 0 });
});

for (const field of ["revision", "body", "source", "job", "fetch", "receipt", "attempt", "candidate"] as const) {
  test(`changed ${field} evidence invalidates a previously approved plan without writes`, async () => {
    const checked = await checkManualLate(fixture.manifest);
    if (field === "revision") await sql`UPDATE articles SET revision=2 WHERE id=${UNKNOWN[0]!}`;
    if (field === "body") await sql`UPDATE articles SET processing_attempts=2 WHERE id=${BODY[0]!}`;
    if (field === "source") await sql`UPDATE sources SET last_ok_at=last_ok_at + interval '1 second' WHERE id=${SOURCE}`;
    if (field === "job") await sql`UPDATE job_runs SET detail=detail || '{"changed":true}'::jsonb WHERE id=11`;
    if (field === "fetch") await sql`UPDATE fetch_runs SET new_count=1 WHERE id=${fixture.manifest.collection.fetches[0]!.id}`;
    if (field === "receipt") await sql`UPDATE receipts SET status='failed' WHERE id=97`;
    if (field === "attempt") await sql`UPDATE receipt_attempts SET status='failed' WHERE receipt_id=97`;
    if (field === "candidate") await sql`UPDATE publications SET summary='Changed after operator approval' WHERE article_id=${fixture.selected}`;
    const before = await preservedState();
    await assert.rejects(publishManualLate(fixture.manifest, checked.planHash), /Manual late refused/);
    assert.deepEqual(await counts(), { reports: 0, revisions: 0, audits: 0, jobs: 0 });
    assert.deepEqual(await preservedState(), before);
  });
}

for (const changed of ["analysis revision", "analysis missing", "revision missing", "grouping missing", "grouping incomplete"] as const) {
  test(`a candidate with ${changed} cannot be represented as ready before cutoff`, async () => {
    const checked = await checkManualLate(fixture.manifest);
    if (changed === "analysis revision") await sql`UPDATE analyses SET input_revision=0 WHERE article_id=${fixture.selected}`;
    if (changed === "analysis missing") await sql`UPDATE publications SET analysis_id=NULL WHERE article_id=${fixture.selected}`;
    if (changed === "revision missing") await sql`DELETE FROM article_revisions WHERE article_id=${fixture.selected}`;
    if (changed === "grouping missing") await sql`UPDATE articles SET grouped_at=NULL WHERE id=${fixture.selected}`;
    if (changed === "grouping incomplete") await sql`UPDATE articles SET grouping_status='pending' WHERE id=${fixture.selected}`;
    await assert.rejects(checkManualLate(fixture.manifest), /Manual late refused/);
    await assert.rejects(publishManualLate(fixture.manifest, checked.planHash), /Manual late refused/);
    assert.deepEqual(await counts(), { reports: 0, revisions: 0, audits: 0, jobs: 0 });
  });
}

async function moveEvidenceToCutoff(kind: "analysis" | "grouping" | "revision", id: string) {
  if (kind === "analysis") await sql`UPDATE analyses SET created_at=${END}::timestamptz WHERE article_id=${id}`;
  if (kind === "grouping") await sql`UPDATE articles SET grouped_at=${END}::timestamptz WHERE id=${id}`;
  if (kind === "revision") await sql`UPDATE article_revisions SET created_at=${END}::timestamptz WHERE article_id=${id}`;
}

for (const kind of ["analysis", "grouping", "revision"] as const) {
  test(`a late ${kind} excludes its event while other verified content keeps the original window`, async () => {
    const safe = await judged(`safe-${kind}`, true);
    const before = await checkManualLate(fixture.manifest);
    await moveEvidenceToCutoff(kind, fixture.selected);
    const checked = await checkManualLate(fixture.manifest);
    assert.notEqual(checked.planHash, before.planHash);
    assert.deepEqual(checked.temporalExclusions, { articles: 1, events: 1 });
    assert.deepEqual(checked.exclusions, { unknown: 7, bodyUnavailable: 4 });
    assert.deepEqual(checked.items.map(item => item.id), [safe]);
    assert.match(checked.publicationNote, /截稿后完成或修订/);
    const unchanged = await preservedState();
    await assert.rejects(publishManualLate(fixture.manifest, before.planHash), /approved plan changed/);
    assert.deepEqual(await counts(), { reports: 0, revisions: 0, audits: 0, jobs: 0 });
    await publishManualLate(fixture.manifest, checked.planHash);
    const [report] = await sql`SELECT content, window_start, window_end FROM reports WHERE kind='daily' AND key=${KEY}`;
    assert.equal(report!.window_start.toISOString(), START);
    assert.equal(report!.window_end.toISOString(), END);
    assert.equal(report!.content.metrics.totalEvents, 1);
    assert.equal(report!.content.leadItemId, safe);
    assert.equal(report!.content.publicationNote, checked.publicationNote);
    assert.equal(report!.content.generator.temporalExcludedArticles, 1);
    assert.equal(report!.content.generator.temporalExcludedEvents, 1);
    const [audit] = await sql`SELECT after FROM audit_log WHERE request_id=${fixture.manifest.requestId}`;
    assert.deepEqual(audit!.after.temporalExcluded[0].articleIds, [fixture.selected]);
    assert.equal(audit!.after.temporalExcluded[0].candidates[0].id, fixture.selected);
    const admitted = audit!.after.candidateEvidence.find((item: { id: string }) => item.id === safe);
    assert.equal(admitted.revised_at, AT.toISOString());
    assert.equal(admitted.analyzed_at, AT.toISOString());
    assert.equal(admitted.grouped_at, RELEASED.toISOString());
    const [job] = await sql`SELECT detail FROM job_runs WHERE job='agenthot.daily-manual-late'`;
    assert.deepEqual(job!.detail.temporalExclusions, checked.temporalExclusions);
    assert.deepEqual(job!.detail.temporalExcludedIds, [fixture.selected]);
    assert.deepEqual(await preservedState(), unchanged);
  });

  test(`all events beyond the ${kind} cutoff refuse publication instead of creating a quiet issue`, async () => {
    const checked = await checkManualLate(fixture.manifest);
    await moveEvidenceToCutoff(kind, fixture.selected);
    await assert.rejects(checkManualLate(fixture.manifest), /no verified daily entries/);
    await assert.rejects(publishManualLate(fixture.manifest, checked.planHash), /no verified daily entries/);
    assert.deepEqual(await counts(), { reports: 0, revisions: 0, audits: 0, jobs: 0 });
  });
}

test("a post-cutoff current revision is not silently replaced by its earlier eligible analysis", async () => {
  const safe = await judged("safe-revision-change", true);
  const approved = await checkManualLate(fixture.manifest);
  const changed = await upsertMaterial({ sourceId: SOURCE, url: "https://example.com/manual-late/selected",
    title: "Manual late selected revision two", bodyText: "Material changed after the original daily cutoff", bodyStatus: "ok",
    via: "fetch", publishedAt: AT, discoveredAt: LATE });
  assert.equal(changed.articleId, fixture.selected);
  assert.equal(changed.revised, true);
  await sql`UPDATE article_revisions SET created_at=${LATE} WHERE article_id=${fixture.selected} AND revision=2`;
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected,created_at)
    VALUES (${fixture.selected},2,'rule','pass','industry','Current revision title','Current revision summary',90,true,${LATE})`;
  await sql`UPDATE articles SET processing_state='analyzed',grouping_status='complete',grouped_at=${LATE} WHERE id=${fixture.selected}`;
  await publishArticle(fixture.selected, { now: LATE, releasedAt: RELEASED });
  await assert.rejects(publishManualLate(fixture.manifest, approved.planHash), /approved plan changed/);
  const checked = await checkManualLate(fixture.manifest);
  assert.notEqual(checked.planHash, approved.planHash);
  assert.deepEqual(checked.temporalExclusions, { articles: 1, events: 1 });
  assert.deepEqual(checked.items.map(item => item.id), [safe]);
  await publishManualLate(fixture.manifest, checked.planHash);
  const [report] = await sql`SELECT content FROM reports WHERE kind='daily' AND key=${KEY}`;
  assert.equal(report!.content.leadItemId, safe);
  const [current] = await sql`SELECT revision FROM articles WHERE id=${fixture.selected}`;
  assert.equal(current!.revision, 2);
});

test("one late related report removes its whole event instead of retaining the timely representative", async () => {
  const related = await judged("late-related", true);
  const safe = await judged("safe-other-event", true);
  const [fact] = await sql`INSERT INTO facts (public_id,title,created_at) VALUES (${`manual-late-${randomUUID()}`},'Shared event',${AT}) RETURNING id`;
  for (const id of [fixture.selected, related]) {
    await sql`INSERT INTO fact_articles (fact_id,article_id,role,created_at) VALUES (${fact!.id},${id},'report',${AT})`;
    await publishArticle(id, { now: RELEASED, releasedAt: RELEASED });
  }
  const before = await checkManualLate(fixture.manifest);
  assert.equal(before.mainCount, 2);
  await moveEvidenceToCutoff("analysis", related);
  const checked = await checkManualLate(fixture.manifest);
  assert.deepEqual(checked.temporalExclusions, { articles: 2, events: 1 });
  assert.deepEqual(checked.temporalExcludedIds, [fixture.selected, related].sort());
  assert.deepEqual(checked.items.map(item => item.id), [safe]);
  await publishManualLate(fixture.manifest, checked.planHash);
  const [report] = await sql`SELECT content FROM reports WHERE kind='daily' AND key=${KEY}`;
  assert.equal(report!.content.metrics.totalEvents, 1);
  assert.ok(!JSON.stringify(report!.content).includes(fixture.selected));
  assert.ok(!JSON.stringify(report!.content).includes(related));
});

test("late background coverage removes its event even when the late report is not selected", async () => {
  const safe = await judged("safe-background-event", true);
  const [fact] = await sql`INSERT INTO facts (public_id,title,created_at) VALUES (${`manual-late-${randomUUID()}`},'Covered event',${AT}) RETURNING id`;
  for (const id of [fixture.selected, fixture.lowScore]) {
    await sql`INSERT INTO fact_articles (fact_id,article_id,role,created_at) VALUES (${fact!.id},${id},'report',${AT})`;
    await publishArticle(id, { now: RELEASED, releasedAt: RELEASED });
  }
  const before = await checkManualLate(fixture.manifest);
  assert.equal(before.mainCount, 2);
  assert.ok(!before.items.some(item => item.id === fixture.lowScore));
  await moveEvidenceToCutoff("analysis", fixture.lowScore);
  const checked = await checkManualLate(fixture.manifest);
  assert.deepEqual(checked.temporalExclusions, { articles: 1, events: 1 });
  assert.deepEqual(checked.items.map(item => item.id), [safe]);
  await assert.rejects(publishManualLate(fixture.manifest, before.planHash), /approved plan changed/);
  await publishManualLate(fixture.manifest, checked.planHash);
  const [audit] = await sql`SELECT after FROM audit_log WHERE request_id=${fixture.manifest.requestId}`;
  assert.ok(audit!.after.temporalExcluded[0].support.some((item: { article_id: string }) => item.article_id === fixture.lowScore));
  const support = audit!.after.backgroundEvidence.find((item: { article_id: string }) => item.article_id === fixture.lowScore);
  assert.equal(support.analyzed_at, END);
  assert.equal(support.revised_at, AT.toISOString());
  assert.equal(support.linked_at, AT.toISOString());
});

test("an unresolved historical background receipt cannot contribute coverage to the manual issue", async () => {
  const [fact] = await sql`INSERT INTO facts (public_id,title,created_at) VALUES (${`manual-late-${randomUUID()}`},'Historical coverage',${AT}) RETURNING id`;
  for (const id of [fixture.selected, fixture.lowScore]) {
    await sql`INSERT INTO fact_articles (fact_id,article_id,role,created_at) VALUES (${fact!.id},${id},'report',${AT})`;
    await publishArticle(id, { now: RELEASED, releasedAt: RELEASED });
  }
  const checked = await checkManualLate(fixture.manifest);
  await sql`INSERT INTO receipts (logical_key,service,model,purpose,subject,status,attempts,created_at)
    VALUES ('historical-background','codex-cli','gpt-6.1-sol','score_article',${`article:${fixture.lowScore}`},
      'unknown',1,'2026-10-16T22:00:00Z')`;
  await assert.rejects(checkManualLate(fixture.manifest), /background has unresolved evidence/);
  await assert.rejects(publishManualLate(fixture.manifest, checked.planHash), /background has unresolved evidence/);
  assert.deepEqual(await counts(), { reports: 0, revisions: 0, audits: 0, jobs: 0 });
});

for (const changed of ["content", "window", "revision", "manifest"] as const) {
  test(`replay refuses changed ${changed} rather than returning a false successful receipt`, async () => {
    const checked = await checkManualLate(fixture.manifest);
    await publishManualLate(fixture.manifest, checked.planHash);
    const value = structuredClone(fixture.manifest);
    if (changed === "content") await sql`UPDATE reports SET content=content || '{"tampered":true}'::jsonb WHERE key=${KEY}`;
    if (changed === "window") await sql`UPDATE reports SET window_end=window_end + interval '1 second' WHERE key=${KEY}`;
    if (changed === "revision") await sql`UPDATE reports SET revision=revision+1 WHERE key=${KEY}`;
    if (changed === "manifest") value.reason += " Changed after approval.";
    const before = await counts();
    const [report] = await sql`SELECT to_jsonb(r) AS row FROM reports r WHERE kind='daily' AND key=${KEY}`;
    await assert.rejects(publishManualLate(value, checked.planHash), /request identity conflict/);
    assert.deepEqual(await counts(), before);
    const [after] = await sql`SELECT to_jsonb(r) AS row FROM reports r WHERE kind='daily' AND key=${KEY}`;
    assert.deepEqual(after, report);
  });
}

test("new unresolved material outside the approved eleven still blocks publication", async () => {
  const checked = await checkManualLate(fixture.manifest);
  await upsertMaterial({ sourceId: SOURCE, url: "https://example.com/manual-late/new-debt", title: "New unresolved material",
    bodyText: "Unjudged new evidence", bodyStatus: "ok", via: "fetch", publishedAt: AT, discoveredAt: AT });
  await assert.rejects(publishManualLate(fixture.manifest, checked.planHash), /unfinished material/);
  assert.deepEqual(await counts(), { reports: 0, revisions: 0, audits: 0, jobs: 0 });
});

test("an additional unknown receipt is not covered by the existing seven exclusions", async () => {
  const checked = await checkManualLate(fixture.manifest);
  await sql`INSERT INTO receipts (logical_key, service, model, purpose, subject, status, attempts)
    VALUES ('additional-unknown', 'codex-cli', 'gpt-6.1-sol', 'score_article', ${`article:${UNKNOWN[0]}@1`}, 'unknown', 1)`;
  await assert.rejects(publishManualLate(fixture.manifest, checked.planHash), /unresolved receipt/);
  assert.deepEqual(await counts(), { reports: 0, revisions: 0, audits: 0, jobs: 0 });
});

for (const changed of ["job coverage", "fetch before cutoff", "source unhealthy", "fetch duplicate", "manifest exclusion", "approval"] as const) {
  test(`incomplete or altered ${changed} fails closed`, async () => {
    const checked = await checkManualLate(fixture.manifest);
    const value = structuredClone(fixture.manifest);
    if (changed === "job coverage") {
      await sql`UPDATE job_runs SET detail=jsonb_set(detail,'{collected}',(detail->'collected') - 0) WHERE id=11`;
      const [row] = await sql`SELECT encode(sha256(convert_to(detail::text,'UTF8')),'hex') AS hash FROM job_runs WHERE id=11`;
      value.collection.detailHash = row!.hash;
    }
    if (changed === "fetch before cutoff") {
      const id = value.collection.fetches[0]!.id;
      await sql`UPDATE fetch_runs SET finished_at=${END}::timestamptz WHERE id=${id}`;
      const [row] = await sql`SELECT encode(sha256(convert_to(jsonb_build_object('id',id,'sourceId',source_id,'status',status,
        'startedAt',started_at,'finishedAt',finished_at,'foundCount',found_count,'newCount',new_count,'detail',detail)::text,'UTF8')),'hex') AS hash
        FROM fetch_runs WHERE id=${id}`;
      value.collection.fetches[0]!.evidenceHash = row!.hash;
    }
    if (changed === "source unhealthy") await sql`UPDATE sources SET health='failing' WHERE id=${SOURCE}`;
    if (changed === "fetch duplicate") value.collection.fetches[0] = structuredClone(value.collection.fetches[1]!);
    if (changed === "manifest exclusion") value.exclusions[0]!.articleId = "unapproved-id";
    await assert.rejects(publishManualLate(value, changed === "approval" ? "b".repeat(64) : checked.planHash));
    assert.deepEqual(await counts(), { reports: 0, revisions: 0, audits: 0, jobs: 0 });
  });
}

for (const job of ["agenthot.daily-collect", "agenthot.daily-publish", "agenthot.daily-manual-late"]) {
  test(`an active ${job} prevents concurrent manual publication`, async () => {
    const checked = await checkManualLate(fixture.manifest);
    await sql`INSERT INTO job_runs (job, status) VALUES (${job}, 'running')`;
    const before = await counts();
    await assert.rejects(checkManualLate(fixture.manifest), /running|active/i);
    await assert.rejects(publishManualLate(fixture.manifest, checked.planHash), /running|active/i);
    assert.deepEqual(await counts(), before);
  });
}
