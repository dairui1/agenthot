import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import type { SiteItemDetail } from "@aihot/contracts/site";
import { startWebServer, type WebServer } from "./web-server.ts";

const at = "2026-10-07T06:40:24.000Z";
const detail: SiteItemDetail = {
  id: "agentlab-fixture", title: "Exo 0.1.0-dev.20261007064024.c7d42944: Sandbox 服务预览",
  summary: "AgentLab 的版本分析摘要。", originalTitle: null, reason: null, source: { name: "AgentLab" },
  publishedAt: at, timelineAt: at, discoveredAt: at, category: "ai-products", tags: [], score: null,
  selected: false, channel: "news", x: null, links: { original: "https://agentlab.dairui1.com/" },
  story: null, readingMode: "full", author: "AgentLab", body: null, outline: [], relatedStories: [],
  topics: [], indexable: false, markdownAvailable: true, group: null, hasTranslation: false, bodyLanguage: "original",
  provenance: {
    name: "AgentLab", url: "https://agentlab.dairui1.com/", analysisStatus: "complete", agentId: "exo",
    version: "0.1.0-dev.20261007064024.c7d42944", dateKind: "published", revision: "a".repeat(64), sourceFreshness: "fresh",
    sources: [{ label: "官方版本记录", url: "https://github.com/example/exo/releases/tag/v1" }],
  },
  reading: {
    version: 1, generatedAt: "2026-10-17T03:00:00.000Z",
    sections: [
      { key: "changes", items: [{ text: "新增按 Session 配置请求体大小的参数，旧的默认限制不再适用于所有会话。", sourceUrl: "https://example.com/release" }] },
      { key: "value", items: [{ text: "对需要上传大文件的工作流，可以将配置限定在对应会话，而不是统一放宽所有会话。", sourceUrl: "https://example.com/release" }] },
      { key: "limitations", items: [{ text: "来源仅提供配置接口说明，没有提供大文件传输的独立性能测试。", sourceUrl: "https://example.com/release" }] },
    ],
    links: [{ label: "官方配置文档", url: "https://example.com/docs/session-request-limits" }],
  },
};
let browser: Browser;
let web: WebServer;
const api = createServer((req, res) => {
  const path = new URL(req.url!, "http://fixture").pathname;
  res.setHeader("Content-Type", "application/json");
  if (path === "/api/health" || path === "/api/site/meta") return res.end("{}");
  if (path === "/api/site/items/agentlab-fixture") return res.end(JSON.stringify(detail));
  if (path === "/api/site/items/restricted-fixture") return res.end(JSON.stringify({ ...detail, id: "restricted-fixture", readingMode: "summary-only" }));
  if (path === "/api/site/items/sparse-fixture") return res.end(JSON.stringify({ ...detail, id: "sparse-fixture", reading: { ...detail.reading, sections: [detail.reading!.sections[0]], links: [] } }));
  if (path === "/api/site/items/legacy-fixture") return res.end(JSON.stringify({ ...detail, id: "legacy-fixture", reading: undefined }));
  res.statusCode = 404;
  res.end('{"code":"not_found"}');
});
before(async () => {
  web = await startWebServer(api);
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await web?.stop(); });

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
  test(`source analysis and evidence remain readable at ${viewport.width}px, including long version identifiers`, async () => {
    const page = await browser.newPage({ viewport });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${web.origin}/items/agentlab-fixture`);
      await expect(page.getByRole("heading", { name: detail.title, exact: true })).toBeVisible();
      const evidence = page.getByRole("region", { name: "分析与证据" });
      await expect(evidence).toBeVisible();
      await expect(evidence.getByRole("link", { name: "官方版本记录" })).toHaveAttribute("href", detail.provenance!.sources[0]!.url);
      await expect(page.getByText("AgentLab 分析摘要", { exact: true })).toBeVisible();
      const reading = page.getByRole("region", { name: "内容解读" });
      for (const heading of ["具体变化", "实际价值", "限制与证据", "使用入口"]) {
        await expect(reading.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      }
      await expect(reading.getByRole("link", { name: "官方配置文档" })).toHaveAttribute("href", detail.reading!.links[0]!.url);
      await expect(reading.getByRole("link", { name: "核对第 1 条具体变化的来源依据" })).toHaveAttribute("rel", "noopener noreferrer");
      await expect(reading.getByText("编辑解读", { exact: true })).toBeVisible();
      await expect(reading.locator("time")).toHaveAttribute("datetime", detail.reading!.generatedAt);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

test("a restricted summary does not render the source evidence section", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}/items/restricted-fixture`);
    await expect(page.getByRole("heading", { name: detail.title, exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "分析与证据" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "内容解读" })).toHaveCount(0);
  } finally { await page.close(); }
});

test("a sparse reading has no invented empty sections and a legacy article keeps its summary", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${web.origin}/items/sparse-fixture`);
    const reading = page.getByRole("region", { name: "内容解读" });
    await expect(reading.getByRole("heading", { name: "具体变化" })).toBeVisible();
    for (const heading of ["实际价值", "限制与证据", "使用入口"]) {
      await expect(reading.getByRole("heading", { name: heading })).toHaveCount(0);
    }
    await page.goto(`${web.origin}/items/legacy-fixture`);
    await expect(page.getByText(detail.summary!, { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "内容解读" })).toHaveCount(0);
  } finally { await page.close(); }
});
