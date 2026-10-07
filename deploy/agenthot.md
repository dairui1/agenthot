# AgentHot production reader

This deployment serves `https://agenthot.dairui1.com` through the host's existing
Traefik. It layers `deploy/agenthot.compose.yml` over the upstream Compose file;
the collection, publication and authentication engine remains unchanged.

## Scope and prerequisites

- Docker Compose 2.24.4 or newer (`!override` is required), an existing external
  `dokploy-network`, and Traefik entrypoints `web` / `websecure`, certificate
  resolver `letsencrypt`, and middleware `redirect-to-https@file`.
- DNS must resolve the domain to this deployment. Do not start the optional Caddy
  profile on a host where Traefik already owns ports 80 and 443.
- Only `web` joins the shared proxy network. Its sole host binding is
  `127.0.0.1:4310`; PostgreSQL and the API stay on the private Compose network.
- This release is a reader, not an automatic news pipeline. The worker is in the
  opt-in `processing` profile. All backend collection, model and notification
  valves are forced off by the overlay, even if `.env` says otherwise.
- No Codex executable, ChatGPT login, OAuth file or local adapter token is deployed.
  Opening public pages never invokes a model. A supported processing deployment,
  budget setup and explicit review of these valves are separate work.
- The owner must confirm the source policy, usage terms and privacy notice before
  publication. Do not publish the upstream `site/pages/` placeholders.

The project and application image are named `agenthot` and `agenthot-app`.
Upstream database/package identifiers remain `aihot` to avoid unnecessary changes.
The standard Docker volumes are `agenthot_db` and `agenthot_data`; never use
`docker compose down -v` on the deployed project.

## Private configuration

Work from the repository root. Create a private `.env` with mode `0600`, using
`.env.example` as a reference. Generate separate random values for
`POSTGRES_PASSWORD`, `ADMIN_PASSWORD`, `SESSION_SECRET` and
`IMG_PROXY_SIGN_SECRET` (for example, `openssl rand -hex 32` for each).
The administrator password must be at least 12 characters. Do not commit or
print this file, and do not use the upstream `init-env.ts` for this reader setup.

Set `SITE_URL=https://agenthot.dairui1.com`, `TRUST_PROXY=true`, and
`AIHOT_RELEASE` to the deployed Git commit. Leave all external-action valves
false. Remove every `DEV_AUTH_*` variable and `ALLOW_PRIVATE_NETWORK_FETCH`;
production refuses development bypasses. Optional provider keys and Codex login
files are not needed. Set finite image-proxy upstream budgets if the deployment
needs a bandwidth cap.

Application logs use Docker `json-file`, rotating at 10 MiB with at most three
files per container. This is a size cap, not a time-based retention promise.
Traefik, Docker host and any CDN logs have separate policies: inspect their actual
configuration before describing retention in the privacy notice. No recurring
backup job runs while the worker is disabled; backups below are operator-run.

## First start

Use this helper for every command, so the production overlay is never omitted:

```sh
dc() { docker compose --env-file .env -f docker-compose.yml -f deploy/agenthot.compose.yml "$@"; }
dc config --quiet
dc build
dc up -d db
dc run --rm setup
dc up -d api web
dc ps -a
dc logs --tail 100 api web
```

`setup` only applies migrations and source seeds; it does not import the local
preview's articles. If publishing existing reviewed content, restore a verified
database/files pair before starting the API, then run setup against that database.
Never import local `.env`, administrator sessions, or Codex authentication files.
Fresh production authentication secrets invalidate any old sessions, but session
records should still be excluded from an initial preview-to-production transfer.

After importing content from a different `SITE_URL`, refresh the existing
publication projections before public acceptance. The selected sync ledger stores
absolute links; changing the environment alone does not update those saved
payloads. Use the upstream publication function, not new model analysis or direct
edits to historical ledger rows:

```sh
dc run --rm -T --no-deps api node --input-type=module -e '
import { sql, closeDb } from "@aihot/backend/db";
import { publishArticle } from "@aihot/backend/publication/publish";
try {
  const rows = await sql`SELECT article_id FROM publications ORDER BY article_id`;
  for (const { article_id } of rows) await publishArticle(article_id);
} finally {
  await closeDb();
}'
```

Verify `links.aihot` and `attribution.url` in
`/api/v1/selected/snapshot?limit=100`, as well as ordinary page and feed URLs.
The refresh appends corrected sync entries and preserves prior ledger history.
Clients with an earlier cursor receive the correction through changes. Check
that model receipt counts, selection decisions and article dates are unchanged.

