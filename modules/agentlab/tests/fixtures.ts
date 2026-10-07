import { semanticDigest, type AgentLabItem, type Snapshot } from "../contract.ts";

export const NOW = new Date("2026-10-07T12:00:00.000Z");
export function item(changes: Partial<AgentLabItem> = {}): AgentLabItem {
  const value: AgentLabItem = {
    id: "agentlab:release:codex:1.0.0", kind: "release", agentId: "codex", version: "1.0.0",
    url: "https://agentlab.dairui1.com/?mode=compare&agent=codex&version=1.0.0",
    title: "Codex 1.0.0: Tool permission update", summary: "AgentLab analysis: permission checks now cover nested tools.",
    contentText: "AgentLab analysis, not an official statement. Evidence: a versioned release.",
    publishedAt: "2026-10-06T12:00:00.000Z", dateKind: "published", revision: "",
    analysisStatus: "complete", evidenceDigest: "a".repeat(64), sourceFreshness: "fresh",
    sources: [{ sourceType: "official-release", repository: "openai/codex", url: "https://github.com/openai/codex/releases/tag/1.0.0" }],
    importance: "medium", signals: ["tools"], ...changes,
  };
  value.revision = semanticDigest(value, "revision");
  return value;
}

export function removal(id: string, reason: string) {
  const value = { id, reason, revision: "" };
  value.revision = semanticDigest(value, "revision");
  return value;
}

export function feed(changes: Partial<Snapshot> = {}): Snapshot {
  const value: Snapshot = { schemaVersion: 1, generatedAt: "2026-10-07T00:00:00.000Z", exportedAt: "2026-10-07T01:00:00.000Z",
    snapshotDigest: "", coverage: { scope: "all-known-releases", absenceMeansWithdrawal: false, researchIncluded: false },
    items: [item()], suppressed: [], withdrawn: [], ...changes };
  value.snapshotDigest = semanticDigest(value, "snapshotDigest");
  return value;
}
