// A bounded operator run. Database and external calls live in production.ts; this file makes
// incomplete work explicit without letting a later issue's intake block an already closed window.
export const RUN_LIMIT = 24;
export const PREPARATION_WINDOW_MS = 2 * 60 * 60 * 1000;
export type Phase = "collect" | "publish";
export const REQUIRED_MODELS = ["prefilter", "score", "understand", "summarize", "structure", "group", "groupReview"] as const;
export const DISABLED_VALVES = ["FEISHU_CONTENT_PUSH_ENABLED", "FEISHU_INTERNAL_ENABLED", "INDEXNOW_SUBMIT_ENABLED"] as const;

export interface Source {
  id: string;
  enabled: boolean;
  kind: string;
  participationMode: string;
  health: string;
  lastOkAt: string | null;
  createdAt?: string;
}

export interface PendingArticle {
  id: string;
  sourceId: string;
  processingState: string;
  groupingStatus: string;
  bodyStatus: string;
  backfill: boolean;
  retryAt: string | null;
  discoveredAt: string;
  timelineAt: string | null;
  blockedReceipt: boolean;
  attemptTag: string | null;
  awaitingSource?: boolean;
}

export interface Snapshot {
  at: string;
  collectionCutoff: string;
  allowlist: string[];
  sources: Source[];
  budget: { perMinute: number; perHour: number; perDay: number } | null;
  valves: Record<string, string | undefined>;
  models: Record<string, string>;
  adapterConfigured: boolean;
  otherPaidProviders: boolean;
  pending: PendingArticle[];
  due: { key: string; windowStart: string; windowEnd: string; exists: boolean; entries: number | null };
  preparation: { status: string; collectionVerified: boolean; startedAt: string; finishedAt: string | null; sourceIds: string[] } | null;
}

export interface Collection {
  sourceId: string;
  status: "ok" | "failed" | "skipped";
  found: number;
  created: number;
  revised: number;
}

export interface Dependencies {
  snapshot(): Promise<Snapshot>;
  collect(sourceId: string): Promise<Collection>;
  extract(articleId: string): Promise<string>;
  process(articleId: string, attemptTag?: string): Promise<{ state: string }>;
  group(articleId: string): Promise<{ verdict: string; consolidationError?: string; reclaimError?: string; rematchError?: string }>;
  compose(key: string): Promise<{ key: string; entries: number }>;
}

export function allowedSources(snapshot: Snapshot): Source[] {
  const ids = new Set(snapshot.allowlist);
  return snapshot.sources.filter(source => ids.has(source.id) && source.enabled && ["rss", "json_list"].includes(source.kind) && source.participationMode === "editorial");
}

export function deploymentProblems(snapshot: Snapshot): string[] {
  const problems: string[] = [];
  for (const key of DISABLED_VALVES) {
    if (snapshot.valves[key] !== "false") problems.push(`${key} must be false`);
  }
  if (!snapshot.budget || !Object.values(snapshot.budget).every(value => Number.isSafeInteger(value) && value > 0)) {
    problems.push("A positive finite codex-cli request budget is required");
  }
  for (const step of REQUIRED_MODELS) {
    if (snapshot.models[step] !== "gpt-6.1-sol") problems.push(`${step} must use gpt-6.1-sol`);
  }
  if (snapshot.otherPaidProviders) problems.push("Optional paid extraction or embedding providers must be absent");
  if (!allowedSources(snapshot).length) problems.push("No enabled editorial sources from the site allowlist");
  return problems;
}

export function runOnlyProblems(snapshot: Snapshot): string[] {
  const problems: string[] = [];
  for (const key of ["COLLECT_ENABLED", "MODEL_CALLS_ENABLED"]) {
    if (snapshot.valves[key] !== "true") problems.push(`${key} must be true`);
  }
  if (!snapshot.adapterConfigured) problems.push("The Codex CLI adapter must be configured");
  return problems;
}

export const runProblems = (snapshot: Snapshot): string[] => [...deploymentProblems(snapshot), ...runOnlyProblems(snapshot)];

export function publicationProblems(snapshot: Snapshot): string[] {
  const problems: string[] = deploymentProblems(snapshot);
  for (const key of ["COLLECT_ENABLED", "MODEL_CALLS_ENABLED", ...DISABLED_VALVES]) {
    if (snapshot.valves[key] !== "false") problems.push(`${key} must be false during publication`);
  }
  if (snapshot.adapterConfigured) problems.push("Publication must not have a model adapter");
  const end = Date.parse(snapshot.due.windowEnd);
  const preparation = snapshot.preparation;
  const started = Date.parse(preparation?.startedAt ?? "");
  const finished = Date.parse(preparation?.finishedAt ?? "");
  if (!Number.isFinite(end) || end > Date.parse(snapshot.at)) problems.push("Daily window has not closed");
  if (!preparation || !["ok", "failed"].includes(preparation.status) || !preparation.collectionVerified || !Number.isFinite(started) || !Number.isFinite(finished)
    || started < end - PREPARATION_WINDOW_MS || started >= end || finished >= end || finished < started) {
    problems.push("No completed collection pass before this issue's cutoff");
  } else {
    for (const source of allowedSources(snapshot)) {
      if (source.createdAt && Date.parse(source.createdAt) >= end) continue;
      if (!preparation.sourceIds.includes(source.id)) problems.push(`Source absent from pre-cutoff collection: ${source.id}`);
    }
  }
  return problems;
}

