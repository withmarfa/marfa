/**
 * Finding the previous night's `scale-figures` artifact: the workflow's runs
 * on `main` are listed first, and a run's own artifacts are looked at only
 * when its turn comes. Listing artifacts across the repository instead would
 * be crowded out by other branches' runs and other artifacts.
 */

/**
 * The completed runs on `main` other than this one, newest first as the API
 * lists them. A failed night counts: its figures are the ones a change is
 * judged against, and a run that fails every night would otherwise never have
 * a previous one. The listing is asked for with `branch=main`, and each run's
 * branch is checked again here.
 */
export function pickPreviousRuns(
  listing: unknown,
  currentRunId: string,
): number[] {
  const runs = (listing as { workflow_runs?: unknown } | null)?.workflow_runs;
  if (!Array.isArray(runs)) return [];
  const ids: number[] = [];
  for (const entry of runs as Record<string, unknown>[]) {
    if (
      typeof entry?.id === "number" &&
      entry.status === "completed" &&
      entry.head_branch === "main" &&
      String(entry.id) !== currentRunId
    ) {
      ids.push(entry.id);
    }
  }
  return ids;
}

/** The first `scale-figures` artifact of one run's listing that has not expired. */
export function pickLiveArtifact(listing: unknown): number | null {
  const artifacts = (listing as { artifacts?: unknown } | null)?.artifacts;
  if (!Array.isArray(artifacts)) return null;
  for (const entry of artifacts as Record<string, unknown>[]) {
    if (
      entry?.name === "scale-figures" &&
      entry.expired === false &&
      typeof entry.id === "number"
    ) {
      return entry.id;
    }
  }
  return null;
}
