import { isIP } from "node:net";

const MODEL_ENVS = [
  "PREFILTER_MODEL", "SCORE_MODEL", "UNDERSTAND_MODEL", "SUMMARIZE_MODEL",
  "STRUCTURE_MODEL", "GROUP_MODEL", "GROUP_REVIEW_MODEL", "DIGEST_MODEL",
  "REPORT_MODEL", "TRANSLATE_MODEL",
];

/** The token travels over SSH stdin, never in a command line or a server-side file. */
export function remoteEnvironment(input: unknown, mode: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!["--collect", "--publish", "--check"].includes(mode)) throw new Error("Expected --collect, --publish or --check");
  if (!input || typeof input !== "object") throw new Error("Invalid remote configuration");
  const config = input as Record<string, unknown>;
  if (typeof config.expectedRelease !== "string" || !/^[a-f0-9]{40}$/.test(config.expectedRelease)
    || env.AIHOT_RELEASE !== config.expectedRelease) throw new Error("Production release differs from the local checkout");
  const host = env.AGENTHOT_DATABASE_HOST;
  if (!host || isIP(host) !== 4 || !env.POSTGRES_PASSWORD) throw new Error("Missing production database configuration");
  if (env.SITE_URL !== "https://agenthot.dairui1.com") throw new Error("Unexpected production site");
  const result: NodeJS.ProcessEnv = {
    ...env,
    DATABASE_URL: `postgres://aihot:${encodeURIComponent(env.POSTGRES_PASSWORD)}@${host}:5432/aihot`,
    AIHOT_DATA_DIR: "/data",
    NODE_ENV: "production",
    AIHOT_ENVIRONMENT: "production",
    COLLECT_ENABLED: mode === "--collect" ? "true" : "false",
    MODEL_CALLS_ENABLED: mode === "--collect" ? "true" : "false",
    FEISHU_CONTENT_PUSH_ENABLED: "false",
    FEISHU_INTERNAL_ENABLED: "false",
    INDEXNOW_SUBMIT_ENABLED: "false",
  };
  for (const key of MODEL_ENVS) result[key] = "gpt-6.1-sol";
  if (mode === "--collect") {
    if (typeof config.token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(config.token)
      || config.baseUrl !== "http://127.0.0.1:14312/v1") throw new Error("Invalid loopback adapter configuration");
    result.CODEX_CLI_TOKEN = config.token;
    result.CODEX_CLI_BASE_URL = config.baseUrl;
  } else {
    delete result.CODEX_CLI_TOKEN;
    delete result.CODEX_CLI_BASE_URL;
  }
  return result;
}
