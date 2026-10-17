import { pathToFileURL } from "node:url";
import { remoteEnvironment } from "@aihot/site/modules/operator-remote";

export function readingEnvironment(input: unknown, mode: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (mode !== "--check" && mode !== "--run") throw new Error("Expected an explicit reading mode");
  const configured = remoteEnvironment(input, "--check", env);
  configured.COLLECT_ENABLED = "false";
  configured.AGENTLAB_SYNC_ENABLED = "false";
  configured.MODEL_CALLS_ENABLED = mode === "--run" ? "true" : "false";
  if (mode === "--run") {
    const config = input as Record<string, unknown>;
    if (typeof config.token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(config.token)
      || config.baseUrl !== "http://127.0.0.1:14312/v1") throw new Error("Invalid loopback adapter configuration");
    configured.CODEX_CLI_TOKEN = config.token;
    configured.CODEX_CLI_BASE_URL = config.baseUrl;
  }
  return configured;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (input.length > 32768) throw new Error("Reading configuration exceeds its size limit");
    }
    const config = JSON.parse(input);
    const mode = process.argv[2];
    const configured = readingEnvironment(config, mode, process.env);
    delete process.env.CODEX_CLI_TOKEN;
    delete process.env.CODEX_CLI_BASE_URL;
    Object.assign(process.env, configured);
    const { readingCli } = await import("./cli.ts");
    await readingCli(config.manifest, mode as "--check" | "--run");
  } catch {
    console.error(JSON.stringify({ ok: false, stage: "reading", error: "Reading remote configuration refused" }));
    process.exitCode = 1;
  }
}
