# AgentHot daily publication

The operator Mac runs the daily job; the server continues to serve readers and
sync AgentLab independently. No Codex login or OAuth file is copied to the server.
The Codex chat heartbeat starts collection daily at 06:30, Asia/Taipei (UTC+8),
before the unchanged 08:00 cutoff, and publication at 08:30. These are start times,
not guaranteed completion times. The Mac, Codex app, network, SSH key and Codex
login must be available. AgentLab's 09:15 research naturally enters the next
window; it is never backdated into the already closed issue.

## Commands

From the repository root, with Node 24.11+ and Python 3 available:

```sh
python3 scripts/agenthot-daily.py --check
python3 scripts/agenthot-daily.py --collect
python3 scripts/agenthot-daily.py --publish
```

`--check` reads production state only. It does not start the adapter or enable
collection/model calls. `--collect` creates a temporary local adapter, an SSH reverse
tunnel bound to server loopback, and one short-lived production container.
The container runs the existing collection, analysis, publication and grouping
functions, but never composes an issue. `--publish` uses the native daily composer
without collection, model credentials, an adapter or a tunnel. `--check` exposes
`publishWouldRequire`: publication requires a verified collection pass that
started within two hours before the due cutoff and finished before it, covering
every enabled allowlisted source present before that cutoff. `collectionVerified`
records source coverage separately from queue completion. Incomplete results
retain their structured detail in a failed job record, so a known body-only
shortfall cannot erase otherwise verified collection. A missing, unfinished,
late or unverified pass is not preparation. The latest attempt wins; an older
success cannot hide a newer source/model/configuration failure. The superseded combined `--run`
mode is rejected. Writing publication and report records makes content live;
daily content updates do not need a site rebuild.

Scheduled collection must pass `--before` with the exact timezone-qualified
`collectionCutoff` returned by `--check`, derived from shared site configuration.
Both local and remote timeouts are shortened to this deadline, including startup
and cleanup allowance; an expired cutoff is rejected before starting an adapter.
The unqualified `--collect` command above is for explicit manual collection only,
not a substitute for a missed pre-cutoff pass. Each heartbeat still has one total
90-minute budget across its retries, not 90 minutes for every invocation.

The transport checks the local/remote Git revision, running API release and image
before it starts. Deploy code changes with the normal [runbook](agenthot.md)
first. A local process lock and the fixed container name prevent concurrent runs.
Do not remove a lock file or an existing container to force a second run: inspect
its owner and actual state first. A timeout is a failure, not proof that no model
request was billed. Retain the corresponding receipts for investigation.

## Boundaries

- Only RSS and official JSON source IDs in `industry/sources.json`, still enabled and
  editorial in the admin database, can be collected. Source pause is respected.
  This job does not add sources, change scoring thresholds or re-score AgentLab.
- All text steps must resolve to `gpt-6.1-sol`. Missing, stopped or invalid Codex
  budgets stop the job. The current audited caps are 12 requests/minute,
  60/hour and 120/rolling day, not an account-quota estimate. The runner does not
  increase caps or reset budgets.
- A run handles at most 24 live articles. Historical backfill is reported
  separately, not reprocessed or allowed to hold up current work. Deferred work,
  failed sources and unresolved live requests are reported as incomplete, not
  silently converted into a successful run. Existing published issues stay.
- Only the collecting one-shot container enables collection and model calls.
  The regular API, general worker and notification/IndexNow valves stay off.
  The temporary container has a read-only root, dropped capabilities and no
  additional public port. Host networking lets it reach the loopback SSH tunnel
  and private Docker database IP; it is not a general processing service.
- The random adapter token travels through SSH stdin, not command arguments or a
  server-side credential file. The Mac's Codex login stays local. Never log `.env`,
  container environments or token-bearing requests.
- Summary-only source permissions, anonymous public projections and AgentLab's
  withdrawal restrictions remain unchanged. Weekly/monthly writing, full-text
  translation and external notifications are not part of this daily task.

