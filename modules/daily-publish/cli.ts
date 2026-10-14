import { closeDb } from "@aihot/backend/db";
import { assertProductionSecrets } from "@aihot/backend/config";
import { installModules } from "@aihot/backend/modules";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { production } from "./production.ts";
import { check } from "./workflow.ts";
import { runRecorded } from "./execute.ts";

const mode = process.argv[2];
if (process.argv.length !== 3 || !["--check", "--run"].includes(mode)) throw new Error("Usage: node modules/daily-publish/cli.ts --check|--run");
installModules(SERVER_MODULES);
try {
  assertProductionSecrets([["auth", "IMG_PROXY_SIGN_SECRET"]]);
  if (mode === "--check") {
    const result = check(await production.snapshot());
    console.log(JSON.stringify(result));
    if (!result.ready) process.exitCode = 1;
  } else await runRecorded(production, result => console.log(JSON.stringify(result)));
} catch {
  // Provider errors can contain request URLs or bodies; detailed state stays in the existing
  // restricted database records, not in scheduler output.
  console.error(JSON.stringify({ status: "failed", error: "Daily publish stopped; inspect private operational records" }));
  process.exitCode = 1;
} finally {
  await stopBoss();
  await closeDb();
}
