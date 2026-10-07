import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SITE } from "@aihot/site";
import { CATEGORIES, ENTITIES, TOPIC_TAGS, CATEGORY_TAGS } from "@aihot/industry/taxonomy";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("AgentHot identity is independent while preserving the upstream attribution", () => {
  assert.equal(SITE.name, "AgentHot");
  assert.equal(SITE.subject, "Agent");
  assert.equal(SITE.mcpPrefix, "agenthot");
  assert.equal(SITE.organization.name, SITE.name);
  assert.match(SITE.footerNote!, /AIHOT/);
});

test("candidate sources are public RSS with summary-only publication", () => {
  const { sources } = JSON.parse(read("industry/sources.json"));
  assert.equal(sources.length, 8);
  assert.equal(new Set(sources.map((s: { id: string }) => s.id)).size, sources.length);
  for (const s of sources) {
    assert.equal(s.kind, "rss");
    assert.equal(new URL(s.config.feedUrl).protocol, "https:");
    assert.equal(s.site_fulltext, false);
    assert.equal(s.syndicate_fulltext, false);
    if (s.owner_entity_id) assert.ok(ENTITIES[s.owner_entity_id]);
  }
});

test("topic tags and entities stay inside the industry vocabulary", () => {
  const { topics, groups } = JSON.parse(read("industry/topics.json"));
  const tags = new Set<string>([...TOPIC_TAGS, ...CATEGORY_TAGS]);
  assert.equal(new Set(topics.map((t: { slug: string }) => t.slug)).size, topics.length);
  for (const t of topics) {
    assert.ok(groups.some((g: { key: string }) => g.key === t.group));
    if (t.entityId) assert.ok(ENTITIES[t.entityId]);
    for (const tag of t.tags ?? []) assert.ok(tags.has(tag), tag);
  }
  assert.equal(new Set(CATEGORIES.map((c) => c.key)).size, CATEGORIES.length);
  for (const tag of TOPIC_TAGS) assert.ok(read("industry/prompts/content-understanding.md").includes(tag), tag);
});

test("the preview template does not enable external actions", () => {
  const env = read(".env.example");
  for (const flag of ["COLLECT_ENABLED", "MODEL_CALLS_ENABLED", "FEISHU_CONTENT_PUSH_ENABLED", "FEISHU_INTERNAL_ENABLED", "INDEXNOW_SUBMIT_ENABLED"]) {
    assert.match(env, new RegExp(`^${flag}=false$`, "m"));
  }
});
