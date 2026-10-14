import "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { XMLParser } from "fast-xml-parser";
import { MCP_TOOL_NAMES } from "@aihot/contracts/mcp";
import { closeDb, sql } from "@aihot/backend/db";
import { dailyWithNotes, loadReport, v1Daily } from "@aihot/backend/publication/reports";
import { reportFeed } from "@aihot/backend/publication/feeds";
import { buildApp } from "../apps/api/src/app.ts";

const key = "2026-10-15";
const actual = "2026-10-14T18:45:00.000Z";
const scheduled = "2026-10-15T00:00:00.000Z";
const app = await buildApp();
let address: string;
let earlyFeed: string;
before(async () => {
  await sql`INSERT INTO reports(kind,key,window_start,window_end,generated_at,origin,content)
    VALUES ('daily',${key},'2026-10-14T00:00:00Z',${actual},${actual},'manual',${sql.json({
      sections: [], flashes: [], windowEnd: scheduled,
      edition: { status: "provisional", scheduledWindowEnd: scheduled },
    })})`;
  address = await app.listen({ host: "127.0.0.1", port: 0 });
});
after(async () => { app.server.closeAllConnections(); await app.close(); await closeDb(); });

test("the public early-edition metadata uses the stored actual cutoff, without changing v1 fields", async () => {
  const expected = { status: "provisional", windowEnd: actual, scheduledWindowEnd: scheduled };
  assert.deepEqual((await loadReport("daily", key))!.edition, expected);
  assert.deepEqual((await dailyWithNotes(key))!.edition, expected);
  const v1 = (await v1Daily(key))!.report;
  assert.equal(v1.windowEnd, actual);
  assert.ok(!("edition" in v1), "v1 remains stable; Agent transports receive metadata separately");
});

test("RSS describes the actual early cutoff without claiming its scheduled future window", async () => {
  earlyFeed = await reportFeed("daily");
  const item = new XMLParser({ ignoreAttributes: false }).parse(earlyFeed).rss.channel.item;
  assert.match(item.description, /提前版 · 截至 2026-10-15 02:45（UTC\+8）/);
  assert.doesNotMatch(item.description, /08:00/);
  assert.deepEqual(item.guid, { "#text": "daily-2026-10-15", "@_isPermaLink": "false" });
});

test("HTTP Agent and the real MCP daily tool both identify the partial window", async () => {
  const check = (text: string) => {
    assert.match(text, /提前版/);
    assert.match(text, /10-15 02:45/);
    assert.match(text, /正式窗口截止 .*10-15 08:00 后补齐/);
    assert.doesNotMatch(text, /固定成品/);
  };
  for (const path of [`/api/v1/agent/daily/${key}`, "/api/v1/agent/daily"]) {
    const response = await app.inject(path);
    assert.equal(response.statusCode, 200);
    check(response.body);
  }
  const client = new Client({ name: "provisional-check", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/api/mcp`)));
    const result = await client.callTool({ name: MCP_TOOL_NAMES.daily, arguments: { date: key } });
    assert.ok(!result.isError);
    check(result.content.filter(part => part.type === "text").map(part => part.text).join("\n"));
  } finally {
    await client.close();
  }
});

test("finalizing an early issue removes the label and restores the ordinary Agent wording", async () => {
  await sql`UPDATE reports SET window_end=${scheduled},content=content-'edition' WHERE kind='daily' AND key=${key}`;
  assert.ok(!("edition" in (await loadReport("daily", key))!));
  assert.equal((await dailyWithNotes(key))!.edition, undefined);
  const response = await app.inject(`/api/v1/agent/daily/${key}`);
  assert.equal(response.statusCode, 200);
  assert.doesNotMatch(response.body, /提前版/);
  assert.match(response.body, /固定成品/);
  const finalFeed = await reportFeed("daily");
  assert.doesNotMatch(finalFeed, /提前版/);
  const parser = new XMLParser({ ignoreAttributes: false });
  const finalItem = parser.parse(finalFeed).rss.channel.item;
  const earlyItem = parser.parse(earlyFeed).rss.channel.item;
  assert.deepEqual(finalItem.guid, earlyItem.guid);
  assert.equal(finalItem.link, earlyItem.link);
});

test("only explicit, valid early-edition metadata is public", async () => {
  for (const edition of [null, { status: "final", scheduledWindowEnd: scheduled }, { status: "provisional", scheduledWindowEnd: "invalid" }, { status: "provisional", scheduledWindowEnd: actual }]) {
    await sql`UPDATE reports SET window_end=${actual},content=${sql.json({ sections: [], edition } as never)} WHERE kind='daily' AND key=${key}`;
    assert.ok(!("edition" in (await loadReport("daily", key))!));
    assert.equal((await dailyWithNotes(key))!.edition, undefined);
  }
});
