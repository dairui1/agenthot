import { stub, pointModels } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
process.env.UNDERSTAND_MODEL = "gpt-6.1-sol";
process.env.COLLECT_ENABLED = "false";
process.env.FEISHU_INTERNAL_ENABLED = "false";
const { sql, closeDb } = await import("@aihot/backend/db");
const { stopBoss } = await import("@aihot/backend/jobs/queue");
const { upsertMaterial } = await import("@aihot/backend/content/materials");
const { publishArticle } = await import("@aihot/backend/publication/publish");
const { installModules } = await import("@aihot/backend/modules");
const { analyzeArticle, runUnderstand, loadAnalyzeInput, SCORE_SYSTEM, STRUCTURE_SYSTEM } = await import("@aihot/backend/editorial/analyze");
const { PREFILTER_SYSTEM, UNDERSTAND_SYSTEM } = await import("@aihot/backend/editorial/writing");
const { reading } = await import("../server.ts");
const { checkReading, writeReading, itemReading, previewReadingRecovery, applyReadingRecovery } = await import("../service.ts");
const { materialOf, userMaterial, PROMPT, VERSION } = await import("../content.ts");
const { sha256 } = await import("@aihot/backend/lib/ids");

const BODY = "The release adds resumable tasks and a persisted task journal. The journal records each tool result before moving to the next action. The preview supports Linux only and requires an existing account. Documentation: https://example.com/docs";
let id = "", answer: Record<string, unknown>, calls: string[] = [], responseClock: Date | null = null, recordResponseClock = false;
const provider = await stub(async (_hit, req) => {
  const body = JSON.parse(req.body), system = body.messages[0].content as string;
  calls.push(system);
  let out: unknown = answer;
  if (system === PREFILTER_SYSTEM) out = { label: "PASS", reason: "In scope" };
  if (system === SCORE_SYSTEM) out = { attentionScore: 95 };
  if (system === STRUCTURE_SYSTEM) out = { category: "industry", tags: [], subjects: [], scope: "single", fact: null };
  if (system.startsWith(UNDERSTAND_SYSTEM)) out = { itemType: "product_launch", authorRole: "principal", tags: [], editorialJudgment: "原文解释了任务恢复方式及其适用条件。", titleZh: "任务恢复功能上线", summaryZh: "产品发布可恢复任务和持久化任务日志。预览当前只支持 Linux 且需要已有账号。", modules: { reading: answer } };
  if (recordResponseClock) {
    await new Promise(resolve => setTimeout(resolve, 30));
    responseClock = (await sql`SELECT clock_timestamp() AS at`)[0]!.at as Date;
  }
  return { id: "fake", choices: [{ message: { content: JSON.stringify(out) } }], usage: { prompt_tokens: 20, completion_tokens: 20 } };
});
pointModels(provider.url, ["gpt-6.1-sol", "qwen3.7-flash", "glm-5.3-flash-selection", "qwen3.8-flash"]);