## What Counts As Published

The existing edition window ends at 08:00 UTC+8. The 08:30 job publishes that due
issue from material already eligible before the cutoff. The 06:30 phase prepares
that window and must stop by 08:00. Material first collected
or made public after 08:00 belongs to the following issue, even if its source
timestamp is older. The runner does not backdate discovery or change this rule.

Unfinished articles with a known timeline outside the issue's actual window do
not block that issue; they remain visible in the incomplete result. Current-window
retrying work, unknown timelines, missing pre-cutoff preparation, configuration
errors and grouping consistency errors still block composition. A run may therefore publish its due issue while
reporting `incomplete` for later-window work; only a fully finished pipeline is
`complete`. Check the report result and remaining work separately. Collection
completion is not publication. Each phase has its own `agenthot.daily-collect`
or `agenthot.daily-publish` job record.

An exhausted page extraction with no body or original social text stops before
the first model call as `awaiting-source`, not a low-score verdict based on a tiny
RSS description. The existing failed state retains a sanitized material-availability
reason and is excluded from daily candidates, without preventing other fully
judged content from being published. It still makes the overall pipeline incomplete;
no material at all still cannot fabricate a quiet issue. An upstream access
challenge remains an external block: do not bypass it,
enable paid extraction, claim full text was fetched or automatically reset its
attempts. The admin's audited extraction rerun remains the recovery path after
source access is genuinely restored. Existing analyses and completed receipts are
not silently rewritten or rerun by this deployment.

AgentLab supplies reviewed, complete, fresh, non-backfill candidates through its
module and the same public projection. These use the existing evidence without
model rescoring or mapping importance to an invented numeric score. Actual daily
admission time, independent editorial overrides, suppression and withdrawal all
remain effective. Exact release identities are deduplicated across the AgentLab
and official-release sources; generic repository links cannot merge different
versions. See the [module contract](../modules/agentlab/README.md).

A source's first import is historical backfill and cannot manufacture today's
news. When no material has been judged in the issue window, the native composer
fails with `nothing judged in its window`. Report this as awaiting the first live
issue, not as a successfully published quiet day. A legitimately quiet issue is
possible only after the engine has actually judged material in that window.

An explicit owner request can publish the current issue early. This uses the
native daily composer with an `asOf` cutoff: the window starts at the previous
scheduled cutoff but ends at the actual publication time, never in the future.
The saved issue is marked provisional, and public pages and Agent responses
identify it as an early edition. It is not a completed 08:00 edition.

After the scheduled cutoff, the normal daily composer finalizes that provisional
issue with the full window and retains the early content as a report revision.
Already-final issues remain unchanged on automatic retries. An early edition
cannot replace a final issue or move an existing cutoff backward. The daily
heartbeat retains the two phases above; early publication is an explicit manual action,
not an additional recurring run or permission to change the edition schedule.

After a run, check the exit code, source outcomes, live remainder, receipt states
and exact issue date. Verify the real `/daily`, its dated issue and
`/api/health` at `https://agenthot.dairui1.com`. Do not claim success from HTTP 200
alone: a previous issue can still be serving. Check AgentLab sync independently;
its healthy `/all` feed does not prove that the RSS/editorial pipeline finished.

The collection heartbeat may make at most two additional serial `--collect` runs
only for native body extraction retries, within one 90-minute deadline including
waits and never past 08:00. Wait until all
affected `processing_retry_at` values have passed, then run `--check` again. It
must be ready, with no deferred work, failed articles or blocked receipts, and
only the same articles ready for recovery. Do not reset attempts or receipts.
Source, budget, model or grouping errors stop this recovery branch. Each run
reads the configured feeds again and can discover new material, so three runs need not empty the
queue. Report any remainder; never add a fourth run to manufacture success.

The heartbeat stays quiet when nothing meaningful changed. Notify on a verified
new publication, a failure, or a required operator action. An unavailable Mac can
miss the planned start; no server-only schedule can use its local Codex login.
