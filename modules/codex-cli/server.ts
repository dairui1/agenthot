import { createBridge } from "./bridge.ts";

const port = Number(process.env.CODEX_CLI_PORT ?? 4312);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid CODEX_CLI_PORT");
const server = createBridge(process.env.CODEX_CLI_TOKEN ?? "");
server.listen(port, "127.0.0.1", () => console.log(`AgentHot Codex adapter listening on 127.0.0.1:${port}`));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => server.close(() => process.exit(0)));
