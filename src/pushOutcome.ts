// Decides what a push actually accomplished, from the import job's own
// result — never from the preview/intended change set. GH #1047: the old
// code fell back to `addCount + modCount` (what the push INTENDED to write)
// whenever the job result omitted `appliedCount`, so a push whose write
// silently applied nothing still reported "Push complete" with the intended
// counts.

export interface ImportJobResult {
  success?: boolean;
  appliedCount?: number;
  skippedCount?: number;
  failedCount?: number;
  failures?: Array<{ name: string; error: string }>;
}

export interface PushOutcome {
  /** True when the push intended to change pages but confirmed none applied — report failure, not "Push complete". */
  allFailed: boolean;
  appliedCount: number;
  skippedCount: number;
  failedCount: number;
  /** "<name>: <reason>" lines for the notice and the sync log. */
  failureLines: string[];
}

export function decidePushOutcome(
  jobResult: ImportJobResult | undefined,
  changedCount: number,
): PushOutcome {
  const appliedCount = jobResult?.appliedCount ?? 0;
  const skippedCount = jobResult?.skippedCount ?? 0;
  const failedCount = jobResult?.failedCount ?? 0;
  const failures = jobResult?.failures ?? [];
  return {
    allFailed: changedCount > 0 && appliedCount === 0,
    appliedCount,
    skippedCount,
    failedCount,
    failureLines: failures.map((f) => `${f.name}: ${f.error}`),
  };
}
