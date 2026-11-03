/** Finding the previous night's `scale-figures` artifact in the API's listing. */

export interface ArtifactRef {
  id: number;
  workflow_run: { id: number; head_branch: string };
}

/**
 * The newest artifact on `main` that has not expired and belongs to another
 * run. The listing arrives newest first. A failed night counts: its figures
 * are the ones a change is judged against, and a run that fails every night
 * would otherwise never have a previous one.
 */
export function pickPreviousArtifact(
  listing: unknown,
  currentRunId: string,
): ArtifactRef | null {
  const artifacts = (listing as { artifacts?: unknown } | null)?.artifacts;
  if (!Array.isArray(artifacts)) return null;
  for (const entry of artifacts as Record<string, unknown>[]) {
    const run = entry.workflow_run as
      { id?: unknown; head_branch?: unknown } | undefined;
    if (
      typeof entry.id !== "number" ||
      entry.expired !== false ||
      typeof run?.id !== "number" ||
      run.head_branch !== "main" ||
      String(run.id) === currentRunId
    ) {
      continue;
    }
    return {
      id: entry.id,
      workflow_run: { id: run.id, head_branch: run.head_branch },
    };
  }
  return null;
}
