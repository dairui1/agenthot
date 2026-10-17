import { z } from "zod";
import { closeDb } from "@aihot/backend/db";
import { checkReading, writeReading } from "./service.ts";

const id = z.string().regex(/^[a-z0-9]{20,32}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const binding = z.object({ articleId: id, revision: z.number().int().positive(), analysisId: z.number().int().positive(),
  materialHash: hash, planHash: hash.optional() }).strict();
const manifestSchema = z.object({ version: z.literal(1), items: z.array(binding).min(1).max(12) }).strict();
const selectionSchema = z.object({ version: z.literal(1), articleIds: z.array(id).min(1).max(12) }).strict();
type Binding = z.infer<typeof binding>;
type Checked = Awaited<ReturnType<typeof checkReading>>;
type Written = Awaited<ReturnType<typeof writeReading>>;
interface Dependencies { check: typeof checkReading; write: typeof writeReading }
const production: Dependencies = { check: checkReading, write: writeReading };

export class ReadingBatchError extends Error {
  readonly articleId: string | null;
  readonly completed: Written[];
  constructor(articleId: string | null, completed: Written[]) {
    super("Reading prerequisites or request failed; stopped without automatic retry");
    this.articleId = articleId;
    this.completed = completed;
  }
}

function selected(value: unknown, mode: "check" | "run"): Binding[] | string[] {
  const parsed = mode === "check" ? z.union([manifestSchema, selectionSchema]).parse(value) : manifestSchema.parse(value);
  const items = "items" in parsed ? parsed.items : parsed.articleIds;
  const ids = items.map(item => typeof item === "string" ? item : item.articleId);
  if (new Set(ids).size !== ids.length) throw new ReadingBatchError(null, []);
  if (mode === "run" && items.some(item => typeof item === "string" || !item.planHash)) throw new ReadingBatchError(null, []);
  return items;
}

/** Check the entire explicit selection before the first paid request; never expand it. */
export async function checkManifest(value: unknown, mode: "check" | "run" = "check", deps: Dependencies = production) {
  const items = selected(value, mode);
  const plans: Checked[] = [];
  for (const item of items) {
    const articleId = typeof item === "string" ? item : item.articleId;
    try {
      const checked = await deps.check(articleId);
      if (checked.articleId !== articleId) throw new Error("Article identity changed");
      if (typeof item !== "string" && (checked.revision !== item.revision || checked.analysisId !== item.analysisId
        || checked.materialHash !== item.materialHash || (item.planHash && checked.planHash !== item.planHash && !checked.existing))) throw new Error("Article binding changed");
      plans.push(checked);
    } catch {
      throw new ReadingBatchError(articleId, []);
    }
  }
  return { version: 1 as const, items: plans.map(({ articleId, revision, analysisId, materialHash, planHash }) =>
    ({ articleId, revision, analysisId, materialHash, planHash })), existing: plans.filter(plan => plan.existing).map(plan => plan.articleId) };
}

export async function runManifest(value: unknown, deps: Dependencies = production) {
  const checked = await checkManifest(value, "run", deps);
  const completed: Written[] = [];
  for (const item of checked.items) {
    try {
      const { planHash, ...binding } = item;
      completed.push(await deps.write(binding, planHash));
    } catch {
      throw new ReadingBatchError(item.articleId, completed);
    }
  }
  return completed;
}

export async function readingCli(value: unknown, mode: "--check" | "--run") {
  try {
    if (mode === "--check") {
      const { existing, ...manifest } = await checkManifest(value);
      console.log(JSON.stringify({ ok: true, mode: "check", manifest, existing }));
    } else {
      console.log(JSON.stringify({ ok: true, mode: "run", completed: await runManifest(value) }));
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, stage: "reading", error: "Reading prerequisites or request failed; stopped without automatic retry",
      articleId: error instanceof ReadingBatchError ? error.articleId : null,
      completed: error instanceof ReadingBatchError ? error.completed : [] }));
    process.exitCode = 1;
  } finally { await closeDb(); }
}
