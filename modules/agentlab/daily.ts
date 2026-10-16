import { sql, type Db } from "@aihot/backend/db";
import { listedCondition } from "@aihot/backend/publication/scope";
import { SOURCE_ID, type AgentLabItem } from "./contract.ts";

/** Only version-specific GitHub release/tag evidence identifies the same release across sources. */
export function releaseUrls(item: Pick<AgentLabItem, "sources" | "agentId" | "version">): string[] {
  const urls = new Set<string>();
  for (const source of item.sources) {
    if (!source.url || source.sourceType !== "official-release") continue;
    const url = new URL(source.url);
    const match = /^\/([^/]+)\/([^/]+)\/releases\/tag\/(.+?)\/?$/.exec(url.pathname);
    if (url.origin !== "https://github.com" || !match) continue;
    const path = `${match[1]}/${match[2]}`;
    const tags = new Set([item.version, `v${item.version}`]);
    if (item.agentId === "codex" && path.toLowerCase() === "openai/codex") tags.add(`rust-v${item.version}`);
    if (item.agentId === "deepseek-harness" && path.toLowerCase() === "deepseek-ai/deepseek-harness") tags.add(`dsh-v${item.version}`);
    if (!tags.has(match[3]!)) continue;
    urls.add(`https://github.com/${path}/releases/tag/${match[3]}`);
  }
  // Evidence can cite a baseline or another project. Ambiguity is not permission to merge releases.
  return urls.size === 1 ? [...urls] : [];
}

/** The external editorial decision is not authority to override a later independent judgement. */
function admitted(db: Db, at: Date) {
  return db`i.status = 'active' AND i.payload->>'analysisStatus' IN ('complete', 'reviewed')
    AND i.payload->>'sourceFreshness' = 'fresh' AND i.payload->>'dateKind' = 'published'
    AND an.origin = 'rule' AND an.prompt_version = 'agentlab-syndication-v1'
    AND an.output->>'provenance' = 'AgentLab'
    AND ${listedCondition(at)} AND NOT p.backfill AND p.published_at IS NOT NULL
    AND s.participation_mode = 'editorial' AND s.tier <> 'EXCLUDE_MP'
    AND a.grouping_status = 'complete' AND a.selection_adds_value IS DISTINCT FROM false
    AND o.fields->'selected' IS DISTINCT FROM 'false'::jsonb`;
}

/** Stamp real admission after publication's lock waits; copy corrections do not move the cutoff. */
export async function publicationProjected(publication: { articleId: string; sourceId: string; at: Date }, db: Db): Promise<void> {
  if (publication.sourceId !== SOURCE_ID) return;
  await db`UPDATE agentlab_items target SET daily_visible_at = CASE WHEN decision.admitted
    THEN coalesce(target.daily_visible_at, ${publication.at}) ELSE NULL END
    FROM (
      SELECT i.article_id, (${admitted(db, publication.at)}) AS admitted
      FROM agentlab_items i JOIN publications p ON p.article_id = i.article_id
      JOIN articles a ON a.id = i.article_id JOIN sources s ON s.id = p.source_id
      LEFT JOIN analyses an ON an.id = p.analysis_id LEFT JOIN editorial_overrides o ON o.article_id = p.article_id
      WHERE i.article_id = ${publication.articleId}
    ) decision WHERE target.article_id = decision.article_id`;
}

/** IDs only: the engine reads current public copy and applies its normal windows and deduplication. */
export async function dailyReportCandidates(window: { start: Date; end: Date }, db: Db) {
  const rows = await db<Array<{ articleId: string; releasedAt: Date; payload: AgentLabItem }>>`
    SELECT i.article_id AS "articleId", i.daily_visible_at AS "releasedAt",
      i.payload
    FROM agentlab_items i JOIN publications p ON p.article_id = i.article_id
    JOIN articles a ON a.id = i.article_id JOIN sources s ON s.id = p.source_id
    JOIN analyses an ON an.id = p.analysis_id LEFT JOIN editorial_overrides o ON o.article_id = p.article_id
    WHERE p.source_id = ${SOURCE_ID} AND i.daily_visible_at IS NOT NULL AND i.daily_visible_at < ${window.end}
      AND ${admitted(db, window.end)}`;
  return rows.map(row => ({ articleId: row.articleId, releasedAt: row.releasedAt,
    arrangementKey: row.payload.agentId, equivalentUrls: releaseUrls(row.payload) }));
}

/** Explicit bounded bootstrap: confirm recent live material now, never invent its old release time. */
export async function reconcileDailyAdmissions(articleIds: readonly string[], options: { apply?: boolean } = {}): Promise<{ at: string; eligible: string[]; stamped: string[] }> {
  const ids = [...new Set(articleIds)].sort();
  return sql.begin(async tx => {
    if (ids.length) await tx`SELECT id FROM articles WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
    await tx`SELECT pg_advisory_xact_lock_shared(hashtext('report_candidates'))`;
    const at = new Date();
    if (!ids.length) return { at: at.toISOString(), eligible: [], stamped: [] };
    const rows = await tx<{ id: string }[]>`
      SELECT i.article_id AS id FROM agentlab_items i JOIN publications p ON p.article_id = i.article_id
      JOIN articles a ON a.id = i.article_id JOIN sources s ON s.id = p.source_id
      JOIN analyses an ON an.id = p.analysis_id LEFT JOIN editorial_overrides o ON o.article_id = p.article_id
      WHERE i.article_id = ANY(${ids}::text[]) AND p.source_id = ${SOURCE_ID} AND i.daily_visible_at IS NULL
        AND p.timeline_at >= ${new Date(at.getTime() - 86400000)} AND p.timeline_at <= ${at}
        AND ${admitted(tx, at)} ORDER BY i.article_id`;
    const eligible = rows.map(row => row.id);
    if (options.apply && eligible.length) await tx`UPDATE agentlab_items SET daily_visible_at = ${at}
      WHERE article_id = ANY(${eligible}::text[]) AND daily_visible_at IS NULL`;
    return { at: at.toISOString(), eligible, stamped: options.apply ? eligible : [] };
  });
}
