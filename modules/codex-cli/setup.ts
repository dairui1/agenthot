import { closeDb, sql } from "@aihot/backend/db";
import { updateBudget } from "@aihot/backend/admin/settings";

try {
  const [budget] = await sql`SELECT service FROM budgets WHERE service=${"codex-cli"}`;
  if (!budget) {
    await updateBudget("codex-cli", { perMinute: 12, perHour: 60, perDay: 120,
      reason: "Initial bounded Codex CLI sample budget; counts requests, not remaining account quota" }, "agenthot-codex-setup");
    console.log("Codex request budget initialized: 12/minute, 60/hour, 120/day");
  } else console.log("Existing Codex request budget preserved");
} finally { await closeDb(); }
