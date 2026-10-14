import { readFileSync } from "node:fs";
import { sql } from "@aihot/backend/db";
import { credential } from "@aihot/backend/config";
import { invalidateModelCache, modelFor } from "@aihot/backend/editorial/models";
import { processArticle, processExtraction } from "@aihot/backend/jobs/content";
import { groupArticle } from "@aihot/backend/events/group";
import { collectSource } from "@aihot/backend/sources/collect";
import { composeDaily, dueDaily } from "@aihot/backend/reports/compose";
import { DISABLED_VALVES, REQUIRED_MODELS, type Dependencies, type PendingArticle, type Snapshot, type Source } from "./workflow.ts";

const sourceFile = JSON.parse(readFileSync(new URL("../../industry/sources.json", import.meta.url), "utf8")) as {
  sources: Array<{ id: string; kind: string; participation_mode: string }>;
};
export const SOURCE_ALLOWLIST = sourceFile.sources.filter(source => source.kind === "rss" && source.participation_mode === "editorial").map(source => source.id);

export async function snapshot(): Promise<Snapshot> {
  const at = new Date();
  const key = dueDaily(at);
  const sources = await sql<Source[]>`SELECT id, enabled, kind, participation_mode AS "participationMode", health,
    last_ok_at::text AS "lastOkAt" FROM sources WHERE id = ANY(${SOURCE_ALLOWLIST}::text[]) ORDER BY id`;
  const [budget] = await sql<Array<{ perMinute: number; perHour: number; perDay: number }>>`
    SELECT per_minute AS "perMinute", per_hour AS "perHour", per_day AS "perDay" FROM budgets WHERE service = 'codex-cli'`;
  const pending = await sql<PendingArticle[]>`SELECT a.id, a.source_id AS "sourceId", a.processing_state AS "processingState",
    a.grouping_status AS "groupingStatus", a.body_status AS "bodyStatus", a.backfill,
    a.processing_retry_at::text AS "retryAt", a.discovered_at::text AS "discoveredAt", a.processing_attempt_tag AS "attemptTag",
    EXISTS (SELECT 1 FROM receipts r WHERE r.status IN ('pending', 'unknown') AND (
      r.id = a.grouping_receipt_id OR r.subject = 'article:' || a.id || '@' || a.revision::text
      OR (substring(r.subject from '^article:([^@:#]+)') = a.id AND r.subject NOT LIKE '%@%'
        AND r.created_at >= coalesce((SELECT created_at FROM article_revisions ar
          WHERE ar.article_id = a.id AND ar.revision = a.revision), a.created_at))
    )) AS "blockedReceipt"
    FROM articles a JOIN sources s ON s.id = a.source_id
    WHERE a.source_id = ANY(${SOURCE_ALLOWLIST}::text[]) AND s.enabled AND s.kind = 'rss' AND s.participation_mode = 'editorial'
      AND (a.processing_state IN ('new', 'failed') OR (a.processing_state = 'analyzed' AND a.grouping_status <> 'complete'
        AND (SELECT relevance FROM analyses WHERE article_id = a.id ORDER BY input_revision DESC, id DESC LIMIT 1) = 'pass'))`;
  const [report] = await sql<Array<{ entries: number }>>`SELECT coalesce((content->'metrics'->>'totalEvents')::int, 0) AS entries
    FROM reports WHERE kind = 'daily' AND key = ${key}`;
  invalidateModelCache();
  const models: Record<string, string> = {};
  for (const step of REQUIRED_MODELS) models[step] = await modelFor(step);
  return { at: at.toISOString(), allowlist: SOURCE_ALLOWLIST, sources, budget: budget ?? null, pending,
    valves: Object.fromEntries(["COLLECT_ENABLED", "MODEL_CALLS_ENABLED", ...DISABLED_VALVES].map(name => [name, process.env[name]])), models,
    adapterConfigured: !!credential("models", "CODEX_CLI_BASE_URL") && (credential("models", "CODEX_CLI_TOKEN")?.length ?? 0) >= 32,
    otherPaidProviders: !!(credential("models", "EMBEDDING_API_KEY") || credential("models", "DASHSCOPE_API_KEY") || credential("collectors", "JINA_API_KEY")),
    due: { key, exists: !!report, entries: report?.entries ?? null } };
}

export const production: Dependencies = {
  snapshot,
  collect: collectSource,
  extract: async id => (await processExtraction(id)).state,
  process: (id, attemptTag) => processArticle(id, { attemptTag }),
  group: groupArticle,
  compose: composeDaily,
};
