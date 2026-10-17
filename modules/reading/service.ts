import { z } from "zod";
import { sql, type Db, type Tx } from "@aihot/backend/db";
import { chatJson, MODELS } from "@aihot/backend/providers/llm";
import { completeReceipt } from "@aihot/backend/providers/receipts";
import { invalidateModelCache, modelFor } from "@aihot/backend/editorial/models";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { audit } from "@aihot/backend/audit";
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

async function guard(articleId: string, db: Db, recoveredReceiptId: number | null = null) {
  // The whole article, not only this purpose/revision: changing prompts must not resend an unknown request.
  const bad = await db`SELECT r.id FROM receipts r LEFT JOIN articles a ON a.id=${articleId}
    WHERE r.status IN ('pending','unknown','failed') AND (${recoveredReceiptId}::bigint IS NULL OR r.id<>${recoveredReceiptId}) AND (r.id=a.grouping_receipt_id
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

export const ReadingRecoveryRequest = ReadingBinding.extend({ receiptId: z.number().int().positive() }).strict();
type RecoveryRequest = z.infer<typeof ReadingRecoveryRequest>;
const RECOVERY_ACTION = "reading.response-recovered";
const hash = (value: unknown) => sha256(stableJson(value));

function recoveryValves() {
  for (const key of ["MODEL_CALLS_ENABLED", "COLLECT_ENABLED", "AGENTLAB_SYNC_ENABLED", "FEISHU_CONTENT_PUSH_ENABLED", "FEISHU_INTERNAL_ENABLED", "INDEXNOW_SUBMIT_ENABLED"]) {
    if (process.env[key] !== "false") refuse("all recovery valves must be closed");
  }
}

async function recoveryPlan(request: RecoveryRequest, db: Db, lock = false) {
  const { receiptId, ...binding } = request;
  const current = await state(binding.articleId, db, lock);
  if (!current || stableJson(current.binding) !== stableJson(binding)) return refuse("recovery material or publication changed");
  const [receipt] = await db`SELECT id,logical_key,service,model,purpose,subject,status,attempts,request,response,received_at
    FROM receipts WHERE id=${receiptId} ${lock ? db`FOR UPDATE` : db``}`;
  if (!receipt || !["failed", "completed"].includes(receipt.status) || !receipt.response || !receipt.received_at
    || receipt.purpose !== "reading_article" || receipt.subject !== `article:${binding.articleId}@${binding.revision}`
    || receipt.service !== "codex-cli" || receipt.model !== "gpt-6.1-sol" || receipt.attempts !== 1) refuse("receipt is not a recoverable saved reading response");
  const spec = MODELS["gpt-6.1-sol"], summary = receipt.request;
  const user = userMaterial(current.material);
  if (spec?.service !== "codex-cli" || spec.model !== receipt.model
    || summary?.promptVersion !== `${VERSION}:${binding.analysisId}:${binding.materialHash}`
    || summary.systemHash !== sha256(PROMPT) || summary.userHash !== sha256(user) || summary.userChars !== user.length
    || summary.temperature !== 0.2 || summary.maxTokens !== 4500
    || summary.transportRequestKey !== sha256(receipt.logical_key) || !/^[a-f0-9]{64}$/.test(summary.transportBodyHash ?? "")) refuse("saved reading request does not match the current prompt and material");
  const attempts = await db`SELECT attempt,service,model,status,request_id,started_at,finished_at FROM receipt_attempts
    WHERE receipt_id=${receiptId} ORDER BY attempt ${lock ? db`FOR SHARE` : db``}`;
  if (attempts.length !== 1 || attempts[0]!.attempt !== 1 || attempts[0]!.status !== "received"
    || attempts[0]!.service !== receipt.service || attempts[0]!.model !== receipt.model || !attempts[0]!.finished_at) refuse("saved response has no confirmed received attempt");
  const response = receipt.response;
  if (response.model !== receipt.model || !Array.isArray(response.choices) || response.choices.length !== 1
    || response.choices[0]?.finish_reason !== "stop" || typeof response.choices[0]?.message?.content !== "string") refuse("saved reading response is incomplete");
  let draft: unknown;
  try { draft = JSON.parse(response.choices[0].message.content.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, "$1")); }
  catch { return refuse("saved reading response is not valid JSON"); }
  const payload = validateReading(draft, current.material, user);
  if (!payload) return refuse("saved reading response has no valid grounded interpretation");
  // Only this positively identified saved response is exempted. Other unresolved outcomes stay blocked.
  await guard(binding.articleId, db, receiptId);
  const evidence = { request, publicationHash: current.row.publication_hash, version: VERSION,
    requestHash: hash(summary), responseHash: hash(response), payloadHash: hash(payload), attemptsHash: hash(attempts),
    receivedAt: receipt.received_at.toISOString() };
  const planHash = hash(evidence);
  const [previous] = await db`SELECT after FROM audit_log WHERE action=${RECOVERY_ACTION}
    AND subject=${'article:' + binding.articleId} AND request_id=${'reading-recovery:' + receiptId} ORDER BY id DESC LIMIT 1`;
  if (receipt.status === "completed") {
    if (!current.existing || current.existing.receiptId !== receiptId || hash(current.existing.payload) !== evidence.payloadHash
      || !publicReading(current.existing.payload, current.material, current.existing.at) || previous?.after?.planHash !== planHash
      || previous.after.generatedAt !== current.existing.at.toISOString()) refuse("completed recovery no longer matches its audited reading");
  } else if (current.existing || previous) refuse("recovery would replace an existing interpretation or audit");
  return { ...current, receipt, payload, evidence, planHash };
}

/** Explicit incident recovery only: preview the persisted response, never contact a provider. */
export async function previewReadingRecovery(value: unknown) {
  const request = ReadingRecoveryRequest.parse(value);
  recoveryValves();
  return sql.begin("isolation level repeatable read read only", async tx => {
    const current = await recoveryPlan(request, tx);
    return { request, planHash: current.planHash, responseHash: current.evidence.responseHash, existing: !!current.existing,
      preview: { sections: publicReading(current.payload, current.material, current.receipt.received_at)!.sections,
        links: current.payload.draft.links.map(({ label, url }) => ({ label, url })) } };
  });
}

/** The reading, completion and operator audit commit together; attempts and original errors are retained. */
export async function applyReadingRecovery(value: unknown, approvedPlanHash: string) {
  const request = ReadingRecoveryRequest.parse(value);
  if (!/^[a-f0-9]{64}$/.test(approvedPlanHash)) refuse("invalid recovery plan identity");
  recoveryValves();
  return sql.begin("isolation level serializable", async tx => {
    await tx`SET LOCAL lock_timeout='5s'`;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'reading:' + request.articleId}))`;
    const current = await recoveryPlan(request, tx, true);
    if (current.planHash !== approvedPlanHash) refuse("approved recovery plan changed");
    if (current.existing) return { status: "reused", ...request, generatedAt: current.existing.at.toISOString() };
    const [saved] = await tx`INSERT INTO reading_entries (article_id,revision,analysis_id,material_hash,version,receipt_id,payload)
      VALUES (${request.articleId},${request.revision},${request.analysisId},${request.materialHash},${VERSION},${request.receiptId},${tx.json(current.payload as never)}) RETURNING created_at`;
    const generatedAt = saved!.created_at.toISOString();
    await completeReceipt(tx as Tx, request.receiptId);
    await audit("operator", RECOVERY_ACTION, `article:${request.articleId}`,
      "Recover a saved reading response after link-label format validation repair; no provider request sent.",
      { receiptStatus: "failed" }, { ...current.evidence, planHash: current.planHash, generatedAt },
      { requestId: `reading-recovery:${request.receiptId}`, db: tx });
    return { status: "recovered", ...request, generatedAt };
  });
}