async function snapshot() {
  const [row] = await sql`SELECT (SELECT to_jsonb(a) FROM articles a WHERE id=${id}) AS article,
    (SELECT to_jsonb(p) FROM publications p WHERE article_id=${id}) AS publication,
    (SELECT jsonb_agg(to_jsonb(an) ORDER BY id) FROM analyses an WHERE article_id=${id}) AS analyses,
    (SELECT jsonb_agg(to_jsonb(b) ORDER BY service) FROM budgets b) AS budgets,
    (SELECT count(*)::int FROM reports) AS reports`;
  return row;
}
const bindingOf = ({ articleId, revision, analysisId, materialHash }: Awaited<ReturnType<typeof checkReading>>) => ({ articleId, revision, analysisId, materialHash });
beforeEach(async () => {
  process.env.MODEL_CALLS_ENABLED = "true";
  process.env.AGENTLAB_SYNC_ENABLED = "false";
  installModules([reading]);
  calls = [];
  responseClock = null;
  recordResponseClock = false;
  await sql`TRUNCATE sources,articles,receipts,reports,job_runs,audit_log RESTART IDENTITY CASCADE`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext) VALUES('reading-test','Fixture','rss','T1','editorial',false)`;
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES('codex-cli',100,200,500)
    ON CONFLICT(service) DO UPDATE SET per_minute=100,per_hour=200,per_day=500`;
  ({ articleId: id } = await upsertMaterial({ sourceId: "reading-test", url: "https://example.com/release", title: "Task release", bodyText: BODY, bodyStatus: "ok", via: "fetch", publishedAt: new Date() }));
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected)
    VALUES(${id},1,'rule','pass','任务恢复功能','新增任务日志与恢复功能。',95,true)`;
  await sql`UPDATE articles SET processing_state='analyzed',grouping_status='complete',grouped_at=now() WHERE id=${id}`;
  await publishArticle(id);
  answer = { changes: [{ text: "原文介绍，任务日志会先保存工具结果，再继续执行后续操作。", quote: "The journal records each tool result before moving to the next action.", sourceUrl: "https://example.com/release" }], value: [],
    limitations: [{ text: "预览版本目前仅面向 Linux 用户，并要求已有账号。", quote: "The preview supports Linux only and requires an existing account.", sourceUrl: "https://example.com/release" }], links: [{ label: "文档", url: "https://example.com/docs" }] };
});
after(async () => { installModules([]); await provider.close(); await stopBoss(); await closeDb(); });

test("one receipt writes original reading without changing analysis, publication, report, budget or source permissions", async () => {
  const before = await snapshot(), checked = await checkReading(id);
  assert.equal(calls.length, 0);
  const result = await writeReading(bindingOf(checked), checked.planHash);
  assert.equal(result.status, "written");
  assert.equal(calls.length, 1);
  assert.deepEqual(await snapshot(), before);
  const dto = await itemReading(id, sql);
  assert.equal(dto?.sections.length, 2);
  assert.equal(dto?.generatedAt, result.generatedAt);
  assert.ok(!JSON.stringify(dto).includes("quote"));
  assert.ok(!JSON.stringify(dto).includes("The journal records"));
  const [receipt] = await sql`SELECT purpose,status,attempts FROM receipts`;
  assert.deepEqual({ ...receipt }, { purpose: "reading_article", status: "completed", attempts: 1 });
  assert.equal((await writeReading(bindingOf(checked), checked.planHash)).status, "reused");
  assert.equal(calls.length, 1);
});

test("generatedAt records actual persistence after the model response, not the transaction start", async () => {
  const checked = await checkReading(id);
  recordResponseClock = true;
  const result = await writeReading(bindingOf(checked), checked.planHash);
  assert.ok(responseClock);
  assert.ok(new Date(result.generatedAt).getTime() >= (responseClock as Date).getTime());
  assert.equal((await itemReading(id, sql))?.generatedAt, result.generatedAt);
  assert.equal(calls.length, 1);
});

for (const status of ["unknown", "pending", "failed"]) test(`any older-revision ${status} receipt blocks a different writing purpose`, async () => {
  const checked = await checkReading(id);
  await sql`INSERT INTO receipts(logical_key,service,model,purpose,subject,status,attempts)
    VALUES(${'old-' + status},'codex-cli','gpt-6.1-sol','score_article',${'article:' + id + '@0'},${status},1)`;
  await assert.rejects(checkReading(id), /unresolved or failed/);
  await assert.rejects(writeReading(bindingOf(checked), checked.planHash), /unresolved or failed/);
  assert.equal(calls.length, 0);
});

test("a changed material hash or changed publication refuses the approved plan before any request", async () => {
  const checked = await checkReading(id);
  await sql`UPDATE articles SET body_text=body_text || ' Changed details.' WHERE id=${id}`;
  await assert.rejects(writeReading(bindingOf(checked), checked.planHash), /material changed/);
  assert.equal(calls.length, 0);
});

test("simultaneous writers for one binding make one request and reuse the committed interpretation", async () => {
  const checked = await checkReading(id);
  const outcomes = await Promise.all([writeReading(bindingOf(checked), checked.planHash), writeReading(bindingOf(checked), checked.planHash)]);
  assert.deepEqual(outcomes.map(o => o.status).sort(), ["reused", "written"]);
  assert.equal(calls.length, 1);
});

test("a failed business commit reuses the durable received response without a second request", async () => {
  const checked = await checkReading(id);
  await sql`ALTER TABLE reading_entries ADD CONSTRAINT reading_test_reject CHECK (false) NOT VALID`;
  try { await assert.rejects(writeReading(bindingOf(checked), checked.planHash)); }
  finally { await sql`ALTER TABLE reading_entries DROP CONSTRAINT reading_test_reject`; }
  assert.equal((await sql`SELECT status FROM receipts`)[0]!.status, "received");
  assert.equal((await sql`SELECT count(*)::int AS n FROM reading_entries`)[0]!.n, 0);
  assert.equal((await writeReading(bindingOf(checked), checked.planHash)).status, "written");
  assert.equal(calls.length, 1);
});

for (const change of ["withdrawal", "summary-only", "revision", "analysis", "body"]) test(`public reading immediately hides after ${change}`, async () => {
  const checked = await checkReading(id);
  await writeReading(bindingOf(checked), checked.planHash);
  if (change === "withdrawal" || change === "summary-only") await sql`UPDATE publications SET visibility=${change === "withdrawal" ? "withdrawn" : "summary-only"} WHERE article_id=${id}`;
  if (change === "revision") await sql`UPDATE articles SET revision=revision+1 WHERE id=${id}`;
  if (change === "body") await sql`UPDATE articles SET body_text=body_text || ' Changed.' WHERE id=${id}`;
  if (change === "analysis") {
    const [an] = await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh) VALUES(${id},1,'rule','pass','新判断','新摘要') RETURNING id`;
    await sql`UPDATE publications SET analysis_id=${an!.id} WHERE article_id=${id}`;
  }
  assert.equal(await itemReading(id, sql), null);
  assert.equal(calls.length, 1);
});

