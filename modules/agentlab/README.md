# AgentLab Source

AgentLab's `/data/syndication.json` is an independently deployed, versioned public contract. This module reuses the engine's material identity/revisions and publication projection; it does not share either site's database, call a model, or enqueue general processing.

- `node --env-file-if-exists=.env modules/agentlab/cli.ts --once` performs one bounded pull.
- `AGENTLAB_SYNC_ENABLED=true node --env-file-if-exists=.env modules/agentlab/cli.ts --watch` polls every 30 minutes.
- `node --env-file-if-exists=.env modules/agentlab/cli.ts --health` checks last success, errors and the 90-minute freshness limit. A source paused in the existing admin is intentionally healthy and is not fetched.

The fixed HTTPS endpoint has a 30-second deadline, no redirects and a 32 MiB response limit. A strict schema and semantic hashes validate the entire snapshot before any content is committed. `exportedAt` must advance for changed snapshots; cached rollback or a conflicting same-time snapshot fails visibly in the existing source health/fetch history and preserves last-good content.

Only complete/reviewed AgentLab analysis with fresh source evidence and a real publication date is publicly admitted. Captured-only timestamps, stale evidence and explicit suppression/withdrawal remain private. Bounded or accidental omission never implies deletion. A later explicit requalification can restore an item, but cannot erase an editor's independent withdrawal or field corrections.

The importer records a deterministic `origin=rule` reuse of AgentLab's external analysis, not a fabricated AgentHot model run. Items enter `/all` with no score and no selected status. AgentLab importance is provenance, not an AgentHot score; no selection threshold is bypassed. Full text and redistribution permissions default off. Evidence links and analysis attribution use the shared publication detail and Markdown exits.

The initial source import is historical backfill. Stable identities are `agentlab:release:<agent>:<version>`, with version-specific query links. Later revisions update the existing article; exact repeats add no material revision or analysis, and preserve a later editor/model decision. General collection, model processing, notifications and worker schedules are not enabled by this module.

The publication-restriction module hook applies source withdrawals during every republication without writing `editorial_overrides`. Module state is migrated before API/service startup. Disabling a source pauses new pulls but retains already published pages, matching the engine's standard source semantics.
