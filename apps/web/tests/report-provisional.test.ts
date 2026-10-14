// Real production SSR with a synthetic HTTP API: the label must show actual coverage, not publication time.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import type { ReportDetail } from "@aihot/contracts/site";
import { startWebServer, type WebServer } from "./web-server.ts";

const key = "2026-10-15";
const report: ReportDetail = { kind: "daily", key, issueNumber: 1, title: "Agent report", generatedAt: "2026-10-14T19:00:00.000Z",
  edition: { status: "provisional", windowEnd: "2026-10-14T18:45:00.000Z", scheduledWindowEnd: "2026-10-15T00:00:00.000Z" },
  lead: null, leadItemId: null, overview: null, highlights: [], sections: [], flashes: [], cover: null, metrics: {}, readingMinutes: 1, prev: null, next: null };
let web: WebServer;
const api = createServer((req, res) => {
  const path = new URL(req.url!, "http://api.local").pathname;
  res.setHeader("Content-Type", "application/json");
  if (path === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: "2026-10-15T02:45" }));
  if (path.endsWith("/latest-page")) return res.end(JSON.stringify({ index: [], report }));
  if (path.includes("/navigation/")) return res.end(JSON.stringify({ items: [] }));
  if (path === `/api/site/reports/daily/${key}`) return res.end(JSON.stringify(report));
  res.statusCode = 404;
  res.end(JSON.stringify({ code: "not_found" }));
});
before(async () => { web = await startWebServer(api); });
after(() => web.stop());

test("the early daily masthead states its actual UTC+8 cutoff on both latest and permalink pages", async () => {
  for (const path of ["/daily", `/daily/${key}`]) {
    const response = await fetch(`${web.origin}${path}`);
    assert.equal(response.status, 200, web.logs());
    const html = await response.text();
    const header = /<header class="pt-5 lg:pt-0">([\s\S]*?)<\/header>/.exec(html)?.[1] ?? "";
    assert.match(header.replace(/<[^>]+>/g, ""), /提前版 · 截至 10月15日 02:45（UTC\+8）/);
    assert.match(header, /dateTime="2026-10-14T18:45:00.000Z"/i);
    assert.doesNotMatch(header, /08:00|03:00/);
  }
});

test("ordinary finalized daily mastheads have no extra edition label", async () => {
  delete report.edition;
  const response = await fetch(`${web.origin}/daily/${key}`);
  assert.equal(response.status, 200, web.logs());
  assert.doesNotMatch(await response.text(), /提前版/);
});