test("invalid evidence is not published or repaired with another model request", async () => {
  const checked = await checkReading(id);
  answer = { ...answer, changes: [{ text: "这是一条没有原文证据支撑的新能力判断。", quote: "This sentence is not in the supplied source.", sourceUrl: "https://example.com/release" }], limitations: [] };
  await assert.rejects(writeReading(bindingOf(checked), checked.planHash), /no grounded/);
  await assert.rejects(writeReading(bindingOf(checked), checked.planHash), /no grounded/);
  assert.equal(calls.length, 1, "received response is reused, never re-requested");
  assert.equal(await itemReading(id, sql), null);
});

test("a received result for this binding cannot be bypassed by a different prompt version", async () => {
  const checked = await checkReading(id);
  await sql`ALTER TABLE reading_entries ADD CONSTRAINT reading_test_reject CHECK (false) NOT VALID`;
  try { await assert.rejects(writeReading(bindingOf(checked), checked.planHash)); }
  finally { await sql`ALTER TABLE reading_entries DROP CONSTRAINT reading_test_reject`; }
  await sql`UPDATE receipts SET request=jsonb_set(request,'{promptVersion}',to_jsonb(${'reading-older:' + checked.analysisId + ':' + checked.materialHash}::text)) WHERE purpose='reading_article'`;
  await assert.rejects(checkReading(id), /different prompt/);
  await assert.rejects(writeReading(bindingOf(checked), checked.planHash), /different prompt/);
  assert.equal(calls.length, 1);
});

test("missing or unlimited budget refuses check without altering limits", async () => {
  await sql`DELETE FROM budgets WHERE service='codex-cli'`;
  await assert.rejects(checkReading(id), /finite budget/);
  assert.equal(calls.length, 0);
});

