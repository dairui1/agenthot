// An explicitly requested early daily covers elapsed time only; the normal scheduled call completes
// it after 08:00 without re-analysis, and preserves the early edition as a revision.
import { editionAt, gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { composeDaily, composeDueReports, composeMonthly, composeWeekly } from "@aihot/backend/reports/compose";

process.env.MODEL_CALLS_ENABLED = "false";
process.env.COLLECT_ENABLED = "false";
const SOURCE = `provisional-${tag()}`;
const DATE = "2024-02-02";
const at = (seconds = 0) => editionAt("daily", DATE, seconds);
const early = () => at(-6 * 3600);

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${SOURCE}, 'Provisional reports', 'rss', 'T1')`;
});
beforeEach(async () => {
  await sql`DELETE FROM reports`;
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
});
after(async () => { await stopBoss(); await closeDb(); });

async function item(time: Date) {
  const id = `provisional-${tag()}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
    VALUES (${id}, ${SOURCE}, ${id}, 'https://example.com/provisional', ${id}, ${time}, ${time})`;
  await sql`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, sort_at, eligible, selected, visible_after, visibility, score)
    VALUES (${id}, ${id}, ${SOURCE}, 'news', 'https://example.com/provisional', ${time}, ${time}, ${time}, true, true, ${time}, 'public', 90)`;
  return id;
}

const report = async (key = DATE) => (await sql`SELECT id, revision, content, window_start, window_end, generated_at FROM reports WHERE kind = 'daily' AND key = ${key}`)[0];
const ids = (row: NonNullable<Awaited<ReturnType<typeof report>>>) => [
  ...row.content.sections.flatMap((s: { items: Array<{ itemId: string }> }) => s.items), ...row.content.flashes,
].map((entry: { itemId: string }) => entry.itemId).sort();
const modelCounts = async () => (await sql`SELECT (SELECT count(*)::int FROM analyses) AS analyses, (SELECT count(*)::int FROM receipts) AS receipts`)[0];

async function waitForBlocked(blocker: number) {
  const deadline = performance.now() + 5_000;
  while (!(await sql`SELECT 1 FROM pg_stat_activity WHERE ${blocker} = ANY(pg_blocking_pids(pid))`)[0]) {
    if (performance.now() > deadline) assert.fail("composition did not reach the held transaction");
    await delay(10);
  }
}

test("an early daily records its actual cutoff and excludes unelapsed time; ordinary calls wait", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: early() });
  const included = await item(at(-7 * 3600));
  await item(early());
  await item(at(-5 * 3600));
  assert.equal((await composeDaily(DATE, undefined, { asOf: new Date() })).entries, 1);
  const saved = (await report())!;
  assert.deepEqual(ids(saved), [included]);
  assert.equal(saved.window_start.toISOString(), at(-24 * 3600).toISOString());
  assert.equal(saved.window_end.toISOString(), early().toISOString());
  assert.equal(saved.content.windowEnd, early().toISOString());
  assert.deepEqual(saved.content.edition, { status: "provisional", scheduledWindowEnd: at().toISOString() });
  assert.equal(saved.content.generator.provisional, undefined, "edition is the only state marker");
  await composeDaily(DATE);
  await composeDaily(DATE, "not permission to include future time");
  assert.deepEqual(await report(), saved);
});

test("early cutoffs must be finite, elapsed, strictly within the currently open daily window", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: early() });
  for (const cutoff of [new Date(NaN), at(-86400), at(-86401), at(), at(1), new Date(early().getTime() + 1)]) {
    await assert.rejects(composeDaily(DATE, undefined, { asOf: cutoff }), /invalid provisional cutoff/);
  }
  await assert.rejects(composeDaily("2024-02-01", undefined, { asOf: at(-30 * 3600) }), /invalid provisional cutoff/);
  assert.equal(await report(), undefined);
});

test("an early cutoff advances with a revision but repeat and backward cutoffs do not rewrite", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: early() });
  await item(at(-7 * 3600));
  await Promise.all([composeDaily(DATE, undefined, { asOf: early() }), composeDaily(DATE, undefined, { asOf: early() })]);
  assert.equal((await report())!.revision, 1, "concurrent first editions do not duplicate revisions");
  await item(at(-5.5 * 3600));
  t.mock.timers.setTime(at(-5 * 3600).getTime());
  assert.equal((await composeDaily(DATE, undefined, { asOf: new Date() })).entries, 2);
  const saved = (await report())!;
  assert.equal(saved.revision, 2);
  await composeDaily(DATE, "same cutoff", { asOf: new Date() });
  await composeDaily(DATE, "older cutoff", { asOf: early() });
  assert.deepEqual(await report(), saved);
});

test("the normal 10:00 run finalizes once, adds later entries and keeps the early revision without model calls", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: early() });
  const first = await item(at(-7 * 3600));
  await composeDaily(DATE, undefined, { asOf: early() });
  const provisional = (await report())!;
  const later = await item(at(-3600));
  await item(at());
  const before = await modelCounts();
  t.mock.timers.setTime(at(2 * 3600).getTime());
  assert.equal((await composeDaily(DATE)).entries, 2);
  const final = (await report())!;
  assert.equal(final.revision, 2);
  assert.equal(final.content.edition, undefined);
  assert.equal(final.window_end.toISOString(), at().toISOString());
  assert.deepEqual(ids(final), [first, later].sort());
  const [revision] = await sql`SELECT content, reason FROM report_revisions WHERE report_id = ${final.id}`;
  assert.deepEqual(revision!.content, provisional.content);
  assert.match(revision!.reason, /finalize provisional/);
  await composeDaily(DATE);
  assert.deepEqual(await report(), final, "a complete daily keeps the original default idempotence");
  t.mock.timers.setTime(early().getTime());
  await composeDaily(DATE, "cannot downgrade final", { asOf: early() });
  assert.deepEqual(await report(), final);
  assert.deepEqual(await modelCounts(), before, "composition only reads existing judgements");
});

test("the due-report catch-up includes an older provisional issue even when a later final exists", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: early() });
  await item(at(-7 * 3600));
  await composeDaily(DATE, undefined, { asOf: early() });
  await item(at(12 * 3600));
  t.mock.timers.setTime(at(26 * 3600).getTime());
  await composeDaily("2024-02-03");
  const later = await report("2024-02-03");
  const result = await composeDueReports(new Date(), 1);
  assert.deepEqual(result.generated, [`daily:${DATE}`]);
  assert.equal((await report())!.revision, 2);
  assert.equal((await report())!.content.edition, undefined);
  assert.deepEqual(await report("2024-02-03"), later);
});

test("nothing judged refuses an early issue and failed finalization preserves the published early issue", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: early() });
  await assert.rejects(composeDaily(DATE, undefined, { asOf: early() }), /nothing judged/);
  assert.equal(await report(), undefined);
  const id = await item(at(-7 * 3600));
  await composeDaily(DATE, undefined, { asOf: early() });
  const saved = await report();
  await sql`DELETE FROM publications WHERE article_id = ${id}`;
  t.mock.timers.setTime(at(2 * 3600).getTime());
  await assert.rejects(composeDaily(DATE), /nothing judged/);
  assert.deepEqual(await report(), saved);
  await assert.rejects(composeWeekly("2024-W05"), /provisional daily is not finalized/);
  await assert.rejects(composeMonthly("2024-02"), /provisional daily is not finalized/);
});

test("a malformed provisional marker is not authority to rewrite a published report", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: early() });
  await item(at(-7 * 3600));
  await composeDaily(DATE, undefined, { asOf: early() });
  await sql`UPDATE reports SET content = jsonb_set(content, '{edition,scheduledWindowEnd}', '"not-a-date"'::jsonb) WHERE kind = 'daily' AND key = ${DATE}`;
  const saved = await report();
  t.mock.timers.setTime(at(2 * 3600).getTime());
  await composeDaily(DATE);
  assert.deepEqual(await report(), saved);
});

test("a full daily racing an earlier first edition wins without being downgraded", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: early() });
  await item(at(-7 * 3600));
  await item(at(-3600));
  const acquired = gate<number>();
  const release = gate();
  const holding = sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('report_candidates'))`;
    acquired.open((await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
    await release.promise;
  });
  const operations: Array<ReturnType<typeof composeDaily>> = [];
  try {
    const blocker = await acquired.promise;
    operations.push(composeDaily(DATE, undefined, { asOf: early() }));
    await waitForBlocked(blocker);
    t.mock.timers.setTime(at(2 * 3600).getTime());
    operations.push(composeDaily(DATE));
    release.open();
    await holding;
    await Promise.all(operations);
    const saved = (await report())!;
    assert.equal(saved.content.edition, undefined);
    assert.equal(saved.content.metrics.totalEvents, 2);
    assert.equal(saved.window_end.toISOString(), at().toISOString());
    assert.ok(saved.revision <= 2);
  } finally {
    release.open();
    await Promise.allSettled([holding, ...operations]);
  }
});

