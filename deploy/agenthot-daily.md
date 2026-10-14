# AgentHot daily publication

The operator Mac runs the daily job; the server continues to serve readers and
sync AgentLab independently. No Codex login or OAuth file is copied to the server.
The Codex chat heartbeat starts this job daily at 10:00, Asia/Taipei (UTC+8), after
AgentLab's 09:15 release check. This is the start time, not a guaranteed completion
time. The Mac, Codex app, network, SSH key and Codex login must be available.

## Commands

From the repository root, with Node 24.11+ and Python 3 available:

```sh
python3 scripts/agenthot-daily.py --check
python3 scripts/agenthot-daily.py --run
```

`--check` reads production state only. It does not start the adapter or enable
collection/model calls. `--run` creates a temporary local adapter, an SSH reverse
tunnel bound to server loopback, and one short-lived production container.
The container runs the existing collection, analysis, publication and grouping
functions, then the native daily composer. Writing the publication and report
records makes content live; daily content updates do not need a site rebuild.

The transport checks the local/remote Git revision, running API release and image
before it starts. Deploy code changes with the normal [runbook](agenthot.md)
first. A local process lock and the fixed container name prevent concurrent runs.
Do not remove a lock file or an existing container to force a second run: inspect
its owner and actual state first. A timeout is a failure, not proof that no model
request was billed. Retain the corresponding receipts for investigation.

## Boundaries

- Only the existing RSS IDs in `industry/sources.json`, still enabled and
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
- The one-shot container enables collection and model calls only for itself.
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

The existing edition window ends at 08:00 UTC+8. The 10:00 job publishes that due
issue from material already eligible before the cutoff. Material first collected
or made public after 08:00 belongs to the following issue, even if its source
timestamp is older. The runner does not backdate discovery or change this rule.

Unfinished articles whose recorded timeline is at or after the issue's cutoff
belong to a later window and do not block the due issue. Earlier or unknown
timelines, collection failures, configuration errors and grouping consistency
errors still block composition. A run may therefore publish its due issue while
reporting `incomplete` for later-window work; only a fully finished pipeline is
`complete`. Check the report result and the remaining work separately.

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
heartbeat still starts at 10:00; early publication is an explicit manual action,
not an additional recurring run or permission to change the edition schedule.

After a run, check the exit code, source outcomes, live remainder, receipt states
and exact issue date. Verify the real `/daily`, its dated issue and
`/api/health` at `https://agenthot.dairui1.com`. Do not claim success from HTTP 200
alone: a previous issue can still be serving. Check AgentLab sync independently;
its healthy `/all` feed does not prove that the RSS/editorial pipeline finished.

The heartbeat may make at most two additional serial runs only for native body
extraction retries, within one 90-minute deadline including waits. Wait until all
affected `processing_retry_at` values have passed, then run `--check` again. It
must be ready, with no deferred work, failed articles or blocked receipts, and
only the same articles ready for recovery. Do not reset attempts or receipts.
Source, budget, model or grouping errors stop this recovery branch. Each run
reads RSS again and can discover new material, so three runs need not empty the
queue. Report any remainder; never add a fourth run to manufacture success.

The heartbeat stays quiet when nothing meaningful changed. Notify on a verified
new publication, a failure, or a required operator action. An unavailable Mac can
miss the planned start; no server-only schedule can use its local Codex login.