test("normal understanding uses one call and stores validated extension in the existing analysis", async () => {
  const result = await analyzeArticle(id);
  assert.ok(result?.analysisId);
  assert.equal(calls.length, 5, "prefilter + two scores + structure + one understanding");
  const [analysis] = await sql`SELECT output FROM analyses WHERE id=${result!.analysisId!}`;
  assert.equal(analysis!.output.modules.reading.version, "reading-v1");
  const [receipt] = await sql`SELECT request FROM receipts WHERE purpose='understand_article'`;
  assert.match(receipt!.request.promptVersion, /\+/);
  await publishArticle(id);
  assert.equal((await itemReading(id, sql))?.sections.length, 2, "embedded understanding is publicly projected without a separate reading receipt");
  assert.equal((await sql`SELECT count(*)::int AS n FROM reading_entries`)[0]!.n, 0);
  assert.equal(calls.length, 5);
});

test("saved HTML links reach the one existing understanding call and are used without fetching them", async () => {
  await sql`UPDATE articles SET body_html='<p>Source</p><a href="/actual-documentation">Documentation</a>' WHERE id=${id}`;
  answer = { ...answer, links: [{ label: "实际文档", url: "https://example.com/actual-documentation" }] };
  const result = await runUnderstand((await loadAnalyzeInput(id))!);
  assert.ok(calls[0]?.includes("https://example.com/actual-documentation"));
  assert.equal((result?.modules?.reading as { draft: { links: Array<{ url: string }> } }).draft.links[0]!.url, "https://example.com/actual-documentation");
  assert.equal(calls.length, 1);
});

test("invalid optional extension does not discard a valid understanding or make a repair call", async () => {
  answer = { notAReading: true };
  const result = await runUnderstand((await loadAnalyzeInput(id))!);
  assert.equal(result?.kind, "understand");
  assert.equal(result?.modules, undefined);
  assert.equal(calls.length, 1);
});

async function failedReading() {
  const checked = await checkReading(id), binding = bindingOf(checked);
  const user = userMaterial(materialOf("Task release", "https://example.com/release", BODY));
  const request = { promptVersion: `${VERSION}:${binding.analysisId}:${binding.materialHash}`, systemHash: sha256(PROMPT),
    userHash: sha256(user), userChars: user.length, temperature: 0.2, maxTokens: 4500,
    transportRequestKey: sha256("saved-reading-fixture"), transportBodyHash: "a".repeat(64) };
  const draft = { ...answer, links: [{ label: "Cursor release documentation with complete entry title", url: "https://example.com/docs" }] };
  const response = { model: "gpt-6.1-sol", choices: [{ message: { content: JSON.stringify(draft) }, finish_reason: "stop" }] };
  const [receipt] = await sql`INSERT INTO receipts(logical_key,service,model,purpose,subject,status,attempts,request,response,received_at,error)
    VALUES('saved-reading-fixture','codex-cli','gpt-6.1-sol','reading_article',${'article:' + id + '@1'},'failed',1,${sql.json(request)},${sql.json(response)},now(),'local label schema rejection') RETURNING id`;
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,finished_at)
    VALUES(${receipt!.id},1,'codex-cli','gpt-6.1-sol','received',now())`;
  process.env.MODEL_CALLS_ENABLED = "false";
  return { ...binding, receiptId: receipt!.id as number };
}

test("explicit recovery previews and atomically publishes a saved long-label response with zero model calls", async () => {
  const request = await failedReading(), before = await snapshot();
  const [original] = await sql`SELECT response,error,attempts FROM receipts WHERE id=${request.receiptId}`;
  const attempts = await sql`SELECT * FROM receipt_attempts`;
  const checked = await previewReadingRecovery(request);
  assert.equal(checked.preview.links[0]!.label.length, 54);
  assert.equal(checked.existing, false);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log`)[0]!.n, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM reading_entries`)[0]!.n, 0);
  const result = await applyReadingRecovery(request, checked.planHash);
  assert.equal(result.status, "recovered");
  assert.deepEqual(await snapshot(), before);
  const [receipt] = await sql`SELECT status,response,error,attempts FROM receipts WHERE id=${request.receiptId}`;
  assert.equal(receipt!.status, "completed");
  assert.deepEqual({ response: receipt!.response, error: receipt!.error, attempts: receipt!.attempts }, { ...original });
  assert.deepEqual(await sql`SELECT * FROM receipt_attempts`, attempts);
  assert.equal((await itemReading(id, sql))?.links[0]!.label, checked.preview.links[0]!.label);
  const [audit] = await sql`SELECT after FROM audit_log WHERE action='reading.response-recovered'`;
  assert.equal(audit!.after.planHash, checked.planHash);
  assert.equal(audit!.after.generatedAt, result.generatedAt);
  assert.equal(JSON.stringify(audit).includes("The journal records"), false);
  assert.equal((await applyReadingRecovery(request, checked.planHash)).status, "reused");
  assert.equal((await previewReadingRecovery(request)).planHash, checked.planHash);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log`)[0]!.n, 1);
  assert.equal(calls.length, 0);
});

