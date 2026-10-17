// One explicitly approved incident, not a relaxation of the scheduled publication gates.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { EDITION_TIMES } from "@aihot/site";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { addDays, beijingAt } from "@aihot/contracts/time";
import { sql, closeDb, type Tx } from "@aihot/backend/db";
import { audit } from "@aihot/backend/audit";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { installModules } from "@aihot/backend/modules";
import { dailyContent, prepareDaily, saveDailyInTransaction } from "@aihot/backend/reports/compose";
import { currentSignals } from "@aihot/backend/events/hot";
import { evidenceCondition, listedCondition } from "@aihot/backend/publication/scope";

const UNKNOWN = new Map([
  ["fa4v2t1os1og6k7au99b4kp7l", 97], ["c2udksc6ittp9jga39hq6d1nt", 98],
  ["er0v5nwjtmc6lefxmyu9aigoe", 99], ["l1rrm674p9ghgitgg0w5qgo0z", 100],
  ["h7svk7xf8x5jx323k33gvlaa0", 101], ["jpvwg7bmbd5s3nnog7qg4l1v9", 102], ["zpys85vwpodowuem77h4p8m4k", 103],
]);
const BODY = new Set(["w3xktocf7ss3wftrzrypts5ua", "dtfjim8c741us6k11a7piyp2e", "bofvckacxyk65enbm8htlyjct", "gn3aqpl5riltkgpf7im4h2gh0"]);
const sourceFile = JSON.parse(readFileSync(new URL("../../industry/sources.json", import.meta.url), "utf8")) as { sources: Array<{ id: string; kind: string; participation_mode: string }> };
const SOURCES = sourceFile.sources.filter(s => ["rss", "json_list"].includes(s.kind) && s.participation_mode === "editorial").map(s => s.id).sort();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const exclusion = z.discriminatedUnion("kind", [
  z.object({ articleId: z.string(), revision: z.literal(1), kind: z.literal("unknown"), receiptId: z.number().int() }).strict(),
  z.object({ articleId: z.string(), revision: z.literal(1), kind: z.literal("body-403"), evidenceHash: hash }).strict(),
]);
export const ManualLateManifest = z.object({
  version: z.literal(1), requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/),
  expectedRelease: z.string().regex(/^[a-f0-9]{40}$/), key: z.literal("2026-10-17"),
  windowStart: z.literal("2026-10-16T00:00:00.000Z"), windowEnd: z.literal("2026-10-17T00:00:00.000Z"),
  actor: z.literal("user-approved-operator"), reason: z.string().min(10).max(500),
  collection: z.object({ jobId: z.literal(11), detailHash: hash, sourcesHash: hash,
    sourceIds: z.array(z.string()).length(18),
    fetches: z.array(z.object({ id: z.number().int().positive(), sourceId: z.string(), evidenceHash: hash }).strict()).length(18),
  }).strict(), exclusions: z.array(exclusion).length(11),
}).strict();
type Manifest = z.infer<typeof ManualLateManifest>;
const ACTION = "report.manual-late";
export const PUBLICATION_NOTE = "本期延后发布，仍以北京时间 10 月 17 日 08:00 为截稿时间，仅采用截稿前已通过原有标准的内容。另有 7 项审核结果待核验、4 项正文无法获取，均未纳入本期；截稿后完成或修订的内容亦未纳入，未降低筛选标准。";
function fail(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(`Manual late refused: ${reason}`); }
const equal = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

function validate(value: unknown): Manifest {
  const manifest = ManualLateManifest.parse(value);
  fail(process.env.AIHOT_RELEASE === manifest.expectedRelease, "release mismatch");
  for (const name of ["COLLECT_ENABLED", "MODEL_CALLS_ENABLED", "FEISHU_CONTENT_PUSH_ENABLED", "FEISHU_INTERNAL_ENABLED", "INDEXNOW_SUBMIT_ENABLED"]) {
    fail(process.env[name] === "false", "external-action valves must be closed");
  }
  fail(equal([...manifest.collection.sourceIds].sort(), SOURCES), "source allowlist changed");
  fail(equal(manifest.collection.fetches.map(f => f.sourceId).sort(), SOURCES), "fetch coverage changed");
  fail(new Set(manifest.collection.fetches.map(f => f.id)).size === 18, "duplicate fetch evidence");
  fail(equal(manifest.exclusions.map(e => e.articleId).sort(), [...UNKNOWN.keys(), ...BODY].sort()), "unapproved exclusions");
  for (const item of manifest.exclusions) fail(item.kind === "unknown" ? UNKNOWN.get(item.articleId) === item.receiptId : BODY.has(item.articleId), "exclusion identity changed");
  const start = beijingAt(addDays(manifest.key, -1), EDITION_TIMES.daily), end = beijingAt(manifest.key, EDITION_TIMES.daily);
  fail(start.toISOString() === manifest.windowStart && end.toISOString() === manifest.windowEnd && end.getTime() <= Date.now(), "window mismatch");
  return manifest;
}

