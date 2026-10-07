import type { ItemProvenance } from "@aihot/contracts/site";
import { sql, type Db, type Tx } from "@aihot/backend/db";
import { contentHash, decideTimeline, reviseMaterial, upsertMaterial } from "@aihot/backend/content/materials";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { emit } from "@aihot/backend/modules";
import { publishArticleTx } from "@aihot/backend/publication/publish";
import { FEED_URL, parseSnapshot, SOURCE_ID, type AgentLabItem, type Snapshot } from "./contract.ts";

type State = { external_id: string; article_id: string | null; upstream_revision: string; status: string; payload: AgentLabItem };
export type SyncResult = { status: "ok" | "skipped"; found: number; created: number; updated: number; suppressed: number; reason?: string };

export async function ensureSource(): Promise<void> {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, interval_minutes, site_fulltext, syndicate_fulltext)
    VALUES (${SOURCE_ID}, 'AgentLab', 'external', 'T2', 'editorial', true, 30, false, false) ON CONFLICT (id) DO NOTHING`;
}

async function downloadSnapshot(): Promise<unknown> {
  const res = await guardedFetch(FEED_URL, { timeoutMs: 30000, maxBytes: 32 * 1024 * 1024, maxRedirects: 0, headers: { accept: "application/json", "cache-control": "no-cache" } });
  if (res.status !== 200) throw new Error(`AgentLab feed HTTP ${res.status}`);
  return JSON.parse(res.text());
}

export async function publicationRestriction(articleId: string, db: Db): Promise<"withdrawn" | null> {
  const [row] = await db`SELECT 1 FROM agentlab_items WHERE article_id = ${articleId} AND status <> 'active'`;
  return row ? "withdrawn" : null;
}

export async function syncHealth(now = new Date()): Promise<{ healthy: boolean; status: string }> {
  const [source] = await sql<{ enabled: boolean; last_ok_at: Date | null; last_error: string | null }[]>`
    SELECT enabled, last_ok_at, last_error FROM sources WHERE id = ${SOURCE_ID}`;
  if (!source) return { healthy: false, status: "not-initialized" };
  if (!source.enabled) return { healthy: true, status: "paused" };
  if (source.last_error) return { healthy: false, status: "last-sync-failed" };
  return source.last_ok_at && now.getTime() - source.last_ok_at.getTime() <= 90 * 60000
    ? { healthy: true, status: "ok" } : { healthy: false, status: "stale" };
}

export async function itemProvenance(articleId: string, db: Db): Promise<ItemProvenance | null> {
  const [row] = await db<State[]>`SELECT payload FROM agentlab_items WHERE article_id = ${articleId} AND status = 'active'`;
  if (!row) return null;
  const p = row.payload;
  return { name: "AgentLab", url: p.url, analysisStatus: p.analysisStatus, agentId: p.agentId, version: p.version,
    dateKind: p.dateKind, revision: p.revision, sourceFreshness: p.sourceFreshness,
    sources: [...new Map(p.sources.filter((s) => s.url).map((s) => [s.url, {
      label: [s.sourceType, typeof s.repository === "string" ? s.repository : null].filter(Boolean).join(" · ") || "Source",
      url: s.url!, kind: s.sourceType,
    }])).values()] };
}

async function publish(tx: Tx, articleId: string): Promise<void> {
  const result = await publishArticleTx(tx, articleId);
  if (result?.changed) await emit("articleChanged", { id: articleId, kind: result.changeKind, reduced: result.reduced, reason: "AgentLab syndication" }, tx);
}

async function importSnapshot(tx: Tx, feed: Snapshot, first: boolean, now: Date): Promise<SyncResult> {
  const result: SyncResult = { status: "ok", found: feed.items.length, created: 0, updated: 0, suppressed: 0 };
  const existing = new Map((await tx<State[]>`SELECT * FROM agentlab_items`).map((r) => [r.external_id, r]));
  for (const item of feed.items) {
    const before = existing.get(item.id);
    const reason = item.sourceFreshness !== "fresh" ? `source-${item.sourceFreshness}` : item.dateKind !== "published" ? "publication-date-unverified" : null;
    const status = reason ? "suppressed" : "active";
    if (before?.upstream_revision === item.revision && before.status === status) continue;
    const material = await upsertMaterial({ sourceId: SOURCE_ID, identityKey: item.id, url: item.url, title: item.title,
      language: "zh", author: "AgentLab", publishedAt: item.dateKind === "published" ? new Date(item.publishedAt) : null,
      excerpt: item.summary, bodyText: item.contentText, bodyStatus: "ok", raw: { agentlab: item }, via: "agentlab", discoveredAt: now,
      backfill: first ? "agentlab-initial-import" : null }, tx);
    const articleId = material.articleId;
    const [article] = await tx<{ revision: number; content_hash: string; source_id: string; discovered_at: Date; backfill_reason: string | null }[]>`
      SELECT revision, content_hash, source_id, discovered_at, backfill_reason FROM articles WHERE id = ${articleId} FOR UPDATE`;
    if (article.source_id !== SOURCE_ID) throw new Error("AgentLab identity belongs to another source");
    // The generic collector ignores a return to previously seen text. An explicit upstream revision
    // is authoritative, so an intentional correction/revert still replaces the stored material.
    const hash = contentHash({ title: item.title, excerpt: item.summary, bodyText: item.contentText });
    if (article.content_hash !== hash) await reviseMaterial(tx, articleId, {
      set: sql`title = ${item.title}, excerpt = ${item.summary}, body_text = ${item.contentText}`, hash, title: item.title, bodyText: item.contentText,
    });
    const publishedAt = item.dateKind === "published" ? new Date(item.publishedAt) : null;
    const explicitBackfill = ["unknown-publication-time", "stale-on-discovery"].includes(article.backfill_reason ?? "") ? null : article.backfill_reason;
    const timeline = decideTimeline(publishedAt, article.discovered_at, explicitBackfill);
    await tx`UPDATE articles SET url = ${item.url}, raw = ${tx.json({ agentlab: item } as never)},
      published_at = ${timeline.publishedAt}, published_at_claim = ${publishedAt},
      timeline_at = ${timeline.timelineAt}, backfill = ${timeline.backfill}, backfill_reason = ${timeline.backfillReason},
      processing_state = 'analyzed', processing_error = NULL, grouping_status = 'complete', grouped_at = coalesce(grouped_at, ${now})
      WHERE id = ${articleId}`;
    await tx`INSERT INTO analyses (article_id, input_revision, origin, model, prompt_version, relevance, category, tags, title_zh, summary_zh, score, selected, output)
      SELECT id, revision, 'rule', NULL, 'agentlab-syndication-v1', 'pass', 'ai-products', ARRAY['产品更新', 'Agent'],
        ${item.title}, ${item.summary}, NULL, false, ${tx.json({ provenance: "AgentLab", importedAnalysis: true, agentlab: item } as never)}
      FROM articles WHERE id = ${articleId}`;
    await tx`INSERT INTO agentlab_items (external_id, article_id, upstream_revision, status, reason, payload)
      VALUES (${item.id}, ${articleId}, ${item.revision}, ${status}, ${reason}, ${tx.json(item as never)})
      ON CONFLICT (external_id) DO UPDATE SET article_id = EXCLUDED.article_id, upstream_revision = EXCLUDED.upstream_revision,
        status = EXCLUDED.status, reason = EXCLUDED.reason, payload = EXCLUDED.payload, updated_at = now()`;
    await publish(tx, articleId);
    if (material.created) result.created += 1; else result.updated += 1;
    if (reason) result.suppressed += 1;
  }
  for (const [status, entries] of [["suppressed", feed.suppressed], ["withdrawn", feed.withdrawn]] as const) {
    for (const item of entries) {
      const before = existing.get(item.id);
      if (before?.upstream_revision === item.revision && before.status === status) continue;
      await tx`INSERT INTO agentlab_items (external_id, upstream_revision, status, reason, payload)
        VALUES (${item.id}, ${item.revision}, ${status}, ${item.reason}, ${tx.json(item as never)})
        ON CONFLICT (external_id) DO UPDATE SET upstream_revision = EXCLUDED.upstream_revision,
          status = EXCLUDED.status, reason = EXCLUDED.reason, updated_at = now()`;
      if (before?.article_id) { await publish(tx, before.article_id); result.updated += 1; }
      result.suppressed += 1;
    }
  }
  return result;
}

/** Dedicated pull, independent of paid processing and the general collection worker. */
export async function syncAgentLab(options: { load?: () => Promise<unknown>; now?: Date } = {}): Promise<SyncResult> {
  await ensureSource();
  const now = options.now ?? new Date();
  try {
    return await sql.begin(async (tx) => {
      // Keep the fetch within the lock: a slow older response must not overwrite a newer snapshot.
      const [lock] = await tx<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('agentlab-syndication')) AS locked`;
      if (!lock.locked) return { status: "skipped", found: 0, created: 0, updated: 0, suppressed: 0, reason: "already-running" };
      const [source] = await tx<{ enabled: boolean; kind: string; cursor: { initializedAt?: string; generatedAt?: string; exportedAt?: string; snapshotDigest?: string } | null }[]>`
        SELECT enabled, kind, cursor FROM sources WHERE id = ${SOURCE_ID} FOR UPDATE`;
      if (!source.enabled) return { status: "skipped", found: 0, created: 0, updated: 0, suppressed: 0, reason: "paused" };
      if (source.kind !== "external") throw new Error("AgentLab source kind must be external");
      const feed = parseSnapshot(await (options.load ?? downloadSnapshot)(), now);
      if (source.cursor?.exportedAt && (Date.parse(feed.exportedAt) < Date.parse(source.cursor.exportedAt)
        || (Date.parse(feed.exportedAt) === Date.parse(source.cursor.exportedAt) && feed.snapshotDigest !== source.cursor.snapshotDigest))) {
        throw new Error("AgentLab snapshot predates or conflicts with last successful import");
      }
      const result = await importSnapshot(tx, feed, !source.cursor?.initializedAt, now);
      const cursor = { initializedAt: source.cursor?.initializedAt ?? now.toISOString(), generatedAt: feed.generatedAt, exportedAt: feed.exportedAt, snapshotDigest: feed.snapshotDigest };
      await tx`UPDATE sources SET cursor = ${tx.json(cursor)}, last_fetch_at = ${now}, last_ok_at = ${now}, health = 'ok',
        fail_count = 0, last_error = NULL, next_fetch_at = ${new Date(now.getTime() + 30 * 60000)}, updated_at = now() WHERE id = ${SOURCE_ID}`;
      await tx`INSERT INTO fetch_runs (source_id, status, started_at, finished_at, found_count, new_count, detail)
        VALUES (${SOURCE_ID}, 'ok', ${now}, now(), ${result.found}, ${result.created}, ${tx.json({ ...result, exportedAt: feed.exportedAt, snapshotDigest: feed.snapshotDigest })})`;
      return result;
    }) as SyncResult;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1500) : "AgentLab sync failed";
    await sql.begin(async (tx) => {
      await tx`UPDATE sources SET last_fetch_at = ${now}, fail_count = fail_count + 1, last_error = ${message},
        health = CASE WHEN fail_count + 1 >= 5 THEN 'failing' ELSE 'degraded' END, updated_at = now()
        WHERE id = ${SOURCE_ID} AND enabled AND (last_ok_at IS NULL OR last_ok_at <= ${now})`;
      await tx`INSERT INTO fetch_runs (source_id, status, started_at, finished_at, error) VALUES (${SOURCE_ID}, 'failed', ${now}, now(), ${message})`;
    });
    throw error;
  }
}
