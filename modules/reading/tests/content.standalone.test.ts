import assert from "node:assert/strict";
import { test } from "node:test";
import { materialHash, materialOf, publicReading, safeUrl, userMaterial, validateReading, VERSION } from "../content.ts";

const URL = "https://example.com/release";
const DOCS = "https://example.com/docs";
const QUOTE = "The release adds a local approval gate before a tool can modify files.";
const BODY = `${QUOTE}\nThe gate is disabled by default and requires an explicit policy.\nDocumentation: ${DOCS}`;
const TEXT = "工具修改文件前新增本地审批环节，只有明确配置策略后才会启用。";
const DATE = new Date("2026-10-17T08:00:00.000Z");
const material = () => materialOf("Approval gates", URL, BODY);
const point = (text = TEXT, quote = QUOTE, sourceUrl = URL) => ({ text, quote, sourceUrl });
const draft = (changes = [point()]) => ({ changes, value: [], limitations: [], links: [] });

test("grounded original commentary retains private evidence but projects only public fields", () => {
  const source = material();
  const stored = validateReading(draft(), source, userMaterial(source));
  assert.ok(stored);
  assert.equal(stored.draft.changes[0].quote, QUOTE);
  assert.equal(stored.materialHash, materialHash(source));
  const result = publicReading({ ...stored, receiptId: 123, rawResponse: "private-response" }, source, DATE);
  assert.deepEqual(result, {
    version: 1, generatedAt: DATE.toISOString(),
    sections: [{ key: "changes", items: [{ text: TEXT, sourceUrl: URL }] }],
    links: [{ label: "原文", url: URL }],
  });
  for (const privateValue of [QUOTE, "quote", "materialHash", "receiptId", "rawResponse", "private-response"])
    assert.equal(JSON.stringify(result).includes(privateValue), false, privateValue);
});

test("quote whitespace can normalize but separate source spans cannot become one quote", () => {
  const source = materialOf("Gates", URL, "The release adds a local\n  approval gate before a tool can modify files.");
  assert.ok(validateReading(draft(), source, userMaterial(source)));
  const stitched = "The release adds a local a tool can modify files.";
  assert.equal(validateReading(draft([point(TEXT, stitched)]), source, userMaterial(source)), null);
});

test("source evidence must occur in the actual model-visible input, not just the stored body", () => {
  const source = material();
  assert.equal(validateReading(draft(), source, "Only a headline was sent to the model."), null);
  assert.equal(validateReading(draft([point(TEXT, "A claim that is not present in the captured source.")]), source, userMaterial(source)), null);
});

test("quotes beyond the model's body truncation cannot support a public point", () => {
  const source = materialOf("Gates", URL, `${"x".repeat(60000)}\n${QUOTE}`);
  const input = userMaterial(source);
  assert.equal(input.includes(QUOTE), false);
  assert.equal(validateReading(draft(), source, input), null);
});

test("a saved usage link is not evidence for an unread page", () => {
  const source = material();
  assert.ok(source.links.includes(DOCS));
  assert.equal(validateReading(draft([point(TEXT, QUOTE, DOCS)]), source, userMaterial(source)), null);
});

test("only actual allowlisted URLs become usage links, with no inferred project addresses", () => {
  const source = material();
  const input = { ...draft(), links: [
    { label: "文档", url: DOCS },
    { label: "重复文档", url: DOCS },
    { label: "猜测仓库", url: "https://github.com/example/approval-gates" },
    { label: "[注入标题]", url: URL },
  ] };
  assert.deepEqual(validateReading(input, source, userMaterial(source))?.draft.links, [{ label: "文档", url: DOCS }]);
});

test("a real 54-character source title fits a usage label without truncation", () => {
  const source = material();
  const label = "更新原文：Cloud Agent Canvases and Environment Improvements";
  assert.equal(label.length, 54);
  const stored = validateReading({ ...draft(), links: [{ label, url: URL }] }, source, userMaterial(source));
  assert.deepEqual(stored?.draft.links, [{ label, url: URL }]);
  assert.deepEqual(publicReading(stored, source, DATE)?.links, [{ label, url: URL }]);
});

test("usage labels retain a bounded maximum of 120 characters", () => {
  const source = material();
  const input = { ...draft(), links: [{ label: "L".repeat(120), url: URL }] };
  assert.ok(validateReading(input, source, userMaterial(source)));
  assert.equal(validateReading({ ...input, links: [{ label: "L".repeat(121), url: URL }] }, source, userMaterial(source)), null);
});

test("URL extraction is confined to literal safe addresses in stored source material", () => {
  const source = materialOf("Do not infer https://title.example/docs", URL,
    `Use ${DOCS} or ${DOCS}. A project named other/project is mentioned. Private: http://service.internal/path`);
  assert.ok(source.links.includes(URL));
  assert.ok(source.links.includes(DOCS));
  assert.equal(source.links.some(link => link.includes("title.example") || link.includes("service.internal") || link.includes("github.com")), false);
  assert.equal(new Set(source.links).size, source.links.length);
});

test("saved HTML supplies real relative links without trusting base tags or loading resources", () => {
  const source = materialOf("Gates", URL, BODY, `<base href="https://invented.example/">
    <a href="/guide?mode=approval&amp;version=1">Guide</a><a href="./install">Install</a>
    <img src="https://images.example/never-load.png"><script src="https://scripts.example/never-load.js"></script>`);
  assert.ok(source.links.includes("https://example.com/guide?mode=approval&version=1"));
  assert.ok(source.links.includes("https://example.com/install"));
  assert.equal(source.links.some(link => /invented|images|scripts/.test(link)), false);
  const stored = validateReading({ ...draft(), links: [{ label: "安装", url: "https://example.com/install" }] }, source, userMaterial(source));
  assert.deepEqual(stored?.draft.links, [{ label: "安装", url: "https://example.com/install" }]);
  assert.notEqual(materialHash(source), materialHash(material()));
});