for (const status of ["unknown", "pending", "received", "completed"]) test(`recovery rejects ${status} instead of treating it as an approved local-format failure`, async () => {
  const request = await failedReading();
  await sql`UPDATE receipts SET status=${status} WHERE id=${request.receiptId}`;
  await assert.rejects(previewReadingRecovery(request), /not a recoverable|no longer matches/);
  await assert.rejects(applyReadingRecovery(request, "a".repeat(64)), /not a recoverable|no longer matches/);
  assert.equal(calls.length, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM reading_entries`)[0]!.n, 0);
});

for (const problem of ["missing-response", "truncated", "unknown-attempt", "extra-attempt", "prompt", "model"]) test(`recovery refuses unsafe saved evidence: ${problem}`, async () => {
  const request = await failedReading();
  if (problem === "missing-response") await sql`UPDATE receipts SET response=null WHERE id=${request.receiptId}`;
  if (problem === "truncated") await sql`UPDATE receipts SET response=jsonb_set(response,'{choices,0,finish_reason}','"length"') WHERE id=${request.receiptId}`;
  if (problem === "unknown-attempt") await sql`UPDATE receipt_attempts SET status='unknown' WHERE receipt_id=${request.receiptId}`;
  if (problem === "extra-attempt") await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,finished_at)
    VALUES(${request.receiptId},2,'codex-cli','gpt-6.1-sol','received',now())`;
  if (problem === "prompt") await sql`UPDATE receipts SET request=jsonb_set(request,'{systemHash}',to_jsonb(${'b'.repeat(64)}::text)) WHERE id=${request.receiptId}`;
  if (problem === "model") await sql`UPDATE receipts SET model='another-model' WHERE id=${request.receiptId}`;
  await assert.rejects(previewReadingRecovery(request), /Reading refused/);
  assert.equal(calls.length, 0);
});

test("recovery refuses changed material, analysis and approval evidence rather than rewriting a newer reading", async () => {
  const request = await failedReading(), checked = await previewReadingRecovery(request);
  await sql`UPDATE receipts SET response=response || '{"extra":"changed"}'::jsonb WHERE id=${request.receiptId}`;
  await assert.rejects(applyReadingRecovery(request, checked.planHash), /approved recovery plan changed/);
  const next = await previewReadingRecovery(request);
  await sql`UPDATE articles SET body_text=body_text || ' New source detail.' WHERE id=${id}`;
  await assert.rejects(applyReadingRecovery(request, next.planHash), /material or publication changed/);
  await assert.rejects(previewReadingRecovery({ ...request, analysisId: request.analysisId + 1 }), /material or publication changed/);
  assert.equal(calls.length, 0);
});

test("recovery exempts only its exact failed receipt and preserves every other unknown outcome", async () => {
  const request = await failedReading(), checked = await previewReadingRecovery(request);
  await sql`INSERT INTO receipts(logical_key,service,model,purpose,subject,status,attempts)
    VALUES('other-unknown','codex-cli','gpt-6.1-sol','score_article',${'article:' + id + '@0'},'unknown',1)`;
  const others = await sql`SELECT * FROM receipts WHERE id<>${request.receiptId}`;
  await assert.rejects(applyReadingRecovery(request, checked.planHash), /unresolved or failed/);
  assert.deepEqual(await sql`SELECT * FROM receipts WHERE id<>${request.receiptId}`, others);
  assert.equal(calls.length, 0);
});

test("recovery requires every external valve closed even when a valid response is saved", async () => {
  const request = await failedReading();
  for (const key of ["MODEL_CALLS_ENABLED", "COLLECT_ENABLED", "AGENTLAB_SYNC_ENABLED", "FEISHU_CONTENT_PUSH_ENABLED", "FEISHU_INTERNAL_ENABLED", "INDEXNOW_SUBMIT_ENABLED"]) {
    process.env[key] = "true";
    await assert.rejects(previewReadingRecovery(request), /all recovery valves/);
    await assert.rejects(applyReadingRecovery(request, "a".repeat(64)), /all recovery valves/);
    process.env[key] = "false";
  }
  assert.equal(calls.length, 0);
});

test("a failed recovery audit rolls back the entry and completion, retaining the original saved response", async () => {
  const request = await failedReading(), checked = await previewReadingRecovery(request);
  const before = await sql`SELECT * FROM receipts`;
  await sql`ALTER TABLE audit_log ADD CONSTRAINT reading_test_audit_reject CHECK (false) NOT VALID`;
  try { await assert.rejects(applyReadingRecovery(request, checked.planHash)); }
  finally { await sql`ALTER TABLE audit_log DROP CONSTRAINT reading_test_audit_reject`; }
  assert.deepEqual(await sql`SELECT * FROM receipts`, before);
  assert.equal((await sql`SELECT count(*)::int AS n FROM reading_entries`)[0]!.n, 0);
  assert.equal((await applyReadingRecovery(request, checked.planHash)).status, "recovered");
  assert.equal(calls.length, 0);
});

test("a replay refuses a changed stored interpretation rather than claiming the approved recovery is still current", async () => {
  const request = await failedReading(), checked = await previewReadingRecovery(request);
  await applyReadingRecovery(request, checked.planHash);
  await sql`UPDATE reading_entries SET payload=jsonb_set(payload,'{draft,links,0,label}','"Changed label"') WHERE receipt_id=${request.receiptId}`;
  await assert.rejects(applyReadingRecovery(request, checked.planHash), /no longer matches/);
  assert.equal(calls.length, 0);
});

test("recovery refuses withdrawal after preview and leaves the failed receipt untouched", async () => {
  const request = await failedReading(), checked = await previewReadingRecovery(request);
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${id}`;
  await assert.rejects(applyReadingRecovery(request, checked.planHash), /material or publication changed/);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${request.receiptId}`)[0]!.status, "failed");
  assert.equal(calls.length, 0);
});

