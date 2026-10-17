// The existing one-shot SSH/container boundary supplies this envelope over stdin.
import { remoteEnvironment } from "./remote-config.ts";

let close: (() => Promise<void>) | undefined;
let stop: (() => Promise<void>) | undefined;
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 65536) throw new Error("Manifest exceeds its size limit");
  }
  const envelope = JSON.parse(input);
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
    || Object.keys(envelope).some(key => !["expectedRelease", "manifest", "approve"].includes(key))) throw new Error("Invalid envelope");
  if (envelope.manifest?.expectedRelease !== envelope.expectedRelease
    || (envelope.approve !== undefined && typeof envelope.approve !== "string")) throw new Error("Mismatched manifest");
  const configured = remoteEnvironment({ expectedRelease: envelope.expectedRelease }, "--publish", process.env);
  delete process.env.CODEX_CLI_TOKEN;
  delete process.env.CODEX_CLI_BASE_URL;
  Object.assign(process.env, configured);
  const { closeDb } = await import("@aihot/backend/db"); close = closeDb;
  const { stopBoss } = await import("@aihot/backend/jobs/queue"); stop = stopBoss;
  const { checkManualLate, publishManualLate } = await import("./manual-late.ts");
  console.log(JSON.stringify(envelope.approve === undefined ? await checkManualLate(envelope.manifest)
    : await publishManualLate(envelope.manifest, envelope.approve)));
} catch {
  console.error(JSON.stringify({ status: "refused", error: "Manual late preconditions failed; no automatic retry or model request was made" }));
  process.exitCode = 1;
} finally { await stop?.(); await close?.(); }
