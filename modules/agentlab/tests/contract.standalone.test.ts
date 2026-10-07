import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSnapshot, semanticDigest } from "../contract.ts";
import { feed, item, NOW, removal } from "./fixtures.ts";

test("a complete evidence-bearing snapshot retains provenance and validates all semantic hashes", () => {
  const snapshot = feed({ items: [item({ sources: [
    { sourceType: "placeholder", repository: "openai/codex", contentSha256: "a".repeat(64) },
    { sourceType: "official-release", url: "https://github.com/openai/codex" },
  ] })], suppressed: [removal("agentlab:release:other:1", "analysis-incomplete")] });
  assert.deepEqual(parseSnapshot(snapshot, NOW), snapshot);
});

test("unknown schema, unknown fields, malformed hashes and duplicate/conflicting identities fail the entire snapshot", () => {
  assert.throws(() => parseSnapshot({ ...feed(), schemaVersion: 2 }, NOW));
  assert.throws(() => parseSnapshot({ ...feed(), unrecognized: true }, NOW));
  assert.throws(() => parseSnapshot({ ...feed(), snapshotDigest: "0".repeat(64) }, NOW));
  const changed = feed(); changed.items[0].summary += " edited";
  changed.snapshotDigest = semanticDigest(changed, "snapshotDigest");
  assert.throws(() => parseSnapshot(changed, NOW), /revision digest/);
  assert.throws(() => parseSnapshot(feed({ items: [item(), item()] }), NOW), /Duplicate/);
  assert.throws(() => parseSnapshot(feed({ withdrawn: [removal(item().id, "retracted")] }), NOW), /Duplicate/);
});

test("fixed origin and exact query identity cannot be replaced by redirects, fragments or another version", () => {
  for (const url of ["https://evil.test/?mode=compare&agent=codex&version=1.0.0",
    "https://agentlab.dairui1.com/#codex", "https://agentlab.dairui1.com/?mode=compare&agent=codex&version=2.0.0",
    "https://agentlab.dairui1.com/?mode=compare&agent=codex&version=1.0.0&extra=1"]) {
    assert.throws(() => parseSnapshot(feed({ items: [item({ url })] }), NOW), /identity/);
  }
});

test("unsafe evidence links and missing publicly verifiable evidence are refused", () => {
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "https://user:pass@host.test/",
    "http://127.0.0.1/", "https://localhost./", "https://x.test/>\n\n![x](https://x.test/pixel)"]) {
    assert.throws(() => parseSnapshot(feed({ items: [item({ sources: [{ url }] })] }), NOW));
  }
  assert.throws(() => parseSnapshot(feed({ items: [item({ sources: [{ sourceType: "placeholder" }] })] }), NOW));
});

test("future timestamps and invalid calendar dates are refused, not silently treated as current news", () => {
  assert.throws(() => parseSnapshot(feed({ exportedAt: "2026-10-08T00:00:00.000Z" }), NOW), /future/);
  assert.throws(() => parseSnapshot(feed({ items: [item({ publishedAt: "2026-10-08T00:00:00.000Z" })] }), NOW), /future/);
  assert.throws(() => parseSnapshot(feed({ items: [item({ publishedAt: "2026-02-30T00:00:00.000Z" })] }), NOW));
});
