import { isValidTimestamp } from "@withmarfa/shared";

/** The eligibility deadline, not a promise about when the next sweep runs. */
export function trashEligibleAt(
  trashedAt: string | null,
  days: number,
): string | null {
  if (
    !trashedAt ||
    !isValidTimestamp(trashedAt) ||
    !Number.isSafeInteger(days) ||
    days <= 0
  )
    return null;
  const start = Date.parse(trashedAt);
  const deadline = start + days * 86_400_000;
  if (
    !Number.isFinite(deadline) ||
    deadline > 253402300799999 ||
    deadline < -62135596800000
  )
    return null;
  return new Date(deadline).toISOString();
}