async function context(tx: Tx) {
  await tx`SET LOCAL timezone = 'UTC'`;
  await tx`SET LOCAL statement_timeout = '20s'`;
  await tx`SET LOCAL lock_timeout = '5s'`;
  const [lock] = await tx`SELECT pg_try_advisory_xact_lock(hashtext('agenthot.daily-manual-late')) AS held`;
  fail(lock?.held, "another manual publication is active");
  const active = await tx`SELECT id FROM job_runs WHERE status='running'
    AND job IN ('agenthot.daily-collect','agenthot.daily-publish','agenthot.daily-manual-late')`;
  fail(active.length === 0, "another daily operation is active");
}

async function inspect(tx: Tx, manifest: Manifest, lock: boolean) {
  const start = new Date(manifest.windowStart), end = new Date(manifest.windowEnd);
  const locked = lock ? tx`FOR SHARE` : tx``;
  // Article locks precede publication's report_candidates advisory lock, matching its write order.
  const gaps = await tx`SELECT id, revision, source_id, processing_state, grouping_status, body_status, backfill,
    timeline_at, coalesce(body_text,'') = '' AS empty_body, x_post IS NOT NULL AS has_post,
    processing_error ~ '^extract: Source body unavailable: [a-z_]+ [(]HTTP 403[)]$' AS exact_403,
    encode(sha256(convert_to(jsonb_build_object('processingError',processing_error,'bodyText',body_text,
      'bodyStatus',body_status,'processingState',processing_state,'processingAttempts',processing_attempts,'revision',revision)::text,'UTF8')),'hex') AS evidence_hash
    FROM articles WHERE id = ANY(${manifest.exclusions.map(e => e.articleId)}::text[]) ORDER BY id ${locked}`;
  fail(gaps.length === 11, "missing approved material");
  for (const expected of manifest.exclusions) {
    const row = gaps.find(g => g.id === expected.articleId)!;
    fail(row.revision === expected.revision && !row.backfill && row.timeline_at >= start && row.timeline_at < end && SOURCES.includes(row.source_id), "approved material moved");
    fail(["new", "failed"].includes(row.processing_state) && row.grouping_status !== "failed", "approved material state changed");
    if (expected.kind === "body-403") fail(row.body_status === "pending" && row.empty_body && !row.has_post && row.exact_403 && row.evidence_hash === expected.evidenceHash, "body evidence changed");
  }
  const sources = await tx`SELECT id, enabled, kind, participation_mode, health, last_ok_at, created_at
    FROM sources WHERE id = ANY(${SOURCES}::text[]) ORDER BY id ${locked}`;
  fail(sources.length === 18 && sources.every(s => s.enabled && s.health === "ok" && s.participation_mode === "editorial" && ["rss", "json_list"].includes(s.kind)), "sources are not healthy");
  const [sourceHash] = await tx`SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_object('id',id,'enabled',enabled,'kind',kind,
    'participationMode',participation_mode,'health',health,'lastOkAt',last_ok_at,'createdAt',created_at) ORDER BY id)::text,'UTF8')),'hex') AS hash
    FROM sources WHERE id = ANY(${SOURCES}::text[])`;
  fail(sourceHash!.hash === manifest.collection.sourcesHash, "source evidence changed");
  const [job] = await tx`SELECT id, job, status, started_at, finished_at, detail,
    encode(sha256(convert_to(detail::text,'UTF8')),'hex') AS detail_hash FROM job_runs WHERE id = ${manifest.collection.jobId} ${locked}`;
  fail(job && job.job === "agenthot.daily-collect" && job.status === "failed" && job.detail?.collectionVerified === false
    && job.detail_hash === manifest.collection.detailHash && job.started_at >= new Date(end.getTime() - 2 * 3600000)
    && job.finished_at >= job.started_at && job.finished_at < end, "original collection evidence changed");
  fail(equal((job.detail.collected ?? []).filter((s: { status: string }) => s.status === "ok").map((s: { sourceId: string }) => s.sourceId).sort(), SOURCES), "original collection coverage is incomplete");
  const fetches = await tx`SELECT id, source_id, status, started_at, finished_at,
    encode(sha256(convert_to(jsonb_build_object('id',id,'sourceId',source_id,'status',status,'startedAt',started_at,
      'finishedAt',finished_at,'foundCount',found_count,'newCount',new_count,'detail',detail)::text,'UTF8')),'hex') AS evidence_hash
    FROM fetch_runs WHERE id = ANY(${manifest.collection.fetches.map(f => f.id)}::bigint[]) ORDER BY id ${locked}`;
  fail(fetches.length === 18, "missing fetch evidence");
  for (const expected of manifest.collection.fetches) {
    const row = fetches.find(f => f.id === expected.id)!;
    fail(row.source_id === expected.sourceId && row.evidence_hash === expected.evidenceHash && row.status === "ok"
      && row.started_at >= job.started_at && row.finished_at >= row.started_at && row.finished_at <= job.finished_at && row.finished_at < end, "fetch evidence changed");
  }
  const receipts = await tx`SELECT id, service, model, purpose, subject, status, attempts, logical_key, response IS NOT NULL AS has_response
    FROM receipts WHERE id = ANY(${[...UNKNOWN.values()]}::bigint[]) ORDER BY id ${locked}`;
  fail(receipts.length === 7, "missing unknown receipts");
  for (const [id, receiptId] of UNKNOWN) {
    const row = receipts.find(r => r.id === receiptId)!;
    fail(row.subject === `article:${id}@1` && row.status === "unknown" && row.attempts === 1 && !row.has_response
      && row.service === "codex-cli" && row.model === "gpt-6.1-sol" && row.purpose === "prefilter_article", "unknown receipt changed");
  }
  const attempts = await tx`SELECT id, receipt_id, attempt, service, model, origin, status, started_at, finished_at, request_id IS NOT NULL AS has_request_id
    FROM receipt_attempts WHERE receipt_id=ANY(${[...UNKNOWN.values()]}::bigint[]) ORDER BY receipt_id,attempt ${locked}`;
  fail(attempts.length === 7 && attempts.every(a => a.attempt === 1 && a.status === "unknown" && a.origin === "live"
    && a.service === "codex-cli" && a.model === "gpt-6.1-sol" && !a.has_request_id), "unknown attempts changed");
  const pending = await tx`SELECT a.id, a.revision, a.processing_state, a.grouping_status, a.timeline_at,
    ARRAY(SELECT r.id FROM receipts r WHERE r.status IN ('pending','unknown') AND (r.id = a.grouping_receipt_id
      OR r.subject = 'article:' || a.id || '@' || a.revision::text
      OR (substring(r.subject from '^article:([^@:#]+)') = a.id AND r.subject NOT LIKE '%@%'
        AND r.created_at >= coalesce((SELECT created_at FROM article_revisions ar WHERE ar.article_id=a.id AND ar.revision=a.revision),a.created_at))) ORDER BY r.id) AS unresolved
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE NOT a.backfill AND s.participation_mode = 'editorial'
      AND (a.processing_state IN ('new','failed') OR a.grouping_status = 'failed'
        OR (a.processing_state = 'analyzed' AND a.grouping_status <> 'complete'
          AND (SELECT relevance FROM analyses WHERE article_id=a.id ORDER BY input_revision DESC,id DESC LIMIT 1)='pass')) ORDER BY a.id`;
  fail(equal(pending.map(p => p.id), manifest.exclusions.map(e => e.articleId).sort()), "unapproved unfinished material");
  for (const row of pending) fail(equal(row.unresolved, UNKNOWN.has(row.id) ? [UNKNOWN.get(row.id)] : []), "unapproved unresolved receipt");
  const allUnresolved = await tx`SELECT a.id AS article_id, r.id AS receipt_id FROM articles a JOIN sources s ON s.id=a.source_id
    JOIN receipts r ON r.status IN ('pending','unknown') AND (r.id=a.grouping_receipt_id
      OR r.subject='article:' || a.id || '@' || a.revision::text
      OR (substring(r.subject from '^article:([^@:#]+)')=a.id AND r.subject NOT LIKE '%@%'
        AND r.created_at>=coalesce((SELECT created_at FROM article_revisions ar WHERE ar.article_id=a.id AND ar.revision=a.revision),a.created_at)))
    WHERE NOT a.backfill AND s.participation_mode='editorial' ORDER BY a.id,r.id`;
  fail(equal(allUnresolved.map(r => [r.article_id, r.receipt_id]), [...UNKNOWN].sort(([a], [b]) => a.localeCompare(b))), "unapproved unresolved evidence");
  const draft = await prepareDaily(manifest.key, tx);
  fail(draft.entries > 0, "no verified daily entries");
  const ids = [...new Set(draft.edition.entries.flatMap(e => [e.entry.itemId, ...(e.entry.related ?? []).map(r => r.itemId),
    ...(e.entry.identityKeys ?? []).filter(k => k.startsWith("a:")).map(k => k.slice(2))]))].sort();
  fail(!manifest.exclusions.some(e => ids.includes(e.articleId)), "excluded material became a candidate");
  const candidates = await tx`SELECT a.id, a.revision, ar.created_at AS revised_at, a.grouping_status, a.grouped_at, p.analysis_id, p.fact_id,
    an.input_revision, an.created_at AS analyzed_at, an.relevance,
    encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') AS publication_hash
    FROM articles a JOIN publications p ON p.article_id = a.id LEFT JOIN analyses an ON an.id=p.analysis_id
    LEFT JOIN article_revisions ar ON ar.article_id=a.id AND ar.revision=a.revision
    WHERE a.id = ANY(${ids}::text[]) ORDER BY a.id`;
  fail(candidates.length === ids.length, "candidate projection missing");
  const unresolved = await tx`SELECT r.id FROM receipts r JOIN articles a ON
    (r.id=a.grouping_receipt_id OR substring(r.subject from '^article:([^@:#]+)')=a.id)
    WHERE a.id=ANY(${ids}::text[]) AND r.status IN ('pending','unknown')`;
  fail(unresolved.length === 0, "candidate has unresolved evidence");
  const eventIds = (e: typeof draft.edition.entries[number]) => [...new Set([e.entry.itemId,
    ...(e.entry.related ?? []).map(r => r.itemId), ...(e.entry.identityKeys ?? []).filter(k => k.startsWith("a:")).map(k => k.slice(2))])];
  const factIds = [...new Set(candidates.map(c => c.fact_id).filter((id): id is number => id !== null))];
  const storyIds = [...new Set(draft.edition.entries.map(e => e.storyId).filter((id): id is number => id !== null))];
  const fillIds = [...new Set(draft.edition.entries.filter(e => e.entry.fillIn).flatMap(e =>
    candidates.filter(c => eventIds(e).includes(c.id)).map(c => c.fact_id).filter((id): id is number => id !== null)))];
  // Native coverage and participant counts also depend on reports not named in an entry. Keep
  // that evidence in the cutoff proof instead of letting a late background report affect ranking.
  const support = await tx`WITH support AS (
    SELECT 'coverage' AS kind, fa.article_id, fa.fact_id, NULL::bigint AS story_id, fa.created_at AS linked_at
    FROM fact_articles fa JOIN publications p ON p.article_id=fa.article_id JOIN sources s ON s.id=p.source_id
    WHERE fa.fact_id=ANY(${factIds}::bigint[]) AND ${evidenceCondition()} AND ${listedCondition(end)}
      AND s.participation_mode='editorial' AND p.timeline_at < ${end}
    UNION ALL
    SELECT 'participants', cs.article_id, NULL::bigint, cs.story_id, NULL::timestamptz
    FROM ${currentSignals()} cs WHERE cs.story_id=ANY(${storyIds}::bigint[]) AND cs.observed_at>=${start} AND cs.observed_at<${end}
    UNION ALL
    SELECT 'fill-in', cs.article_id, fa.fact_id, NULL::bigint, fa.created_at
    FROM ${currentSignals()} cs JOIN fact_articles fa ON fa.article_id=cs.article_id JOIN publications p ON p.article_id=fa.article_id
    WHERE fa.fact_id=ANY(${fillIds}::bigint[]) AND ${evidenceCondition()} AND cs.observed_at<${end}
  ) SELECT support.*, a.revision, ar.created_at AS revised_at, a.grouping_status, a.grouped_at,
    s.participation_mode, an.input_revision, an.created_at AS analyzed_at, an.relevance,
    encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') AS publication_hash
    FROM support JOIN articles a ON a.id=support.article_id JOIN sources s ON s.id=a.source_id
    LEFT JOIN publications p ON p.article_id=a.id LEFT JOIN analyses an ON an.id=p.analysis_id
    LEFT JOIN article_revisions ar ON ar.article_id=a.id AND ar.revision=a.revision
    ORDER BY support.kind,support.article_id,support.fact_id,support.story_id`;
  fail(!support.some(s => manifest.exclusions.some(e => e.articleId === s.article_id)), "excluded material became background evidence");
  const unresolvedSupport = await tx`SELECT r.id FROM receipts r JOIN articles a ON
    (r.id=a.grouping_receipt_id OR substring(r.subject from '^article:([^@:#]+)')=a.id)
    WHERE a.id=ANY(${[...new Set(support.map(s => s.article_id))]}::text[]) AND r.status IN ('pending','unknown')`;
  fail(unresolvedSupport.length === 0, "background has unresolved evidence");
  const afterCutoff = (c: { revised_at?: Date; analyzed_at?: Date; grouped_at?: Date; linked_at?: Date }) =>
    [c.revised_at, c.analyzed_at, c.grouped_at, c.linked_at].some(at => at && at >= end);
  const verified = (c: typeof candidates[number]) => c.relevance === "pass" && c.input_revision === c.revision
    && c.revised_at && c.revised_at < end && c.analyzed_at && c.analyzed_at < end
    && c.grouping_status === "complete" && c.grouped_at && c.grouped_at < end;
  const temporalExcluded: Array<{ itemId: string; articleIds: string[]; candidates: Array<typeof candidates[number]>; support: Array<typeof support[number]> }> = [];
  const entries = draft.edition.entries.filter(e => {
    const memberIds = eventIds(e), members = candidates.filter(c => memberIds.includes(c.id));
    const facts = new Set(members.map(c => c.fact_id));
    const background = support.filter(s => (s.fact_id !== null && facts.has(s.fact_id)) || (s.story_id !== null && s.story_id === e.storyId));
    if ([...members, ...background].some(afterCutoff)) {
      temporalExcluded.push({ itemId: e.entry.itemId, articleIds: memberIds, candidates: members, support: background });
      return false;
    }
    fail(members.every(verified), "candidate lacks pre-cutoff verification");
    // Signal grouping does not yet persist a trustworthy completion clock. This incident has no
    // approved signal exception, so unknown timing must not be presented as pre-cutoff evidence.
    fail(background.every(s => s.participation_mode === "editorial" && verified(s)), "background lacks pre-cutoff verification");
    return true;
  });
  fail(entries.length > 0, "no verified daily entries");
  const temporalExclusions = { articles: new Set(temporalExcluded.flatMap(e => e.articleIds)).size, events: temporalExcluded.length };
  const edition = { ...draft.edition, entries, stats: { ...draft.edition.stats, temporalExcludedArticles: temporalExclusions.articles, temporalExcludedEvents: temporalExclusions.events } };
  const rendered = dailyContent(manifest.key, start, end, edition);
  const content = { ...rendered.content, publicationNote: PUBLICATION_NOTE };
  const manifestHash = sha256(stableJson(manifest));
  const planHash = sha256(stableJson({ manifestHash, content, candidates, support, temporalExcluded, gaps, pending, receipts, attempts, fetches }));
  return { draft: { ...draft, ...rendered, edition, content }, manifestHash, planHash, temporalExcluded, candidates, support,
    summary: { key: manifest.key, windowStart: manifest.windowStart, windowEnd: manifest.windowEnd,
      manifestHash, planHash, mainCount: rendered.entries, flashCount: content.flashes.length, temporalExclusions,
      temporalExcludedIds: [...new Set(temporalExcluded.flatMap(e => e.articleIds))].sort(),
      items: [...content.sections.flatMap(s => s.items), ...content.flashes].map(e => ({ id: e.itemId, title: e.title, sourceId: e.sourceId, sourceName: e.sourceName })),
      exclusions: { unknown: 7, bodyUnavailable: 4 }, publicationNote: PUBLICATION_NOTE } };
}

