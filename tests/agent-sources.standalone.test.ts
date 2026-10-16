import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";
import { admitListing } from "@aihot/backend/sources/filters";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import { fetchRss } from "@aihot/backend/sources/rss";
import type { SourceRow } from "@aihot/backend/sources/types";

type ConfiguredSource = SourceRow & { site_fulltext: boolean; syndicate_fulltext: boolean };
const { sources } = JSON.parse(readFileSync(new URL("../industry/sources.json", import.meta.url), "utf8")) as { sources: ConfiguredSource[] };
const added = sources.slice(8);
const expected = {
  "json-github-claude-code": "https://api.github.com/repos/anthropics/claude-code/releases?per_page=30",
  "rss-cursor-changelog": "https://cursor.com/changelog/rss.xml",
  "json-github-codex": "https://api.github.com/repos/openai/codex/releases/latest",
  "json-github-openai-agents-python": "https://api.github.com/repos/openai/openai-agents-python/releases?per_page=30",
  "rss-langchain-blog": "https://www.langchain.com/blog/rss.xml",
  "json-github-langgraph": "https://api.github.com/repos/langchain-ai/langgraph/releases?per_page=30",
  "json-github-agent-framework": "https://api.github.com/repos/microsoft/agent-framework/releases?per_page=30",
  "json-github-browser-use": "https://api.github.com/repos/browser-use/browser-use/releases?per_page=30",
  "json-github-playwright-mcp": "https://api.github.com/repos/microsoft/playwright-mcp/releases?per_page=30",
  "json-github-mcp-spec": "https://api.github.com/repos/modelcontextprotocol/modelcontextprotocol/releases?per_page=30",
};

const previousDispatcher = getGlobalDispatcher();
const previousPrivate = config.allowPrivateNetworkFetch;
const previousProxy = config.egressProxyUrl;
const mockAgent = new MockAgent();
mockAgent.disableNetConnect();
setGlobalDispatcher(mockAgent);
config.allowPrivateNetworkFetch = true;
config.egressProxyUrl = null;
after(async () => {
  config.allowPrivateNetworkFetch = previousPrivate;
  config.egressProxyUrl = previousProxy;
  setGlobalDispatcher(previousDispatcher);
  await mockAgent.close();
});
const reply = (source: SourceRow, value: unknown) => {
  const url = new URL(source.config.url ?? source.config.feedUrl);
  mockAgent.get(url.origin).intercept({ path: url.pathname + url.search }).reply(200,
    typeof value === "string" ? value : JSON.stringify(value));
};

test("the original eight source definitions are unchanged", () => {
  const original = [
    ["rss-openai-news", "OpenAI News", "https://openai.com/news/rss.xml", "openai", 120, ["官方"]],
    ["rss-google-deepmind", "Google DeepMind", "https://deepmind.google/blog/rss.xml", "google", 120, ["官方"]],
    ["rss-google-research", "Google Research", "https://research.google/blog/rss/", "google", 120, ["官方", "研究"]],
    ["rss-hugging-face", "Hugging Face Blog", "https://huggingface.co/blog/feed.xml", "hugging-face", 120, ["官方", "开源"]],
    ["rss-microsoft-research", "Microsoft Research", "https://www.microsoft.com/en-us/research/feed/", "microsoft", 120, ["官方", "研究"]],
    ["rss-aws-ml", "AWS Machine Learning Blog", "https://aws.amazon.com/blogs/machine-learning/feed/", null, 120, ["官方", "教程"]],
    ["rss-github-ai", "GitHub Blog · AI & ML", "https://github.blog/ai-and-ml/feed/", null, 120, ["官方"]],
    ["rss-bair", "Berkeley AI Research", "https://bair.berkeley.edu/blog/feed.xml", null, 180, ["研究"]],
  ];
  assert.deepEqual(sources.slice(0, 8), original.map(([id, name, feedUrl, owner_entity_id, interval_minutes, tags]) => ({
    id, name, kind: "rss", config: { feedUrl, _aihot: { initialBackfillLimit: 8 } }, tier: "T1",
    owner_entity_id, participation_mode: "editorial", interval_minutes, tags, site_fulltext: false, syndicate_fulltext: false,
  })));
});