test("malicious or private saved HTML hrefs do not become usage links", () => {
  const source = materialOf("Gates", URL, BODY, `<a href="javascript:alert(1)">Run</a>
    <a href="data:text/html,private">Data</a><a href="file:///etc/passwd">File</a>
    <a href="//127.0.0.1/private">Private</a><a href="http://metadata.google.internal/token">Internal</a>
    <a href="https://user:secret@example.com/">Credentials</a><a href="https://example.com/&#10;secret">Control</a>`);
  assert.deepEqual(source.links, [URL, DOCS]);
});

test("plain stored material still contributes literal URLs and HTML allowlists are bounded", () => {
  assert.deepEqual(materialOf("External analysis", URL, `Code: [repository](${DOCS})`).links, [URL, DOCS]);
  const source = materialOf("Gates", URL, BODY,
    Array.from({ length: 100 }, (_, i) => `<a href="/docs/${i}">Entry ${i}</a>`).join(""));
  assert.equal(source.links.length, 64);
  assert.equal(source.links[0], URL);
});

test("safe URLs reject private, ambiguous, credential-bearing and executable addresses", () => {
  for (const url of [
    "javascript:alert(1)", "data:text/html,hello", "file:///etc/passwd", "ftp://example.com/file",
    "https://user:secret@example.com/", "https://user@example.com/", "https://example.com/\nsecret",
    " https://example.com/", "https://example.com/a b", "https://localhost/", "https://localhost./",
    "http://server/", "http://127.0.0.1/", "http://10.0.0.1/", "http://169.254.169.254/",
    "http://2130706433/", "http://0x7f000001/", "http://[::1]/", "https://x.local/",
    "https://x.local./", "https://x.localhost./", "https://metadata.google.internal/",
    "https://service.internal./", "https://service.lan/", "https://service.home/",
  ]) assert.equal(safeUrl(url), null, url);
  assert.equal(safeUrl("HTTPS://Example.COM:443/docs?q=1#start"), "https://example.com/docs?q=1#start");
});

test("an unsafe original address cannot gain a reading via a safe quoted source", () => {
  const source = materialOf("Gates", "http://service.internal/release", BODY);
  assert.equal(validateReading(draft(), source, userMaterial(source)), null);
});

test("empty or unsupported sections stay empty rather than padding a reading", () => {
  const source = material();
  assert.equal(validateReading({ ...draft([]), links: [{ label: "文档", url: DOCS }] }, source, userMaterial(source)), null);
  const input = { ...draft(), value: [point("这一条没有材料支持应当剔除。", "This evidence does not occur in the source.")] };
  const stored = validateReading(input, source, userMaterial(source));
  assert.ok(stored);
  assert.deepEqual(stored.draft.value, []);
  assert.deepEqual(stored.draft.limitations, []);
  assert.deepEqual(publicReading(stored, source, DATE)?.sections.map(section => section.key), ["changes"]);
});

test("duplicate commentary cannot fill several sections", () => {
  const source = material();
  const stored = validateReading({ ...draft(), value: [point()], limitations: [point()] }, source, userMaterial(source));
  assert.ok(stored);
  assert.equal(stored.draft.changes.length, 1);
  assert.equal(stored.draft.value.length, 0);
  assert.equal(stored.draft.limitations.length, 0);
});

test("long verbatim text and a copied fragment with original padding are both rejected", () => {
  const source = material();
  for (const text of [QUOTE, `材料称：${QUOTE.slice(0, 40)}，这是本次变化。`])
    assert.equal(validateReading(draft([point(text)]), source, userMaterial(source)), null, text);
});

test("short complete source sentences cannot be redistributed as original points", () => {
  const copied = "新版本增加本地审批，默认关闭。";
  const source = materialOf("Gates", URL, `${QUOTE}\n${copied}`);
  assert.ok(copied.length < 36);
  assert.equal(validateReading(draft([point(copied)]), source, userMaterial(source)), null);
});

test("public point text does not embed links, HTML or markdown markup", () => {
  const source = material();
  for (const text of ["参考 https://example.com/docs 了解使用方法。", "<strong>本地审批可以限制文件修改。</strong>",
    "[文档](https://example.com/docs) 说明了新审批功能。", "使用 `approval` 配置来开启审批功能。"])
    assert.equal(validateReading(draft([point(text)]), source, userMaterial(source)), null, text);
});

test("invalid schemas and unrequested model fields are rejected rather than published", () => {
  const source = material();
  for (const input of [null, {}, { ...draft(), verified: true }, { ...draft(), changes: [{ ...point(), secret: "private" }] },
    { ...draft(), changes: Array.from({ length: 5 }, () => point()) }, { ...draft(), changes: [point("短文本")] }])
    assert.equal(validateReading(input, source, userMaterial(source)), null);
});

test("saved reading is hidden when version, current material or generation time does not match", () => {
  const source = material();
  const stored = validateReading(draft(), source, userMaterial(source));
  assert.ok(stored);
  assert.equal(publicReading({ ...stored, version: `${VERSION}-future` }, source, DATE), null);
  assert.equal(publicReading({ ...stored, materialHash: "0".repeat(64) }, source, DATE), null);
  assert.equal(publicReading(stored, materialOf(source.title, source.url, `${source.body}\nNew revision.`), DATE), null);
  assert.equal(publicReading(stored, source, new Date("invalid")), null);
  assert.equal(publicReading(null, source, DATE), null);
});
