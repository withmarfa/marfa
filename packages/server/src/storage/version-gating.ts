/**
 * Determines whether a version snapshot should be created for an item update.
 *
 * Skips version creation if the most recent snapshot is within the configured
 * interval, unless the update is a state transition or an explicit snapshot request.
 */
export function shouldCreateVersion(
  latestVersionTimestamp: string | null,
  intervalMs: number,
  isStateTransition: boolean,
  forceSnapshot: boolean,
): boolean {
  if (forceSnapshot) return true;
  if (isStateTransition) return true;
  if (!latestVersionTimestamp) return true;

  const elapsed = Date.now() - new Date(latestVersionTimestamp).getTime();
  return elapsed >= intervalMs;
}
