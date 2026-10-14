import { recordRun } from "@aihot/backend/jobs/queue";
import { runDaily, type Dependencies, type RunResult } from "./workflow.ts";

export function runRecorded(deps: Dependencies, report: (result: RunResult) => void): Promise<RunResult> {
  return recordRun("agenthot.daily-publish", async () => {
    const result = await runDaily(deps);
    report(result);
    if (result.status !== "complete") throw new Error(`Daily publish ${result.status}: ${result.problems.join("; ")}`);
    return result;
  });
}
