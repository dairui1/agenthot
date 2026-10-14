import { remoteEnvironment } from "./remote-config.ts";

let input = "";
for await (const chunk of process.stdin) {
  input += chunk.toString();
  if (input.length > 4096) throw new Error("Remote configuration exceeds its size limit");
}
const configured = remoteEnvironment(JSON.parse(input), process.argv[2], process.env);
delete process.env.CODEX_CLI_TOKEN;
delete process.env.CODEX_CLI_BASE_URL;
Object.assign(process.env, configured);
await import("./cli.ts");
