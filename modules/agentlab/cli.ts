import { setTimeout } from "node:timers/promises";
import { closeDb } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { POLL_MS } from "./contract.ts";
import { agentlab } from "./server.ts";
import { syncAgentLab, syncHealth } from "./sync.ts";

const mode = process.argv[2];
if (!["--once", "--watch", "--health"].includes(mode) || process.argv.length !== 3) throw new Error("Usage: node modules/agentlab/cli.ts --once|--watch|--health");
if (mode === "--watch" && process.env.AGENTLAB_SYNC_ENABLED !== "true") throw new Error("AGENTLAB_SYNC_ENABLED must be true for --watch");
installModules([agentlab]);
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stop.abort());
try {
  if (mode === "--health") {
    const health = await syncHealth();
    console.log(JSON.stringify(health));
    if (!health.healthy) process.exitCode = 1;
  } else {
  do {
    try { console.log(JSON.stringify({ at: new Date().toISOString(), ...await syncAgentLab() })); }
    catch (error) {
      console.error(error instanceof Error ? error.message : "AgentLab sync failed");
      if (mode === "--once") { process.exitCode = 1; break; }
    }
    if (mode === "--once" || stop.signal.aborted) break;
    await setTimeout(POLL_MS, undefined, { signal: stop.signal }).catch(() => {});
  } while (!stop.signal.aborted);
  }
} finally { await closeDb(); }
