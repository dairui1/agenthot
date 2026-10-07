# AgentHot

AgentHot is an independent fork of [AIHOT](https://github.com/KKKKhazix/AIHOT), not a rewrite and not part of the AgentLab deployment.

## Fork Boundary

- Baseline: `8e34e05feb161cb5838e592ee22715f791c7f814`.
- Keep collection, editorial scoring, grouping, publication, reports, admin and reader pages upstream-owned.
- Customize `site/` and `industry/`; AgentLab integration lives in `modules/agentlab/`.
- Preserve the upstream license and notices. Do not use AIHOT's name or logo as this site's brand.
- Keep upstream package names and environment variable names to reduce merge conflicts.

## Editorial Draft

The initial scope is Coding Agents, Agent Harnesses, browser/desktop agents (CUA), Agentic RL, context, tools, collaboration and security. General model/business news needs concrete Agent relevance. This is a reviewable starting configuration, not a user-calibrated editorial policy.

The initial source list uses eight upstream public RSS examples. On 2026-10-07 all eight returned HTTP 200 with RSS/Atom root elements; this verifies reachability, not editorial quality or complete ingestion. Anthropic and smaller Agent projects are not comprehensively covered; paid X/WeChat collectors are not enabled.

## AgentLab source

The dedicated `agentlab-sync` process pulls AgentLab's published
`/data/syndication.json` every 30 minutes. It imports all qualifying version
analyses through the upstream material and publication functions, not through a
second feed UI. Both repositories remain independent. See
[`modules/agentlab/README.md`](modules/agentlab/README.md) for the contract,
operating commands and failure behavior.

AgentLab's title, summary and source links are reused with explicit attribution.
These items enter the public pool only with complete/reviewed analysis, fresh
evidence and a reliable publication date. Imported importance does not become an
AgentHot score or automatic selection. This import calls no model, preserves
stable identities across corrections and intentional reverts, and propagates
explicit suppression/withdrawal without overwriting administrator decisions.
Omission alone never removes an article. Research articles are not imported until
they have a reliable first-publication date.

The general worker, RSS collectors, model calls and notification valves remain
off in production; only this bounded AgentLab synchronization runs. The separate
Compose service has no public port and carries no Codex/ChatGPT credentials.

Scoring types, five-axis weights and thresholds remain upstream defaults. Run SelectBench with 100-200 user-labelled samples before claiming selection quality. Source code, project-reported results and independent reproduction must not be conflated.

## Safe Local Preview

Use Node 24.11+ and PostgreSQL 17. Copy `.env.example` to a local, ignored `.env` and generate authentication secrets. Keep `COLLECT_ENABLED=false`, `MODEL_CALLS_ENABLED=false`, notification and IndexNow flags false until explicitly enabling those services. The upstream `init-env.ts` enables collection/model calls, so it is not the safe preview route.

```sh
npm ci
npm run typecheck
DATABASE_URL=postgres://.../agenthot_test npm test
npm run build -w @aihot/web
node --test apps/web/tests/*.test.ts
node scripts/smoke.ts --base http://localhost:3000
```

Production domain, model credentials/budgets, sources, editorial categories and `site/pages/terms.md` / `privacy.md` require owner confirmation before launch. No production deployment is implied by this bootstrap.

## Public Reader Deployment

On 2026-10-07 the owner requested `https://agenthot.dairui1.com` and confirmed a
public reader release: existing summaries and source links, no reader accounts or
advertising tracking, operational logs, and feedback received by the owner. The
deployment overlay and runbook are in `deploy/agenthot.compose.yml` and
`deploy/agenthot.md`. Automatic collection, model calls, notifications and the
worker remain disabled. Codex login credentials stay on the operator Mac.

The first content transfer excludes the local task queue, administrator accounts
and sessions, and feedback records. Production uses fresh independent secrets.
Public deployment acceptance must verify the actual domain and release rather
than relying on a successful image build.

### First Release Acceptance (2026-10-07)

- Runtime release: `b23f4791c2f1216d04caf9997c2dfa39d71ffd25` on the independent
  `agenthot` Docker project. DB, API and web are healthy; no worker is running.
- DNS resolves the requested hostname to the deployment. Let's Encrypt HTTPS
  and HTTP-to-HTTPS `308` were verified without bypassing certificate checks.
- The original 30-route smoke check passed against the real HTTPS domain.
  Production admin sign-in, secure cookie attributes, anonymous `401` responses
  and session revocation after logout passed.
- The reader pool contains four articles, three selected. Imported selected
  sync payloads initially retained localhost links; the upstream `publishArticle`
  function refreshed them without model calls or scoring/content changes.
- Desktop 1440x1000 and mobile 390x844 list/detail checks passed with no horizontal
  overflow or page errors. Full-text-disabled items expose no body in public
  projections. A relevance-blocked item remains accessible as unlisted metadata
  by exact ID, following upstream behavior; this is not a private-content gate.
- This release passed typecheck, 167 standalone tests, 42 web tests and a
  production Docker build. The previous 659 non-backup integration result is
  historical; that full suite was not rerun for this deployment-only change.
- No recurring backup job is enabled. The first content-transfer dump is retained
  in private operator storage; use the runbook for subsequent matched DB/files
  backups before updating. Production credentials are ignored, mode `0600` files.

## Upstream Maintenance

`origin` is `dairui1/agenthot`; `upstream` is `KKKKhazix/AIHOT`. Fetch and review upstream changes, merge in a branch, then rerun typecheck, database tests, web tests and smoke checks. Do not mass-rename `@aihot/*` or modify historic migrations for branding.

## Bootstrap Verification (2026-10-07)

- Typecheck and production web build passed on Node 24.14.0.
- 649 non-backup tests passed against an isolated PostgreSQL 17 database. The full suite is not certified: eight backup tests could not run successfully because the host lacks `pg_dump` / `pg_restore`. Do not remove or weaken them.
- 42 web tests passed, including WebKit and Chromium navigation checks. Test fixtures/selectors were adapted to the customized section/category labels; engine code was not changed.
- The official smoke script passed against the local preview.
- Chromium desktop (1440x1000) and mobile (390x844) screenshots showed no horizontal overflow or page errors.
- No real model call, scoring-quality evaluation, content collection or production deployment was performed. The preview contains no news.
- Icons were regenerated from the AgentHot monogram with `node scripts/agenthot-icons.ts`. Report nameplates use the upstream generator and Noto Sans SC, retaining its existing font license.

## Codex Integration Verification (2026-10-07)

The owner selected the existing Codex CLI login and `gpt-6.1-sol`, matching AgentLab's model/runtime choice. The local adapter is isolated under `modules/codex-cli/`; no engine provider or pipeline code was changed. Runtime credentials live only in ignored `.data/codex.env`. Site model declarations are included in the environment-name architecture check.

- Typecheck, web build, 659 non-backup tests and 42 web tests passed. The previous backup dependency gap remains.
- Five real stored articles were processed through the upstream extraction, analysis, publication and grouping functions: four passed relevance and three qualified for selection; an unrelated TTS leaderboard was blocked. This is a smoke sample, not a selection-quality benchmark.
- 21 completed receipts identify `gpt-6.1-sol`, report token usage and record that CLI temperature/output-token parameters are not applied. Reprocessing Holo4 reused its receipts without increasing the call count. A separate minimal connection check was run outside editorial receipts.
- Local fake-CLI tests cover output parsing, process timeout cleanup and rejecting unexpected tool activity. An integration test confirms timeout/disconnect retains an unknown receipt, rather than silently releasing the request for retry.
- The request budget is initialized through the existing audited admin API: 12/minute, 60/hour, 120/day; existing operator settings are preserved. These caps do not measure remaining Codex account quota.
- Model selection uses private local `*_MODEL` overrides; the shipped upstream defaults remain compatible with its API-provider tests. No continuous worker, scheduler, production deployment or paid collector was enabled.