test("recovery preserves seven unrelated unknown receipts without creating any request or attempt", async () => {
  const request = await failedReading();
  for (let index = 0; index < 7; index++) await sql`INSERT INTO receipts(logical_key,service,model,purpose,subject,status,attempts)
    VALUES(${'unrelated-' + index},'codex-cli','gpt-6.1-sol','prefilter_article',${'article:unrelated' + index + '@1'},'unknown',1)`;
  const unknowns = await sql`SELECT * FROM receipts WHERE status='unknown'`;
  const checked = await previewReadingRecovery(request);
  await applyReadingRecovery(request, checked.planHash);
  assert.deepEqual(await sql`SELECT * FROM receipts WHERE status='unknown'`, unknowns);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0]!.n, 8);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipt_attempts`)[0]!.n, 1);
  assert.equal(calls.length, 0);
});

test("concurrent recovery commits at most one entry and audit, with conflicts requiring explicit recheck", async () => {
  const request = await failedReading(), checked = await previewReadingRecovery(request);
  const results = await Promise.allSettled([applyReadingRecovery(request, checked.planHash), applyReadingRecovery(request, checked.planHash)]);
  assert.equal(results.filter(r => r.status === "fulfilled" && r.value.status === "recovered").length, 1);
  for (const result of results) if (result.status === "rejected") assert.match(result.reason.message, /could not serialize/);
  assert.equal((await sql`SELECT count(*)::int AS n FROM reading_entries`)[0]!.n, 1);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log`)[0]!.n, 1);
  assert.equal((await applyReadingRecovery(request, checked.planHash)).status, "reused");
  assert.equal(calls.length, 0);
});
