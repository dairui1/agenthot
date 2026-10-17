# Bounded Article Readings

The reading module adds an original, evidence-grounded interpretation to an
article detail page. It is not a source full-text republication, a new score, an
article reprocessing run, or a replacement daily issue. Future article analysis
can include it in the existing understanding response. This manual operation
only supplements explicitly approved, already verified articles.

Deploy the module and its migration with the normal [deployment runbook](agenthot.md)
before checking or running it. The operator Mac keeps its own Codex login; no
OAuth files are copied to production. The existing daily automation and its
06:30/08:00/08:30 schedule are unchanged.

## Explicit Selection

Start with a local JSON selection containing one to twelve distinct article IDs:

```json
{"version":1,"articleIds":["v44du42xsuptbp0xhawut95nj"]}
```

The first approved rollout targets only the 2026-10-17 daily's 11 main items and
one flash. Check and generate the single article above first, inspect the actual
detail page and quality of the result, then separately approve the remaining
at most 11. Do not expand this operation to the archive or rewrite the report.
The seven unknown outcomes, receipts 97-103, remain untouched.

```sh
python3 scripts/agenthot-reading.py --check /tmp/reading-selection.json
```

`--check` is read-only. It starts no adapter and enables neither collection nor
models. Its result includes `manifest`, with each article's current revision,
analysis ID, material hash and plan hash, plus the IDs that already have a valid
reading. The backend computes these identities from stored evidence; do not
hand-calculate a body hash or substitute an earlier analysis.

An operator can select the exact current issue IDs with this read-only database
query, using the established private database connection rather than exposing
credentials on a command line:

```sql
WITH issue AS (
  SELECT content FROM reports WHERE kind='daily' AND key='2026-10-17'
), items AS (
  SELECT item->>'itemId' AS id FROM issue,
    LATERAL jsonb_array_elements(content->'sections') section,
    LATERAL jsonb_array_elements(section->'items') item
  UNION
  SELECT item->>'itemId' FROM issue,
    LATERAL jsonb_array_elements(content->'flashes') item
)
SELECT jsonb_build_object('version',1,'articleIds',jsonb_agg(id ORDER BY id))
FROM items;
```

Review the check response and use its `manifest` object as the run input, not the
whole response envelope. Only a complete binding is accepted for writing:

```json
{"version":1,"items":[{"articleId":"v44du42xsuptbp0xhawut95nj","revision":1,"analysisId":123,"materialHash":"<64 hex from check>","planHash":"<64 hex from check>"}]}
```

```sh
python3 scripts/agenthot-reading.py --run /tmp/reading-manifest.json
```

## Guarantees And Stops

- The whole explicit batch is rechecked before the first write. A changed
  revision, analysis, material or unfulfilled plan requires a new check and
  review. Existing valid readings are reused without another model request.
- Each new reading uses only the stored verified material, `gpt-6.1-sol`, and the
  separate `reading_article` receipt purpose. It does not collect, extract,
  translate, score, group, compose or fetch images. Selection standards and
  existing analyses and reports are unchanged.
- Any pending, unknown or failed receipt for that article, including another
  revision or purpose, blocks the operation. A first new failure stops the batch;
  later items are not attempted. There are no automatic retries or alternate
  attempt tags. Retain all receipt and local journal evidence for investigation.
- The existing finite Codex budget is required and enforced for every paid
  request. This command cannot increase it, reset it, or purchase quota. A
  successful read-only check does not reserve budget for a later run.
- `COLLECT_ENABLED`, AgentLab sync, notification and IndexNow valves remain
  false. Only the writing container has `MODEL_CALLS_ENABLED=true`. Reader
  requests never generate a reading.
- The transport reuses the daily operation lock and fixed container name, local
  adapter isolation, single SSH connection, loopback-only reverse tunnel, fresh
  heartbeat lease, Git/release/image checks and exact-created-CID cleanup.
  It cannot run concurrently with the local daily command. A check is bounded
  to 60 seconds; a run is bounded to 45 minutes, including startup and a remote
  cleanup reserve. Twelve individual requests have a 180-second model timeout.
- Adapter tokens and the explicit manifest travel through SSH stdin, never
  command arguments or a production credential file. The temporary container
  retains the daily transport's read-only root and dropped capabilities.

Check both the process exit code and its structured result. On a partial failure,
`completed` lists only results returned before the first failing article. A
transport loss can leave a request outcome uncertain; absence from that list is
not proof of no request or no charge. Do not resend it to find out. Reconcile the
stored receipts and durable local response journal before considering any action.

After a successful write, verify the real article detail page and its site API:
the reading must match the current material, make evidence and uncertainty clear,
and leave the score, source attribution, source link and daily report unchanged.
An unavailable or stale reading is hidden rather than regenerated by a reader.

## Offline Verification

```sh
python3 -m unittest discover -s tests -p 'test_agenthot_*.py'
node --import ./tests/standalone.ts --test modules/reading/tests/transport.standalone.test.ts
```

The transport tests use local fake processes and HTTP only; the batch tests use
in-memory dependencies and never a production database or model.
