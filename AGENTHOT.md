# AgentHot

AgentHot is an independent fork of [AIHOT](https://github.com/KKKKhazix/AIHOT), not a rewrite and not part of the AgentLab deployment.

## Fork Boundary

- Baseline: `8e34e05feb161cb5838e592ee22715f791c7f814`.
- Keep collection, editorial scoring, grouping, publication, reports, admin and reader pages upstream-owned.
- Customize `site/` and `industry/`; put future AgentLab integration in `modules/`.
- Preserve the upstream license and notices. Do not use AIHOT's name or logo as this site's brand.
- Keep upstream package names and environment variable names to reduce merge conflicts.

## Editorial Draft

The initial scope is Coding Agents, Agent Harnesses, browser/desktop agents (CUA), Agentic RL, context, tools, collaboration and security. General model/business news needs concrete Agent relevance. This is a reviewable starting configuration, not a user-calibrated editorial policy.

The initial source list uses eight upstream public RSS examples. On 2026-10-07 all eight returned HTTP 200 with RSS/Atom root elements; this verifies reachability, not editorial quality or complete ingestion. Anthropic and smaller Agent projects are not comprehensively covered; paid X/WeChat collectors are not enabled.

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