test("only the ten confirmed official entries are added with bounded history and summary-only publication", () => {
  assert.equal(sources.length, 18);
  assert.equal(new Set(sources.map(source => source.id)).size, 18);
  assert.deepEqual(Object.fromEntries(added.map(source => [source.id, source.config.feedUrl ?? source.config.url])), expected);
  for (const source of added) {
    assert.deepEqual(unsupportedConfig(source.kind, source.config), [], source.id);
    assert.equal(source.enabled, true, source.id);
    assert.equal(source.tier, "T1", source.id);
    assert.equal(source.participation_mode, "editorial", source.id);
    assert.equal(source.config._aihot.initialBackfillLimit, 8, source.id);
    assert.equal(source.config.sortByPublishedAt, true, source.id);
    assert.equal(source.site_fulltext, false, source.id);
    assert.equal(source.syndicate_fulltext, false, source.id);
    assert.equal(new URL(source.config.feedUrl ?? source.config.url).protocol, "https:");
    if (source.kind === "rss") assert.notEqual(source.config.summaryIsBody, true, source.id);
    else {
      assert.deepEqual(source.config.requireBoolean, { path: "prerelease", equals: false });
      assert.equal(source.config.summaryIsBody, true);
      assert.equal(source.config.publishedAtPath, "published_at");
      assert.equal(source.config.singletonItem === true, source.id === "json-github-codex");
    }
  }
});

test("the committed GitHub configs preserve release identity, full internal body and publication date while excluding prereleases", async () => {
  for (const source of added.filter(source => source.kind === "json_list")) {
    const prefix = source.config.allowUrlPrefixes[0];
    const release = { id: 123, name: "Release 1.2.3", tag_name: "v1.2.3", prerelease: false, draft: false,
      html_url: `${prefix}v1.2.3`, body: "Official complete release notes.",
      published_at: "2026-10-16T01:00:00Z", created_at: "2026-10-01T01:00:00Z" };
    const preview = { ...release, id: 124, name: "Preview", prerelease: true, html_url: `${prefix}v1.3.0-beta` };
    const wrongRepo = { ...release, id: 125, html_url: "https://github.com/unapproved/project/releases/tag/v1.2.3" };
    reply(source, source.config.singletonItem ? release : [release, preview, wrongRepo]);
    const rows = admitListing(await fetchJsonList(source), source);
    assert.equal(rows.length, 1, source.id);
    assert.equal(rows[0]!.url, release.html_url);
    assert.equal(rows[0]!.publishedAt?.toISOString(), "2026-10-16T01:00:00.000Z");
    assert.equal(rows[0]!.bodyText, release.body);
    assert.equal(rows[0]!.bodyStatus, "ok");
    assert.deepEqual(rows[0]!.raw, { externalId: 123 });
    if (source.config.singletonItem) {
      reply(source, preview);
      assert.deepEqual(await fetchJsonList(source), []);
    }
  }
});

test("the new RSS configs keep summaries pending and accept actual content bodies", async () => {
  for (const source of added.filter(source => source.kind === "rss")) {
    const summary = "A long summary is still not the article body. ".repeat(12);
    const content = "The publisher supplied the complete changelog entry. ".repeat(12);
    reply(source, `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
      <item><title>Summary only</title><link>https://publisher.example/summary</link><description>${summary}</description><pubDate>Fri, 16 Oct 2026 01:00:00 GMT</pubDate></item>
      <item><title>Full entry</title><link>https://publisher.example/full</link><content:encoded><![CDATA[<p>${content}</p>]]></content:encoded><pubDate>Fri, 16 Oct 2026 01:00:00 GMT</pubDate></item>
    </channel></rss>`);
    const { candidates } = await fetchRss(source);
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0]!.bodyStatus, "pending");
    assert.equal(candidates[0]!.bodyText, null);
    assert.equal(candidates[1]!.bodyStatus, "ok");
    assert.ok(candidates[1]!.bodyText?.includes("complete changelog"));
    assert.equal(candidates.every(row => row.publishedAt?.toISOString() === "2026-10-16T01:00:00.000Z"), true);
  }
});

test("Playwright MCP temporary untagged releases are excluded even when GitHub marks them non-prerelease", async () => {
  const source = added.find(source => source.id === "json-github-playwright-mcp")!;
  assert.deepEqual(source.config.denyUrlPrefixes, ["https://github.com/microsoft/playwright-mcp/releases/tag/untagged-"]);
  const release = (tag: string, id: number) => ({ id, name: tag, tag_name: tag, prerelease: false,
    html_url: `https://github.com/microsoft/playwright-mcp/releases/tag/${tag}`,
    body: "Published release notes", published_at: "2026-10-16T01:00:00Z" });
  reply(source, [release("untagged-abcdef", 1), release("v0.0.68", 2)]);
  const parsed = await fetchJsonList(source);
  assert.equal(parsed.length, 2, "GitHub's prerelease flag alone cannot reject this temporary tag");
  const admitted = admitListing(parsed, source);
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0]!.url, "https://github.com/microsoft/playwright-mcp/releases/tag/v0.0.68");
});
