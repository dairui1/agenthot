// Bounded use of the upstream processing pipeline, without starting the continuous worker.
import { closeDb, sql } from "@aihot/backend/db";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { processArticle } from "@aihot/backend/jobs/content";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { groupArticle } from "@aihot/backend/events/group";

const ids = process.argv.slice(2);
if (!ids.length || ids.length > 24) throw new Error("Pass 1-24 existing article IDs; this command never collects sources");
try {
  const [budget] = await sql`SELECT service FROM budgets WHERE service=${"codex-cli"}`;
  if (!budget) throw new Error("Run modules/codex-cli/setup.ts first; never call Codex with an unbounded missing budget");
  for (const id of ids) {
    const [a] = await sql<{ title: string; body_status: string }[]>`SELECT title, body_status FROM articles WHERE id=${id}`;
    if (!a) throw new Error(`Unknown article ${id}`);
    if (a.body_status === "pending") {
      const body = await extractArticleBody(id);
      console.log(JSON.stringify({ id, title: a.title, extraction: body }));
    }
    const result = await processArticle(id);
    console.log(JSON.stringify({ id, title: a.title, ...result }));
    if (result.state === "pass") console.log(JSON.stringify({ id, grouping: await groupArticle(id) }));
    if (!["pass", "block", "unknown", "skipped"].includes(result.state)) throw new Error(`Processing incomplete for ${id}: ${result.state}`);
  }
} finally {
  await stopBoss();
  await closeDb();
}
