import { recordRun } from "@aihot/backend/jobs/queue";
import { sql } from "@aihot/backend/db";
import { runDaily, type Dependencies, type Phase, type RunResult } from "./workflow.ts";

export function runRecorded(deps: Dependencies, phase: Phase, report: (result: RunResult) => void): Promise<RunResult> {
  return recordRun(`agenthot.daily-${phase}`, async runId => {
    const result = await runDaily(deps, phase);
    report(result);
    if (result.status !== "complete") {
      // Keep coverage and a real report even when the queue is incomplete; failed is not empty.
      await sql`UPDATE job_runs SET detail = ${sql.json(result as never)} WHERE id = ${runId}`;
      throw new Error(`Daily ${phase} ${result.status}: ${result.problems.join("; ")}`);
    }
    return result;
  });
}