function scopedPending(snapshot: Snapshot): PendingArticle[] {
  const sourceIds = new Set(allowedSources(snapshot).map(source => source.id));
  return snapshot.pending.filter(article => sourceIds.has(article.sourceId));
}

export function pendingSummary(snapshot: Snapshot) {
  const scoped = scopedPending(snapshot);
  const pending = scoped.filter(article => !article.backfill);
  const ready = pending.filter(article => (article.processingState === "new" && article.groupingStatus !== "failed"
    || article.processingState === "analyzed" && article.groupingStatus !== "complete")
    && !article.blockedReceipt && (!article.retryAt || Date.parse(article.retryAt) <= Date.parse(snapshot.at)));
  ready.sort((a, b) => b.discoveredAt.localeCompare(a.discoveredAt) || a.id.localeCompare(b.id));
  return {
    total: pending.length,
    ready: ready.length,
    historicalPending: scoped.filter(article => article.backfill).length,
    failed: pending.filter(article => article.processingState === "failed" || article.groupingStatus === "failed").length,
    awaitingSource: pending.filter(article => article.awaitingSource).length,
    blockedReceipts: pending.filter(article => article.blockedReceipt).length,
    deferred: pending.filter(article => article.processingState === "new" && article.retryAt && Date.parse(article.retryAt) > Date.parse(snapshot.at)).length,
    groupingPending: pending.filter(article => article.processingState === "analyzed").length,
    candidates: ready.slice(0, RUN_LIMIT),
  };
}

export function check(snapshot: Snapshot) {
  const problems = deploymentProblems(snapshot);
  return { status: "check", at: snapshot.at, collectionCutoff: snapshot.collectionCutoff, ready: problems.length === 0, problems, runWouldRequire: runOnlyProblems(snapshot),
    publishWouldRequire: publicationProblems(snapshot), preparation: snapshot.preparation,
    sources: snapshot.sources, budget: snapshot.budget, models: snapshot.models, due: snapshot.due, pending: pendingSummary(snapshot), limit: RUN_LIMIT };
}

export interface RunResult {
  phase: Phase;
  collectionVerified: boolean;
  status: "complete" | "incomplete" | "blocked" | "awaiting-first-live-issue";
  problems: string[];
  collected: Collection[];
  processed: Array<{ id: string; state: string; extraction?: string; grouping?: string }>;
  remaining: ReturnType<typeof pendingSummary> | null;
  report: { key: string; entries: number; existing: boolean } | null;
}

