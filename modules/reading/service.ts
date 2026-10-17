import { z } from "zod";
import { sql, type Db, type Tx } from "@aihot/backend/db";
import { chatJson, MODELS } from "@aihot/backend/providers/llm";
import { completeReceipt } from "@aihot/backend/providers/receipts";
import { invalidateModelCache, modelFor } from "@aihot/backend/editorial/models";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { DraftSchema, materialHash, materialOf, PROMPT, publicReading, userMaterial, validateReading, VERSION } from "./content.ts";

export const ReadingBinding = z.object({ articleId: z.string().regex(/^[a-z0-9]{20,32}$/), revision: z.number().int().positive(),
  analysisId: z.number().int().positive(), materialHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type Binding = z.infer<typeof ReadingBinding>;
const refuse = (reason: string): never => { throw new Error(`Reading refused: ${reason}`); };

async function state(articleId: string, db: Db, lock = false) {
  const [row] = await db`SELECT a.id, a.revision, a.title, a.url, a.body_text, a.body_html, a.body_status, a.processing_state, a.grouping_status,
    p.analysis_id, p.visibility, p.eligible, an.input_revision, an.relevance, an.output, an.created_at AS analyzed_at,
    s.participation_mode, encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') AS publication_hash
    FROM articles a JOIN publications p ON p.article_id=a.id JOIN analyses an ON an.id=p.analysis_id JOIN sources s ON s.id=a.source_id
    WHERE a.id=${articleId} ${lock ? db`FOR SHARE OF a,p,an,s` : db``}`;
  if (!row || row.visibility !== "public" || !row.eligible || row.participation_mode !== "editorial"
    || row.processing_state !== "analyzed" || row.grouping_status !== "complete" || row.relevance !== "pass" || row.input_revision !== row.revision
    || row.body_status !== "ok" || !row.body_text?.trim()) return null;
  const material = materialOf(row.title, row.url, row.body_text, row.body_html);
  const binding: Binding = { articleId, revision: row.revision, analysisId: row.analysis_id, materialHash: materialHash(material) };
  const [saved] = await db`SELECT payload, created_at, receipt_id FROM reading_entries WHERE article_id=${articleId}
    AND revision=${binding.revision} AND analysis_id=${binding.analysisId} AND material_hash=${binding.materialHash} ORDER BY created_at DESC LIMIT 1`;
  const embedded = row.output?.modules?.reading;
  const existing = saved ? { payload: saved.payload, at: saved.created_at, receiptId: saved.receipt_id as number | null }
    : embedded ? { payload: embedded, at: row.analyzed_at, receiptId: null } : null;
  return { row, material, binding, existing };
}

async function guard(articleId: string, db: Db) {
  // The whole article, not only this purpose/revision: changing prompts must not resend an unknown request.
  const bad = await db`SELECT r.id FROM receipts r LEFT JOIN articles a ON a.id=${articleId}
    WHERE r.status IN ('pending','unknown','failed') AND (r.id=a.grouping_receipt_id
      OR substring(r.subject from '^article:([^@:#]+)')=${articleId}) LIMIT 1`;
  if (bad.length) refuse("article has unresolved or failed requests");
  const active = await db`SELECT id FROM job_runs WHERE status='running'
    AND job IN ('agenthot.daily-collect','agenthot.daily-publish','agenthot.daily-manual-late') LIMIT 1`;
  if (active.length) refuse("daily operation is active");
}

async function modelAndBudget(db: Db) {
  invalidateModelCache();
  const model = await modelFor("understand");
  if (model !== "gpt-6.1-sol" || MODELS[model]?.service !== "codex-cli") refuse("unexpected writing provider");
  const [budget] = await db`SELECT per_minute,per_hour,per_day FROM budgets WHERE service='codex-cli'`;
  if (!budget || ![budget.per_minute, budget.per_hour, budget.per_day].every(n => typeof n === "number" && Number.isFinite(n) && n > 0)) refuse("finite budget required");
  return model;
}

async function plan(articleId: string, db: Db, lock = false) {
  await guard(articleId, db);
  const current = await state(articleId, db, lock);
  if (!current) return refuse("current verified full material is unavailable");
  await modelAndBudget(db);
  if (current.existing && !publicReading(current.existing.payload, current.material, current.existing.at)) refuse("existing interpretation is not valid for this material");
  if (!current.existing) {
    const received = await db`SELECT request,service,model FROM receipts WHERE purpose='reading_article'
      AND subject=${'article:' + articleId + '@' + current.binding.revision} AND status IN ('received','completed')`;
    const suffix = `:${current.binding.analysisId}:${current.binding.materialHash}`;
    for (const receipt of received) {
      const request = receipt.request;
      if (typeof request?.promptVersion !== "string") refuse("received writing requires explicit recovery");
      if (!request.promptVersion.endsWith(suffix)) continue;
      // A saved response can finish the same business write. A prompt upgrade is not permission
      // to pay again for that binding; stop instead of copying the provider's identity algorithm.
      if (request.promptVersion !== `${VERSION}${suffix}` || request.systemHash !== sha256(PROMPT)
        || request.userHash !== sha256(userMaterial(current.material)) || request.temperature !== 0.2 || request.maxTokens !== 4500
        || receipt.service !== "codex-cli" || receipt.model !== "gpt-6.1-sol") refuse("received writing belongs to a different prompt");
    }
  }
  const planHash = sha256(stableJson({ binding: current.binding, publicationHash: current.row.publication_hash, version: VERSION,
    prompt: sha256(PROMPT), existing: current.existing ? sha256(stableJson(current.existing)) : null }));
  return { ...current, planHash };
}

/** Pure preflight: no model, queue, receipt or content writes. */
export async function checkReading(articleId: string) {
  if (!/^[a-z0-9]{20,32}$/.test(articleId)) refuse("invalid article identity");
  const current = await plan(articleId, sql);
  return { ...current.binding, planHash: current.planHash, existing: !!current.existing };
}

/** Read only, fail closed on withdrawal, a newer input, a replaced analysis, or changed evidence. */
export async function itemReading(articleId: string, db: Db) {
  const current = await state(articleId, db);
  return current?.existing ? publicReading(current.existing.payload, current.material, current.existing.at) : null;
}

export async function writeReading(value: unknown, approvedPlanHash: string) {
  const binding = ReadingBinding.parse(value);
  if (!/^[a-f0-9]{64}$/.test(approvedPlanHash)) refuse("invalid plan identity");
  for (const key of ["COLLECT_ENABLED", "FEISHU_CONTENT_PUSH_ENABLED", "FEISHU_INTERNAL_ENABLED", "INDEXNOW_SUBMIT_ENABLED"]) {
    if (process.env[key] !== "false") refuse("external-action valves must be closed");
  }
  if (process.env.MODEL_CALLS_ENABLED !== "true") refuse("writing valve is closed");
  return sql.begin(async tx => {
    await tx`SET LOCAL lock_timeout='5s'`;
    // Independent of model/prompt/attempt: two processes cannot reserve competing writes for this article.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'reading:' + binding.articleId}))`;
    const current = await plan(binding.articleId, tx, true);
    if (stableJson(current.binding) !== stableJson(binding)) refuse("approved material changed");
    if (current.existing) return { status: "reused", ...binding, receiptId: current.existing.receiptId, generatedAt: current.existing.at.toISOString() };
    if (current.planHash !== approvedPlanHash) refuse("approved plan changed");
    const response = await chatJson({ model: "gpt-6.1-sol", purpose: "reading_article", subject: `article:${binding.articleId}@${binding.revision}`,
      promptVersion: `${VERSION}:${binding.analysisId}:${binding.materialHash}`, system: PROMPT, user: userMaterial(current.material),
      schema: DraftSchema, temperature: 0.2, maxTokens: 4500, timeoutMs: 180000 });
    const payload = validateReading(response.data, current.material, userMaterial(current.material));
    if (!payload) refuse("no grounded original interpretation was returned");
    await guard(binding.articleId, tx);
    const final = await state(binding.articleId, tx);
    if (!final || stableJson(final.binding) !== stableJson(binding) || final.row.publication_hash !== current.row.publication_hash) refuse("material or publication changed during writing");
    const [saved] = await tx`INSERT INTO reading_entries (article_id,revision,analysis_id,material_hash,version,receipt_id,payload)
      VALUES (${binding.articleId},${binding.revision},${binding.analysisId},${binding.materialHash},${VERSION},${response.receiptId},${tx.json(payload as never)}) RETURNING created_at`;
    await completeReceipt(tx as Tx, response.receiptId);
    return { status: "written", ...binding, receiptId: response.receiptId, generatedAt: saved!.created_at.toISOString() };
  });
}
