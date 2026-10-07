import { defineServerModule } from "@aihot/backend/modules";
import { SOURCE_ID } from "./contract.ts";
import { itemProvenance, publicationRestriction, syncAgentLab } from "./sync.ts";

export const agentlab = defineServerModule({
  name: "agentlab",
  itemProvenance,
  publicationRestriction,
  sourceKinds: { external: { matches: (id) => id === SOURCE_ID, fetchNow: () => syncAgentLab() } },
});
