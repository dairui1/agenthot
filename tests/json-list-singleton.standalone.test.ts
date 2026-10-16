import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import type { SourceRow } from "@aihot/backend/sources/types";

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

const origin = "https://publisher.invalid";
const release = {
  id: 123, name: "0.163.0", tag_name: "rust-v0.163.0", prerelease: false,
  html_url: "https://github.com/openai/codex/releases/tag/rust-v0.163.0",
  body: "Complete release notes from the publisher.",
  published_at: "2026-10-15T21:30:38Z", created_at: "2026-10-14T01:00:00Z",
};
let serial = 0;
const source = (body: unknown, extra: Record<string, unknown> = {}): SourceRow => {
  const path = `/release-${serial++}`;
  mockAgent.get(origin).intercept({ path }).reply(200, JSON.stringify(body));
  return { id: "singleton-release", name: "Singleton release", kind: "json_list", cursor: null,
    tier: "T1", participation_mode: "editorial", first_party: true, interval_minutes: 120, enabled: true, fail_count: 0, config: {
    url: origin + path, singletonItem: true, titlePaths: ["name", "tag_name"],
    summaryPaths: ["body"], summaryIsBody: true, publishedAtPath: "published_at",
    externalIdPath: "id", urlTemplate: "{raw:html_url}", requireBoolean: { path: "prerelease", equals: false },
    ...extra,
  } };
};

test("explicit singleton releases preserve official dates, identity and complete body", async () => {
  const rows = await fetchJsonList(source(release));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.title, release.name);
  assert.equal(rows[0]!.url, release.html_url);
  assert.equal(rows[0]!.publishedAt?.toISOString(), "2026-10-15T21:30:38.000Z");
  assert.equal(rows[0]!.bodyText, release.body);
  assert.equal(rows[0]!.bodyStatus, "ok");
  assert.deepEqual(rows[0]!.raw, { externalId: release.id });
  assert.deepEqual(await fetchJsonList(source({ ...release, prerelease: true })), []);
});

test("singleton selection is explicit and supports a nested object without changing list mappings", async () => {
  assert.equal((await fetchJsonList(source({ result: release }, { itemsPath: "result" }))).length, 1);
  await assert.rejects(fetchJsonList(source(release, { singletonItem: false })), /items path did not resolve to an array/);
  assert.equal((await fetchJsonList(source([release], { singletonItem: false }))).length, 1);
  assert.equal((await fetchJsonList(source({ only: release }, { singletonItem: false, itemsObjectValues: true }))).length, 1);
});

test("singleton rejects changed response shapes and mutually exclusive object-value mapping", async () => {
  for (const value of [[], [release], null, "release", 3, false]) {
    await assert.rejects(fetchJsonList(source(value)), /singletonItem did not resolve to an object/);
  }
  await assert.rejects(fetchJsonList(source(release, { itemsObjectValues: true })), /singletonItem cannot use itemsObjectValues/);
});

test("singleton configuration is boolean, JSON-only and incompatible with object-value mapping", () => {
  for (const singletonItem of [true, false]) assert.deepEqual(unsupportedConfig("json_list", { singletonItem }), []);
  for (const singletonItem of ["true", 1, null, {}]) assert.deepEqual(unsupportedConfig("json_list", { singletonItem }), ["singletonItem"]);
  assert.deepEqual(unsupportedConfig("json_list", { singletonItem: true, itemsObjectValues: true }), ["singletonItem+itemsObjectValues"]);
  assert.deepEqual(unsupportedConfig("json_list", { singletonItem: true, itemsObjectValues: false }), []);
  assert.deepEqual(unsupportedConfig("rss", { singletonItem: true }), ["singletonItem"]);
});

test("singleton retains the normal 8 MiB response limit", async () => {
  await assert.rejects(fetchJsonList(source({ ...release, body: "x".repeat(8 * 1024 * 1024) })), /Response too large/);
});