test("an explicit full correction that read no issue cannot overwrite a competing early issue before its cutoff", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: early() });
  await item(at(-7 * 3600));
  await item(at(-3600));
  await sql.unsafe(`CREATE FUNCTION hold_full_daily() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.kind = 'daily' AND NEW.content->'edition' IS NULL THEN
      PERFORM pg_advisory_xact_lock(hashtext('test_full_daily_insert'));
    END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER hold_full_daily BEFORE INSERT ON reports FOR EACH ROW EXECUTE FUNCTION hold_full_daily()`);
  const acquired = gate<number>();
  const release = gate();
  const holding = sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('test_full_daily_insert'))`;
    acquired.open((await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
    await release.promise;
  });
  let full: ReturnType<typeof composeDaily> | undefined;
  try {
    const blocker = await acquired.promise;
    full = composeDaily(DATE, "explicit correction started before any issue existed");
    await waitForBlocked(blocker);
    await composeDaily(DATE, undefined, { asOf: early() });
    const saved = await report();
    release.open();
    await holding;
    assert.equal((await full).entries, 1, "the return value describes the persisted early issue");
    assert.deepEqual(await report(), saved);
  } finally {
    release.open();
    await Promise.allSettled([holding, full]);
    await sql.unsafe("DROP TRIGGER hold_full_daily ON reports; DROP FUNCTION hold_full_daily()");
  }
});
