# Codex CLI Adapter

AgentHot can use an existing ChatGPT-authenticated Codex CLI as its text model. This adapter exposes the small OpenAI-compatible endpoint the AIHOT engine already calls. It does not change the engine's receipts, budget checks, schemas, scoring or publication logic.

## Configure

```sh
codex login status
openssl rand -hex 32
```

Keep the generated value in an ignored local environment file as `CODEX_CLI_TOKEN`; it authenticates the loopback adapter, not OpenAI. Set `CODEX_CLI_BASE_URL=http://127.0.0.1:4312/v1`, choose `gpt-6.1-sol` for the desired `*_MODEL` steps, then run:

```sh
node --env-file=.data/codex.env modules/codex-cli/server.ts
```

Before any model-calling worker/API starts, run `node --env-file=.data/codex.env modules/codex-cli/setup.ts`. It uses the existing audited admin budget API to initialize 12 requests/minute, 60/hour and 120/day, preserving any existing operator settings. These are request caps, not estimates of account quota. The sample runner refuses a missing budget. No historical migration is modified.

The model-calling API/worker must load the same file and set `MODEL_CALLS_ENABLED=true`. Keep collection and notifications off during bounded sample runs. The CLI uses its existing login; do not copy OAuth credentials into this repository. CLI executable lookup follows AgentLab's desktop-first paths, with an optional `CODEX_BIN` override.

## Limits

- Bound to `127.0.0.1`, requires a 32+ character token, accepts at most four simultaneous requests, 1 MiB input and a 90-second invocation window.
- Model is pinned to `gpt-6.1-sol`; reasoning is low. CLI calls use ephemeral sessions, a fresh temporary directory, read-only sandbox, no approvals, no inherited user configuration/rules, and disabled shell/plugins/browser tools.
- Text-only. Image parts, streaming and tool requests are rejected rather than silently discarded.
- AIHOT's requested `temperature` and `max_tokens` are not implemented by Codex CLI. The response records this under `_codex`; the engine stores the whole response in its receipt. Two scoring invocations remain independent, but their API temperature semantics are not equivalent. Recalibrate selection using actual Codex results.
- Real token usage is returned when the CLI reports it. Monetary cost is not estimated; calls consume the logged-in account's Codex quota, not a configured per-token API balance.
- Timeout/disconnect stops the child process group. An interrupted upstream request retains AIHOT's unknown-outcome receipt behavior; do not automatically re-run it as if nothing happened.
- This is a local CLI integration, not a production/container deployment. Containers need an explicit supported runtime and login arrangement before this adapter can run there.
