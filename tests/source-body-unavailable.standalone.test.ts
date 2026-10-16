// Fixtures mirror observed public response classes, not captured challenge payloads or paid services.
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { after, mock, test } from "node:test";
import { config } from "@aihot/backend/config";
import { extractFromUrl, SourceBodyUnavailableError } from "@aihot/backend/content/extract";

const body = "The article explains the implementation, measurements and limitations of a coding agent release. ".repeat(12);
const article = `<html><head><title>Agent release</title></head><body><article><h1>Agent release</h1><p>${body}</p></article></body></html>`;
let fallbackHits = 0;
const page = http.createServer((req, res) => {
  const path = req.url?.split("?")[0];
  if (path?.startsWith("/jina")) fallbackHits += 1;
  const status = path === "/challenge" || path === "/forbidden" ? 403 : path === "/unauthorized" ? 401 : path === "/unavailable" ? 503 : 200;
  res.writeHead(status, { "content-type": path === "/json" ? "application/json" : "text/html", ...(["/challenge", "/soft-challenge"].includes(path ?? "") ? { "cf-mitigated": "challenge" } : {}) });
  res.end(path === "/empty" ? "<html><body>Empty</body></html>" : path === "/json" ? "{}" : article);
});
await new Promise<void>(resolve => page.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
delete process.env.JINA_API_KEY;
process.env.JINA_BASE_URL = `${base}/jina`;
after(() => { page.close(); });

test("normal public HTML still supplies the complete body without a paid fallback", async () => {
  const result = await extractFromUrl(`${base}/article`, "fixture:article");
  assert.equal(result?.via, "readability");
  assert.ok(result.text.includes(body.trim()));
  assert.equal(fallbackHits, 0);
});

test("a configured alternate fetcher is never used to route around an explicit access challenge or denial", async () => {
  process.env.JINA_API_KEY = "local-fixture-only";
  try {
    for (const [path, reason] of [["/challenge", "access_challenge"], ["/soft-challenge", "access_challenge"], ["/forbidden", "access_denied"], ["/unauthorized", "access_denied"]]) {
      await assert.rejects(extractFromUrl(`${base}${path}?token=not-for-logs`, "fixture:denied"), (error: unknown) => {
        assert.ok(error instanceof SourceBodyUnavailableError);
        assert.equal(error.reason, reason);
        assert.ok(!error.message.includes("not-for-logs"));
        return true;
      });
    }
    assert.equal(fallbackHits, 0);
  } finally { delete process.env.JINA_API_KEY; }
});

test("missing optional Jina credentials do not hide the real public-fetch failure", async () => {
  for (const [path, reason] of [["/unavailable", "http_error"], ["/json", "not_html"], ["/empty", "empty_body"]]) {
    await assert.rejects(extractFromUrl(`${base}${path}`, "fixture:unavailable"), (error: unknown) => {
      assert.ok(error instanceof SourceBodyUnavailableError);
      assert.equal(error.reason, reason);
      assert.ok(!error.message.includes("JINA_API_KEY"));
      return true;
    });
  }
});

test("the SSRF guard remains terminal even when an alternate fetcher is configured", async () => {
  config.allowPrivateNetworkFetch = false;
  process.env.JINA_API_KEY = "local-fixture-only";
  try {
    await assert.rejects(extractFromUrl(`${base}/private?token=not-for-logs`, "fixture:private"), (error: unknown) => {
      assert.ok(error instanceof SourceBodyUnavailableError);
      assert.equal(error.reason, "unsafe_url");
      assert.ok(!error.message.includes("not-for-logs"));
      return true;
    });
    assert.equal(fallbackHits, 0);
  } finally { config.allowPrivateNetworkFetch = true; delete process.env.JINA_API_KEY; }
});

test("a connect-time DNS rebinding refusal cannot be hidden by fetch or sent to an alternate fetcher", async () => {
  let lookups = 0;
  const lookup = mock.method(dns, "lookup", async () => [{ address: ++lookups === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }]);
  syncBuiltinESMExports();
  config.allowPrivateNetworkFetch = false;
  process.env.JINA_API_KEY = "local-fixture-only";
  try {
    await assert.rejects(extractFromUrl("http://rebinding.invalid/article", "fixture:rebinding"), (error: unknown) => {
      assert.ok(error instanceof SourceBodyUnavailableError);
      assert.equal(error.reason, "unsafe_url");
      return true;
    });
    assert.ok(lookups >= 2);
    assert.equal(fallbackHits, 0);
  } finally {
    lookup.mock.restore();
    syncBuiltinESMExports();
    config.allowPrivateNetworkFetch = true;
    delete process.env.JINA_API_KEY;
  }
});
