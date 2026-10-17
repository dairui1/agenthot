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
const { checkReading, writeReading, itemReading } = await import("../service.ts");

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
  installModules([reading]);
  calls = [];
  responseClock = null;
  recordResponseClock = false;
  await sql`TRUNCATE sources,articles,receipts,reports,job_runs RESTART IDENTITY CASCADE`;
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
