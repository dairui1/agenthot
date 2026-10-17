import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { loadItemDetail, exportMarkdown } from "@aihot/backend/publication/detail";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import type { ItemReading } from "@aihot/contracts/reading";

const key = `reading-exit-${tag()}`;
const generatedAt = "2026-10-17T04:00:00.000Z";
let reads = 0;
const reading = {
  version: 1,
  generatedAt,
  raw: "PRIVATE MODEL RESPONSE",
  receipt: 999,
  sections: [{ key: "changes", items: [{ text: "批次 < 10 时使用新路径。[恶意](javascript:alert(1))", sourceUrl: "https://example.org/release", quote: "PRIVATE SOURCE QUOTE" }] },
    { key: "value", items: [{ text: "可减少小批次等待，实际收益仍取决于任务。", sourceUrl: "https://example.org/release" }] },
    { key: "limitations", items: [{ text: "来源只提供作者测试，没有独立复现。", sourceUrl: "https://example.org/release" }] }],
  links: [{ label: "官方仓库", url: "https://example.org/project", private: "PRIVATE LINK EVIDENCE" }],
} as unknown as ItemReading;

before(async () => {
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,site_fulltext,syndicate_fulltext)
    VALUES (${key},'Release source','rss','T1','editorial',false,false)`;
  installModules([{ name: "reading-exit-test", itemReading: async () => { reads++; return reading; } }]);
});
after(async () => { installModules([]); await closeDb(); });

async function fixture(visibility = "public") {
  const id = `${key}-${tag()}`;
  await sql`INSERT INTO articles (id,source_id,identity_key,url,title,body_html,body_text,body_status,published_at,discovered_at,timeline_at)
    VALUES (${id},${key},${id},'https://example.org/release','保留标题','<p>LICENSED ORIGINAL BODY</p>','LICENSED ORIGINAL BODY','ok',now()-interval '1 day',now()-interval '1 day',now()-interval '1 day')`;
  const [analysis] = await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,title_zh,summary_zh,selected)
    VALUES (${id},1,'rule','pass','保留标题','列表仍是原来的短摘要。',true) RETURNING id`;
  await sql`INSERT INTO publications (article_id,analysis_id,source_id,title,summary,url,channel,timeline_at,discovered_at,published_at,sort_at,
      selected,eligible,visible_after,tags,body_mode,visibility)
    VALUES (${id},${analysis!.id},${key},'保留标题','列表仍是原来的短摘要。','https://example.org/release','news',now()-interval '1 day',now()-interval '1 day',now()-interval '1 day',now()-interval '1 day',
      true,true,now()-interval '1 day',${[key]},'summary',${visibility})`;
  return id;
}

test("detail and Markdown expose original interpretation but never private evidence or unlicensed source body", async () => {
  const id = await fixture();
  const receipts = await sql`SELECT id,status,attempts FROM receipts ORDER BY id`;
  const detail = await loadItemDetail(id);
  assert.equal(detail.kind, "found");
  if (detail.kind !== "found") return;
  assert.equal(detail.item.body, null);
  assert.equal(detail.item.reading?.generatedAt, generatedAt);
  assert.deepEqual(detail.item.outline.map(item => item.id), ["reading-changes", "reading-value", "reading-limitations", "reading-links"]);
  const json = JSON.stringify(detail.item);
  assert.ok(!/PRIVATE|LICENSED ORIGINAL BODY|receipt|quote/.test(json));
  assert.equal(detail.item.summary, "列表仍是原来的短摘要。");
  const markdown = (await exportMarkdown(id))!.body;
  assert.ok(markdown.includes("批次 &lt; 10"));
  assert.ok(markdown.includes("\\[恶意\\]\\(javascript:alert\\(1\\)\\)"));
  assert.ok(markdown.includes("## 实际价值 · 编辑解读"));
  assert.ok(markdown.includes(`解读更新：${generatedAt}`));
  assert.ok(markdown.includes("非本站独立复现"));
  assert.ok(markdown.includes("[官方仓库](<https://example.org/project>)"));
  assert.ok(!/PRIVATE|LICENSED ORIGINAL BODY/.test(markdown));
  const timeline = await loadTimeline({ channel: "all", category: null, tag: key, now: new Date() });
  assert.equal(timeline.cards.find(card => card.item.id === id)?.item.summary, "列表仍是原来的短摘要。");
  assert.ok(!JSON.stringify(timeline).includes("generatedAt"));
  assert.deepEqual(await sql`SELECT id,status,attempts FROM receipts ORDER BY id`, receipts, "public reads never request a model");
});

test("summary-only and withdrawn content cannot expose interpretation or call the module reader", async () => {
  for (const visibility of ["summary-only", "withdrawn"]) {
    const id = await fixture(visibility);
    const before = reads;
    const detail = await loadItemDetail(id);
    if (visibility === "withdrawn") assert.equal(detail.kind, "not_found");
    else {
      assert.equal(detail.kind, "found");
      if (detail.kind === "found") {
        assert.equal(detail.item.reading, undefined);
        assert.deepEqual(detail.item.outline, []);
      }
    }
    assert.equal(await exportMarkdown(id), null);
    assert.equal(reads, before);
  }
});
