/** The inactivity boundary; retirement runs on its next sweep after this time. */
export function grantExpiresAt(
  grant: { grantedAt: string; lastUsedAt: string | null },
  inactivityDays: number,
): string | null {
  if (inactivityDays <= 0) return null;
  return new Date(
    Date.parse(grant.lastUsedAt ?? grant.grantedAt) +
      inactivityDays * 86_400_000,
  ).toISOString();
}