Do not enable either `--profile processing` or `--profile https`. Even with the
processing profile selected, this overlay deliberately keeps model and collector
valves closed. Runtime memory limits do not constrain the image build: allow
enough separate headroom for `npm ci` and the production frontend build.

## Acceptance

```sh
node scripts/smoke.ts --base https://agenthot.dairui1.com
curl -fsS https://agenthot.dairui1.com/api/health
curl -i https://agenthot.dairui1.com/api/admin/me
curl -i https://agenthot.dairui1.com/api/auth/check
curl -i https://agenthot.dairui1.com/admin
curl -I http://agenthot.dairui1.com/
```

Require a valid HTTPS certificate, HTTP-to-HTTPS redirect, healthy DB/API/web,
the expected release SHA, anonymous admin API/check responses of `401`, and a
login redirect for `/admin`. Verify real articles in the public list and detail
pages, desktop/mobile rendering, RSS/sitemap/OG absolute URLs, and the absence of
unfilled policy or domain placeholders. After a private admin login, verify
`Secure; HttpOnly; SameSite=Lax` on the session cookie and `no-store` on admin
responses. Do not expose the password in command arguments or shared logs.

Traefik and any CDN must honor the application's `Cache-Control`: do not cache
admin/auth endpoints, extend public response lifetimes, or serve expired content
offline. MCP must remain unbuffered and uncached. A public reading check must not
increase editorial model receipts.

An excluded relevance result is not a withdrawal in the upstream engine: it is
absent from lists, feeds and the sitemap, but an exact item URL may still expose
its original title, source and link. A random unknown ID must return `404`.
Do not claim unlisted content is inaccessible. Full-text restrictions apply to
all detail, Markdown and RSS projections independently.

## Backup and update

Build first. Then stop every writer and take a matched database/files snapshot
before running any migration. The pause also prevents feedback uploads from
changing between the database dump and file archive. Run these commands in a
shell that stops on failure; do not continue after an unsuccessful backup.

```sh
set -e
umask 077
dc build
dc stop api worker web
BACKUP="$HOME/agenthot-backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP"
git rev-parse HEAD > "$BACKUP/source-revision.txt"
dc exec -T db pg_dump -U aihot -Fc aihot > "$BACKUP/database.dump"
dc run --rm -T --no-deps --entrypoint tar api -C /data --exclude=./backups -czf - . > "$BACKUP/data.tar.gz"
dc exec -T db pg_restore --list < "$BACKUP/database.dump" > "$BACKUP/database.contents.txt"
tar -tzf "$BACKUP/data.tar.gz" > "$BACKUP/data.contents.txt"
dc run --rm setup
dc up -d api web
```

Record both the previously running release SHA and the proposed new SHA with the
backup. `source-revision.txt` records the checkout, which may already be the new
revision after a pull; it is not proof of the previously running release. Record
the old `/api/health` release before stopping it. Store backups outside the
repository with restricted access and copy them to an operator-controlled backup
location. They contain private feedback and database records. Keep the production
secret file separately; neither the database dump nor file archive replaces it.

Run acceptance again after the update. If setup fails, leave the API and worker
stopped; investigate the migration rather than bypassing its ledger. Do not
overwrite a published migration or assume that an older application can read the
newer schema.

## Restore and rollback

First validate a backup in a separate, empty recovery project. The commands below
create only a database and restore data into that isolated project; they do not
start another Traefik router. Choose a fresh recovery project name every time.

```sh
RESTORE_PROJECT="agenthot-restore-$(date -u +%Y%m%dT%H%M%SZ)"
dc -p "$RESTORE_PROJECT" up -d --wait db
dc -p "$RESTORE_PROJECT" exec -T db pg_restore -U aihot -d aihot --no-owner --no-acl --exit-on-error < "$BACKUP/database.dump"
dc -p "$RESTORE_PROJECT" run --rm -T --no-deps --entrypoint tar api -C /data -xzf - < "$BACKUP/data.tar.gz"
dc -p "$RESTORE_PROJECT" exec -T db psql -U aihot -d aihot -c 'SELECT count(*) FROM articles;'
```

Before an actual rollback, stop all production writers and take a new safety
backup. If the schema has not changed, deploy the
previous verified code/image and rerun acceptance. If migrations changed the
schema, restore the matching old database **and** data archive into empty volumes
along with the old code; never point old code at an unverified newer database.

Restoring an older snapshot loses changes after that snapshot, including feedback.
Confirm that impact before replacing production volumes. Keep current volumes and
the safety backup until the restored release passes acceptance. Recovery projects
must not start `web` while production is using the same Traefik router labels.
