import type { Version, VersionPolicy } from "@mymehq/shared";

export interface ResolvedPolicy {
  recentDays: number;
  dailySnapshotDays: number;
  weeklySnapshotDays: number;
  maxVersions: number;
}

/**
 * Merges a per-type version policy with global defaults.
 * Per-type fields override defaults field-by-field.
 */
export function resolvePolicy(
  typePolicy: VersionPolicy | undefined,
  globalDefaults: ResolvedPolicy,
): ResolvedPolicy {
  if (!typePolicy) return globalDefaults;
  return {
    recentDays: typePolicy.recent_days ?? globalDefaults.recentDays,
    dailySnapshotDays:
      typePolicy.daily_snapshot_days ?? globalDefaults.dailySnapshotDays,
    weeklySnapshotDays:
      typePolicy.weekly_snapshot_days ?? globalDefaults.weeklySnapshotDays,
    maxVersions: typePolicy.max_versions ?? globalDefaults.maxVersions,
  };
}

/**
 * Returns the ISO week key ("YYYY-Www") for a date, used for weekly bucketing.
 */
function isoWeekKey(date: Date): string {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${String(d.getUTCFullYear())}-W${String(weekNo).padStart(2, "0")}`;
}

/**
 * Time Machine-style version thinning. Given all versions for a single item
 * and a resolved policy, returns the version IDs that should be deleted.
 *
 * Windows:
 * - Recent (< recentDays ago): keep every version
 * - Daily (recentDays..dailySnapshotDays): keep latest per calendar day (UTC)
 * - Weekly (dailySnapshotDays..weeklySnapshotDays): keep latest per ISO week
 * - Beyond weekly window: delete
 *
 * Invariants:
 * - Never deletes the most recent version (by version number)
 * - Never deletes if only 1 version exists
 * - Hard cap: if kept > maxVersions, drop oldest first
 */
export function computeVersionsToDelete(
  versions: Version[],
  policy: ResolvedPolicy,
  now: Date = new Date(),
): string[] {
  if (versions.length <= 1) return [];

  const recentCutoff = new Date(
    now.getTime() - policy.recentDays * 86_400_000,
  );
  const dailyCutoff = new Date(
    now.getTime() - policy.dailySnapshotDays * 86_400_000,
  );
  const weeklyCutoff = new Date(
    now.getTime() - policy.weeklySnapshotDays * 86_400_000,
  );

  const keepIds = new Set<string>();

  // Group versions by time window
  const dailyBuckets = new Map<string, Version[]>();
  const weeklyBuckets = new Map<string, Version[]>();

  for (const v of versions) {
    const createdAt = new Date(v.created_at);

    if (createdAt >= recentCutoff) {
      keepIds.add(v.id);
    } else if (createdAt >= dailyCutoff) {
      const dayKey = v.created_at.slice(0, 10);
      const bucket = dailyBuckets.get(dayKey);
      if (bucket) {
        bucket.push(v);
      } else {
        dailyBuckets.set(dayKey, [v]);
      }
    } else if (createdAt >= weeklyCutoff) {
      const weekKey = isoWeekKey(createdAt);
      const bucket = weeklyBuckets.get(weekKey);
      if (bucket) {
        bucket.push(v);
      } else {
        weeklyBuckets.set(weekKey, [v]);
      }
    }
    // Beyond weekly window: not added to keepIds -> will be deleted
  }

  // Keep the latest version in each daily bucket
  for (const bucket of dailyBuckets.values()) {
    const latest = bucket.reduce((a, b) =>
      a.created_at > b.created_at ? a : b,
    );
    keepIds.add(latest.id);
  }

  // Keep the latest version in each weekly bucket
  for (const bucket of weeklyBuckets.values()) {
    const latest = bucket.reduce((a, b) =>
      a.created_at > b.created_at ? a : b,
    );
    keepIds.add(latest.id);
  }

  // Always keep the most recent version by version number
  const mostRecent = versions.reduce((a, b) =>
    a.version > b.version ? a : b,
  );
  keepIds.add(mostRecent.id);

  // Hard cap: if kept exceeds max, drop oldest first (never the most recent)
  if (keepIds.size > policy.maxVersions) {
    const kept = versions
      .filter((v) => keepIds.has(v.id))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const excess = kept.length - policy.maxVersions;
    for (let i = 0; i < excess; i++) {
      if (kept[i].id !== mostRecent.id) {
        keepIds.delete(kept[i].id);
      }
    }
  }

  return versions.filter((v) => !keepIds.has(v.id)).map((v) => v.id);
}
