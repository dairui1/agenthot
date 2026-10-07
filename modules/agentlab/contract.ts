import net from "node:net";
import { z } from "zod";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { isBlockedAddress } from "@aihot/backend/lib/url";

export const SOURCE_ID = "agentlab";
export const FEED_URL = "https://agentlab.dairui1.com/data/syndication.json";
export const POLL_MS = 30 * 60 * 1000;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(300).startsWith("agentlab:release:");
const timestamp = z.iso.datetime({ offset: true });
const safeUrl = z.string().max(4000).refine((s) => {
  try {
    if (/[\s<>\u0000-\u001f\u007f]/u.test(s)) return false;
    const u = new URL(s);
    const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password
      && host !== "localhost" && !host.endsWith(".localhost") && !host.endsWith(".local")
      && (!net.isIP(host) || !isBlockedAddress(host));
  } catch { return false; }
}, "unsafe source URL");
const source = z.object({ url: safeUrl.optional(), sourceType: z.string().max(100).optional() }).passthrough();
const item = z.object({
  id, kind: z.literal("release"), url: safeUrl, title: z.string().min(1).max(1000),
  summary: z.string().min(1).max(20000), contentText: z.string().min(1).max(100000),
  publishedAt: timestamp, dateKind: z.enum(["published", "captured"]), revision: digest,
  analysisStatus: z.enum(["complete", "reviewed"]), evidenceDigest: digest,
  sources: z.array(source).min(1).max(100).refine((sources) => sources.some((s) => s.url), "missing public evidence URL"),
  sourceFreshness: z.enum(["fresh", "stale", "degraded", "not-synced", "not-collected", "unknown"]),
  agentId: z.string().min(1).max(100), version: z.string().min(1).max(150),
  importance: z.enum(["high", "medium", "low"]), signals: z.array(z.string().max(100)).min(1).max(20),
}).strict();
const removal = z.object({ id, reason: z.string().min(1).max(1000), revision: digest }).strict();
const snapshot = z.object({
  schemaVersion: z.literal(1), generatedAt: timestamp, exportedAt: timestamp, snapshotDigest: digest,
  coverage: z.object({ scope: z.literal("all-known-releases"), absenceMeansWithdrawal: z.literal(false), researchIncluded: z.literal(false) }).strict(),
  items: z.array(item).max(20000), suppressed: z.array(removal).max(20000), withdrawn: z.array(removal).max(20000),
}).strict();
export type AgentLabItem = z.infer<typeof item>;
export type Snapshot = z.infer<typeof snapshot>;

export function semanticDigest(value: Record<string, unknown>, field: string): string {
  return sha256(stableJson(Object.fromEntries(Object.entries(value).filter(([key]) => key !== field))));
}

/** Reject the whole snapshot before writing anything; omission is never a withdrawal. */
export function parseSnapshot(value: unknown, now = new Date()): Snapshot {
  const result = snapshot.parse(value);
  if (semanticDigest(result, "snapshotDigest") !== result.snapshotDigest) throw new Error("AgentLab snapshot digest mismatch");
  const future = now.getTime() + 5 * 60 * 1000;
  if (Date.parse(result.generatedAt) > future || Date.parse(result.exportedAt) > future) throw new Error("AgentLab snapshot is from the future");
  const ids = new Set<string>();
  for (const row of [...result.items, ...result.suppressed, ...result.withdrawn]) {
    if (ids.has(row.id)) throw new Error(`Duplicate AgentLab identity: ${row.id}`);
    ids.add(row.id);
    if (semanticDigest(row, "revision") !== row.revision) throw new Error(`AgentLab revision digest mismatch: ${row.id}`);
  }
  for (const row of result.items) {
    const u = new URL(row.url);
    if (u.origin !== new URL(FEED_URL).origin || u.pathname !== "/" || u.hash
      || u.searchParams.size !== 3 || u.searchParams.get("mode") !== "compare"
      || u.searchParams.get("agent") !== row.agentId || u.searchParams.get("version") !== row.version
      || row.id !== `agentlab:release:${row.agentId}:${row.version}`) throw new Error(`Invalid AgentLab item identity: ${row.id}`);
    if (Date.parse(row.publishedAt) > future) throw new Error(`AgentLab item is from the future: ${row.id}`);
  }
  return result;
}