export async function runDaily(deps: Dependencies, phase: Phase): Promise<RunResult> {
  const initial = await deps.snapshot();
  const verify = phase === "collect" ? runProblems : publicationProblems;
  const result: RunResult = { phase, collectionVerified: false, status: "blocked", problems: verify(initial), collected: [], processed: [], remaining: null, report: null };
  if (result.problems.length) return result;
  const globalProblems: string[] = [];
  const globalProblem = (...problems: string[]) => { globalProblems.push(...problems); result.problems.push(...problems); };
  for (const source of phase === "collect" ? allowedSources(initial) : []) {
    try {
      const collected = await deps.collect(source.id);
      result.collected.push({ sourceId: collected.sourceId, status: collected.status,
        found: collected.found, created: collected.created, revised: collected.revised });
      if (collected.status !== "ok") globalProblem(`Collection ${collected.status}: ${source.id}`);
    } catch {
      globalProblem(`Collection failed: ${source.id}`);
    }
  }
  const gathered = await deps.snapshot();
  globalProblem(...verify(gathered));
  if (phase === "collect" && !globalProblems.length) {
    const existingBlocked = new Set(scopedPending(gathered).filter(item => item.blockedReceipt).map(item => item.id));
    for (const candidate of pendingSummary(gathered).candidates) {
      // Re-read before every article: a paused source, an administrator's model change, or a
      // failed/unknown receipt must stop new work rather than reuse the original snapshot.
      const current = await deps.snapshot();
      const problems = runProblems(current);
      if (problems.length) { globalProblem(...problems); break; }
      if (scopedPending(current).some(item => !item.backfill && item.blockedReceipt && !existingBlocked.has(item.id))) {
        globalProblem("A live model receipt became unresolved during collection");
        break;
      }
      const article = pendingSummary(current).candidates.find(item => item.id === candidate.id);
      if (!article) continue;
      const processed: RunResult["processed"][number] = { id: article.id, state: "failed" };
      result.processed.push(processed);
      let step: "extract" | "process" | "group" | "verify" = "process";
      try {
        if (article.processingState === "analyzed") processed.state = "group-only";
        else {
          if (article.bodyStatus === "pending") {
            step = "extract";
            processed.extraction = await deps.extract(article.id);
            if (!["ok", "unconfirmed", "skipped"].includes(processed.extraction)) {
              processed.state = "extraction-incomplete";
              result.problems.push(`Extraction ${processed.extraction}: ${article.id}`);
              if (processed.extraction !== "retrying") break;
              continue;
            }
          }
          step = "verify";
          const beforeProcess = await deps.snapshot();
          const stepProblems = runProblems(beforeProcess);
          if (stepProblems.length) { globalProblem(...stepProblems); break; }
          if (!pendingSummary(beforeProcess).candidates.some(item => item.id === article.id)) {
            processed.state = "deferred";
            globalProblem(`Article changed before processing: ${article.id}`);
            break;
          }
          step = "process";
          processed.state = (await deps.process(article.id, article.attemptTag ?? undefined)).state;
        }
        if (["pass", "group-only"].includes(processed.state)) {
          step = "verify";
          const beforeGroup = await deps.snapshot();
          const stepProblems = runProblems(beforeGroup);
          if (stepProblems.length) { globalProblem(...stepProblems); break; }
          if (!pendingSummary(beforeGroup).candidates.some(item => item.id === article.id && item.processingState === "analyzed")) {
            globalProblem(`Article changed before grouping: ${article.id}`);
            break;
          }
          step = "group";
          const grouped = await deps.group(article.id);
          processed.grouping = grouped.verdict;
          if (grouped.consolidationError || grouped.reclaimError || grouped.rematchError) {
            globalProblem(`Grouping incomplete: ${article.id}`);
            break;
          }
        } else if (processed.state === "awaiting-source") result.problems.push(`Processing awaiting-source: ${article.id}`);
        else if (!["block", "unknown"].includes(processed.state)) {
          // One lost model result must not turn a broken transport into a batch of unknown calls.
          globalProblem(`Processing ${processed.state}: ${article.id}`);
          break;
        }
      } catch {
        if (step === "verify") globalProblem(`Runtime verification failed: ${article.id}`);
        else if (step === "group") globalProblem(`Grouping failed: ${article.id}`);
        else globalProblem(`${step === "extract" ? "Extraction" : "Processing"} failed: ${article.id}`);
        break;
      }
    }
  }
  const final = await deps.snapshot();
  globalProblem(...verify(final));
  result.remaining = pendingSummary(final);
  if (result.remaining.total) result.problems.push(`${result.remaining.total} articles remain unfinished`);
  // Only a known timeline at/after the final cutoff proves this debt belongs to a later issue.
  // Re-evaluate against the final due window because processing can cross the edition time.
  const pending = new Map(scopedPending(final).filter(article => !article.backfill).map(article => [article.id, article]));
  const groupingDebt = [...pending.values()].filter(article => article.groupingStatus === "failed"
    || article.processingState === "analyzed" && article.groupingStatus !== "complete");
  if (groupingDebt.length) globalProblem(`${groupingDebt.length} article grouping decisions remain unfinished`);
  if (phase === "collect") {
    result.collectionVerified = !globalProblems.length
      && allowedSources(final).every(source => result.collected.some(row => row.sourceId === source.id && row.status === "ok"))
      && result.processed.every(row => ["pass", "block", "unknown", "group-only", "awaiting-source"].includes(row.state)
        || row.state === "extraction-incomplete" && row.extraction === "retrying");
    result.status = result.problems.length ? "incomplete" : "complete";
    return result;
  }
  const start = Date.parse(final.due.windowStart);
  const end = Date.parse(final.due.windowEnd);
  const blocksReport = (id: string) => {
    const article = pending.get(id);
    // Material with a confirmed unavailable body is parked, not judged as low-value news. Keep
    // its failure visible, but do not hold every other source or every future issue hostage.
    if (article?.awaitingSource && !article.blockedReceipt) return false;
    const timeline = article?.timelineAt;
    const at = timeline ? Date.parse(timeline) : NaN;
    return !Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(at) || at >= start && at < end;
  };
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) globalProblem("Daily window cutoff is invalid");
  if (globalProblems.length || [...pending.keys()].some(blocksReport)) {
    result.status = "incomplete";
    return result;
  }
  try {
    const report = await deps.compose(final.due.key);
    result.report = { ...report, existing: final.due.exists };
    result.status = result.problems.length ? "incomplete" : "complete";
  } catch (error) {
    if (error instanceof Error && error.message === `daily ${final.due.key}: nothing judged in its window`) {
      result.status = result.problems.length ? "incomplete" : "awaiting-first-live-issue";
      result.problems.push("No judged live news in the due window; no quiet issue was fabricated");
    } else {
      result.status = "incomplete";
      result.problems.push(`Daily composition failed: ${final.due.key}`);
    }
  }
  return result;
}