export async function checkManualLate(value: unknown) {
  const manifest = validate(value);
  installModules(SERVER_MODULES);
  return sql.begin("isolation level serializable read only", async tx => {
    await context(tx);
    const rows = await tx`SELECT id FROM reports WHERE kind='daily' AND key=${manifest.key}`;
    fail(rows.length === 0, "target issue already exists");
    return { status: "ready", ...(await inspect(tx, manifest, false)).summary };
  });
}

export async function publishManualLate(value: unknown, approvedPlanHash: string) {
  const manifest = validate(value);
  hash.parse(approvedPlanHash);
  installModules(SERVER_MODULES);
  return sql.begin("isolation level serializable", async tx => {
    await context(tx);
    const [previous] = await tx`SELECT after FROM audit_log WHERE action=${ACTION} AND request_id=${manifest.requestId} ORDER BY id LIMIT 1`;
    const [existing] = await tx`SELECT id, revision, generated_at, content, window_start, window_end, origin FROM reports WHERE kind='daily' AND key=${manifest.key}`;
    if (previous) {
      fail(existing && previous.after.manifestHash === sha256(stableJson(manifest)) && previous.after.planHash === approvedPlanHash
        && previous.after.reportId === existing.id && existing.revision === 1
        && existing.origin === "manual" && existing.window_start.toISOString() === manifest.windowStart && existing.window_end.toISOString() === manifest.windowEnd
        && previous.after.generatedAt === existing.generated_at.toISOString()
        && previous.after.contentHash === sha256(stableJson(existing.content)), "request identity conflict");
      return { status: "already-published", key: manifest.key, reportId: existing.id, planHash: approvedPlanHash, generatedAt: existing.generated_at.toISOString() };
    }
    fail(!existing, "target issue already exists");
    const plan = await inspect(tx, manifest, true);
    fail(plan.planHash === approvedPlanHash, "approved plan changed");
    const [run] = await tx`INSERT INTO job_runs (job) VALUES ('agenthot.daily-manual-late') RETURNING id`;
    fail(await saveDailyInTransaction(tx, plan.draft), "target issue appeared concurrently");
    const [report] = await tx`SELECT id, revision, generated_at FROM reports WHERE kind='daily' AND key=${manifest.key}`;
    const after = { requestId: manifest.requestId, manifestHash: plan.manifestHash, planHash: plan.planHash,
      reportId: report!.id, generatedAt: report!.generated_at.toISOString(), runId: run!.id,
      contentHash: sha256(stableJson(plan.draft.content)), candidateEvidence: plan.candidates, backgroundEvidence: plan.support,
      temporalExcluded: plan.temporalExcluded, manifest };
    await audit(manifest.actor, ACTION, `report:daily:${manifest.key}`, manifest.reason, null, after, { requestId: manifest.requestId, db: tx });
    await tx`UPDATE job_runs SET status='ok', finished_at=clock_timestamp(), detail=${tx.json({ ...plan.summary, requestId: manifest.requestId, reportId: report!.id, generatedAt: after.generatedAt } as never)} WHERE id=${run!.id}`;
    return { status: "published", ...plan.summary, reportId: report!.id, generatedAt: after.generatedAt };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, file, approval] = process.argv.slice(2);
    fail(file && ((mode === "--check" && !approval) || (mode === "--publish" && approval)), "use --check manifest.json or --publish manifest.json approved-plan-hash");
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    console.log(JSON.stringify(mode === "--check" ? await checkManualLate(manifest) : await publishManualLate(manifest, approval!)));
  } catch {
    console.error(JSON.stringify({ status: "refused", error: "Manual late preconditions failed; no automatic retry or model request was made" }));
    process.exitCode = 1;
  } finally { await closeDb(); }
}
