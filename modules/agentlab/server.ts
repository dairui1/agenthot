import { defineServerModule } from "@aihot/backend/modules";
import { SOURCE_ID } from "./contract.ts";
import { itemProvenance, publicationRestriction, syncAgentLab } from "./sync.ts";
import { dailyReportCandidates, publicationProjected } from "./daily.ts";

export const agentlab = defineServerModule({
  name: "agentlab",
  itemProvenance,
  publicationRestriction,
  publicationProjected,
  dailyReportCandidates,
  sourceKinds: { external: { matches: (id) => id === SOURCE_ID, fetchNow: () => syncAgentLab() } },
});
