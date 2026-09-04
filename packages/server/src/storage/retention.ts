import type {
  AuthSessionStore,
  CoordinationStore,
  ItemStore,
  Storage,
  SpaceStore,
} from "./interface.js";
import type { SpaceConfig } from "@withmarfa/shared";
import { log } from "../middleware/logger.js";
import { logJobTickFailure } from "./job-tick.js";

const MS_PER_DAY = 86_400_000;

/**
 * Optional per-space fan-out wiring shared by both retention jobs. When
 * provided, the job:
 *   1. Lists every space via `spaces.list()`.
 *   2. For each space, resolves the effective retention (the space's
 *      `SpaceConfig` override field, falling back to the instance default).
 *   3. Runs a space-scoped sweep with that effective retention.
 *   4. Also runs the NULL-space sweep at the instance default — catches
 *      single-space self-host items and any rows with no space scope.
 *   5. Sums the deleted counts.
 *
 * Each per-space + the NULL sweep are gated by a per-space coordination
 * lock (`<jobName>:<space-id-or-null>`) so multi-instance deployments run
 * each sweep once cluster-wide per tick.
 */
export interface SpaceFanout {
  spaces: SpaceStore;
  /**
   * Field on `SpaceConfig` that holds the per-space retention
   * override. The fan-out reads `config[configField]` and treats `0`
   * as "disable for this space" (matches env-default semantics for
   * `TRASH_RETENTION_DAYS=0`).
   */
  configField: keyof Pick<
    SpaceConfig,
    | "trash_retention_days"
    | "audit_retention_days"
    | "event_log_retention_hours"
    | "activity_retention_days"
  >;
}

/**
 * Hard-deletes trashed items whose `updated_at` is older than the
 * configured retention window. Pattern mirrors `VersionThinner`:
 * single-process timer, synchronous `runOnce()` entry point for tests,
 * idempotent sweep.
 *
 * If `retentionDays <= 0`, the job is a no-op — the operator can leave
 * the deployment running with no trash purge by setting the env var to 0.
 * The default at the config layer is 60.
 *
 * When a `coordination` store is supplied, each tick is gated by a named
 * advisory lock so multi-instance deployments run the purge once per
 * tick cluster-wide instead of once per instance.
 *
 * When `fanout` is supplied, a single `runOnce()` tick fans out across
 * every space + a NULL-bucket sweep, honoring per-space
 * `trash_retention_days` overrides from `SpaceConfig`. When `fanout` is
 * omitted the job runs a single unscoped sweep using the instance default.
 * Single-space self-hosts that never wire `spaces` get the simpler path.
 *
 * **This sweep announces nothing, and neither do its two siblings below.**
 * Every other path that removes a row publishes `item.purged`, and every
 * path that removes an edge publishes `edge.deleted`, so that a client
 * which was away can learn the row is gone by replaying the event log. A
 * sweep cannot serve that: its cutoff is sixty days and the event log is
 * kept for hours, so a row it removes fell out of the replay window long
 * before it was touched, and there is no cursor left that could carry the
 * event. Writing one per row would append thousands of rows inside a
 * single transaction to a log nobody can still be reading from.
 *
 * Removing those rows is the client's own reconciliation: a cursor too old
 * to resume is answered with `catchup_too_old`, and the client re-reads
 * and prunes what the server no longer has. An absence recorded here is a
 * decision; an absence discovered later would be a defect.
 */
export class TrashPurger {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private items: ItemStore,
    private retentionDays: number,
    private intervalMs: number,
    private nowFn: () => Date = () => new Date(),
    private coordination?: CoordinationStore,
    private fanout?: SpaceFanout,
  ) {}

  start(): void {
    this.stopped = false;
    this.startupTimeout = setTimeout(() => void this.poll(), 5_000);
    this.interval = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Synchronous-style entry point used by tests and the `start()` poller.
   * Computes the cutoff date from the injected clock and asks the
   * `ItemStore` to delete every trashed row strictly older than it.
   *
   * Returns the total number of rows deleted across every space in
   * the fan-out (or just the global sweep when fan-out isn't wired).
   */
  async runOnce(): Promise<number> {
    return this.fanout
      ? runSpaceFanout({
          jobName: "trash-purge",
          coordination: this.coordination,
          fanout: this.fanout,
          nowFn: this.nowFn,
          instanceDefault: this.retentionDays,
          unitMs: MS_PER_DAY,
          sweep: (cutoff, spaceId) =>
            this.items.purgeTrashedOlderThan(cutoff, spaceId),
        })
      : this.runOnceGlobal();
  }

  private async runOnceGlobal(): Promise<number> {
    if (this.retentionDays <= 0) return 0;
    const cutoff = new Date(
      this.nowFn().getTime() - this.retentionDays * MS_PER_DAY,
    ).toISOString();
    return this.items.purgeTrashedOlderThan(cutoff);
  }

  /** Scheduler entry point: the same locked, logged tick the timer path
   *  drives — `runOnce()` alone is the bare test seam and has neither. */
  runScheduled(): Promise<void> {
    return this.poll();
  }

  private async poll(): Promise<void> {
    try {
      const deleted = this.fanout
        ? await this.runOnce()
        : this.coordination
          ? await this.coordination.withJobLock("trash-purge", () =>
              this.runOnce(),
            )
          : await this.runOnce();
      if (deleted !== undefined && deleted > 0) {
        log("info", "Trash purge", {
          deleted,
          retentionDays: this.retentionDays,
        });
      }
    } catch (err) {
      logJobTickFailure("Trash purge", err, this.stopped);
    }
  }
}

/**
 * Ages out `system.activity` items.
 *
 * An integration reports what a run did, and a run that did nothing is
 * supposed to say nothing. That convention arrived after this job did, and
 * before it one integration's reactive path wrote a row per upstream write,
 * which alone made this the fastest-growing item type by a wide margin.
 *
 * Retention existed for trash, audit rows, the event log, versions,
 * sessions and runtime credentials; activity is an ordinary item and had no
 * job at all, so the table only ever grew. Production reached 6,015
 * activity items against 805 of everything else before this landed, and was
 * still above six thousand five days later.
 *
 * Same shape as `TrashPurger` above: a per-space fan-out honoring
 * `activity_retention_days` overrides, falling back to a single unscoped
 * sweep when `spaces` is not wired.
 *
 * **This job bounds the rows; it does not decide whether a run deserves
 * one.** That is the integration's call, and the authoring guide carries
 * the rule. Retention on its own was never going to be enough:
 * it caps how many rows exist at once, not how many get written, and each
 * one costs a transaction, a quota reservation, an index update and a
 * published event whether it is purged an hour later or a fortnight.
 */
/**
 * Hard-deletes revoked application-grant tombstones once they are older than
 * the configured window.
 *
 * **The row it sweeps is not trash and is not in a terminal lifecycle state.**
 * A grant revoked through the user-facing path keeps `state: "active"` — the
 * revoke writes `status: "revoked"` and `revoked_at` onto the properties and
 * leaves the item alone, so the record survives as a record. Neither sibling
 * above can reach it: the trash purge asks about `state` and the activity
 * purge asks about `type`.
 *
 * **Why they accumulate at all.** The grant lookup skips a row whose status is
 * revoked, so an operator soft-delete is permanent rather than reusable, and
 * each revoke-then-reconnect cycle leaves one behind. Nothing swept them.
 *
 * **The window is the audit window and that is deliberate.** A tombstone and
 * the audit row that recorded the revocation are the same fact written twice,
 * so keeping them for different lengths of time would let the two disagree
 * about whether a revocation is still visible. Ninety days, matching
 * `AUDIT_RETENTION_DAYS`, and `0` disables the job as it does for the others.
 *
 * **An integration's revoked connection is not a tombstone and is not swept.**
 * The uninstall path writes the same `revoked` status as a matter of routine,
 * onto a row somebody may reinstall against. The store predicate asks
 * `kind = 'app'`.
 */
export class RevokedGrantPurger {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private items: ItemStore,
    private retentionDays: number,
    private intervalMs: number,
    private nowFn: () => Date = () => new Date(),
    private coordination?: CoordinationStore,
  ) {}

  start(): void {
    this.stopped = false;
    this.startupTimeout = setTimeout(() => void this.poll(), 20_000);
    this.interval = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async runOnce(): Promise<number> {
    if (this.retentionDays <= 0) return 0;
    const cutoff = new Date(
      this.nowFn().getTime() - this.retentionDays * MS_PER_DAY,
    ).toISOString();
    return this.items.purgeRevokedAppGrantsOlderThan(cutoff);
  }

  /** Scheduler entry point: the same locked, logged tick the timer drives. */
  runScheduled(): Promise<void> {
    return this.poll();
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    try {
      const deleted = this.coordination
        ? await this.coordination.withJobLock("revoked-grant-purge", () =>
            this.runOnce(),
          )
        : await this.runOnce();
      if (deleted !== undefined && deleted > 0) {
        log("info", "Revoked grant tombstones purged", { deleted });
      }
    } catch (err) {
      logJobTickFailure("Revoked grant purge", err, this.stopped);
    }
  }
}

export class ActivityPurger {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private items: ItemStore,
    private retentionDays: number,
    private intervalMs: number,
    private nowFn: () => Date = () => new Date(),
    private coordination?: CoordinationStore,
    private fanout?: SpaceFanout,
  ) {}

  start(): void {
    this.stopped = false;
    this.startupTimeout = setTimeout(() => void this.poll(), 15_000);
    this.interval = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async runOnce(): Promise<number> {
    return this.fanout
      ? runSpaceFanout({
          jobName: "activity-purge",
          coordination: this.coordination,
          fanout: this.fanout,
          nowFn: this.nowFn,
          instanceDefault: this.retentionDays,
          unitMs: MS_PER_DAY,
          sweep: (cutoff, spaceId) =>
            this.items.purgeActivityOlderThan(cutoff, spaceId),
        })
      : this.runOnceGlobal();
  }

  private async runOnceGlobal(): Promise<number> {
    if (this.retentionDays <= 0) return 0;
    const cutoff = new Date(
      this.nowFn().getTime() - this.retentionDays * MS_PER_DAY,
    ).toISOString();
    return this.items.purgeActivityOlderThan(cutoff);
  }

  /** Scheduler entry point: the same locked, logged tick the timer path
   *  drives — `runOnce()` alone is the bare test seam and has neither. */
  runScheduled(): Promise<void> {
    return this.poll();
  }

  private async poll(): Promise<void> {
    try {
      const deleted = this.fanout
        ? await this.runOnce()
        : this.coordination
          ? await this.coordination.withJobLock("activity-purge", () =>
              this.runOnce(),
            )
          : await this.runOnce();
      if (deleted !== undefined && deleted > 0) {
        log("info", "Activity purge", {
          deleted,
          retentionDays: this.retentionDays,
        });
      }
    } catch (err) {
      logJobTickFailure("Activity purge", err, this.stopped);
    }
  }
}

/**
 * Drops expired better-auth `auth_session` rows on a periodic tick.
 * Better Auth itself owns the session TTL via `expiresAt`; this job exists
 * only so the table doesn't grow unbounded between natural expiries
 * (browser-side ephemeral cookies vanish on tab close, but the server-side
 * row stays around until the sweep catches up).
 *
 * Instance-wide — `auth_session` carries no `space_id` column and the
 * deletion criterion is purely time-based, so the per-space fan-out shape
 * used by retention-window jobs doesn't apply. Cluster-wide coordination
 * lock keyed `"auth-session-cleanup"` keeps multi-instance deployments
 * running once per tick.
 */
export class AuthSessionCleaner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private store: AuthSessionStore,
    private intervalMs: number,
    private nowFn: () => Date = () => new Date(),
    private coordination?: CoordinationStore,
  ) {}

  start(): void {
    this.stopped = false;
    this.startupTimeout = setTimeout(() => void this.poll(), 10_000);
    this.interval = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Test entry point — drops every row whose `expires_at` is strictly
   *  before the injected clock. */
  async runOnce(): Promise<number> {
    return this.store.deleteExpired(this.nowFn());
  }

  /** Scheduler entry point — see TrashPurger.runScheduled. */
  runScheduled(): Promise<void> {
    return this.poll();
  }

  private async poll(): Promise<void> {
    try {
      const deleted = this.coordination
        ? await this.coordination.withJobLock("auth-session-cleanup", () =>
            this.runOnce(),
          )
        : await this.runOnce();
      if (deleted !== undefined && deleted > 0) {
        log("info", "Auth session cleanup", { deleted });
      }
    } catch (err) {
      logJobTickFailure("Auth session cleanup", err, this.stopped);
    }
  }
}

/**
 * Hard-delete accounts that have sat in `pending_deletion` past the grace
 * window. Pattern mirrors `AuthSessionCleaner` (instance-wide sweep,
 * cluster-wide coordination lock). Two-layer locking:
 *
 *   - Outer lock `account-deletion-purge` gates the whole tick so
 *     multi-instance deployments don't double-list the due set.
 *   - Per-account inner lock (`account-delete:<auth_user_id>`) inside
 *     the loop. Coordinates between purger ticks across instances; on
 *     its own this lock does NOT block a cancel route (the cancel
 *     never takes it).
 *
 * **Cancel-vs-cascade race.** The cancel route does not acquire the
 * per-account lock — so the lock alone cannot prevent a cancel landing
 * between `listPendingDeletionDue` and `deleteAccountCascade`. The
 * mitigation lives inside the cascade itself: `SELECT ... FOR UPDATE` on
 * the `auth_user` row + a re-check that `deletion_state === 'pending_deletion'`
 * AND `pending_deletion_at < cutoffIso` before any writes. A concurrent
 * cancel either commits before the cascade acquires the row lock (cascade
 * re-reads the fresh `active` state and short-circuits) or blocks behind
 * the cascade's row lock until the cascade commits. The `boolean` return
 * counts actually-purged accounts (a short-circuited cascade returns
 * `false`).
 *
 * `graceDays <= 0` disables the job — operator override for self-hosts
 * that don't want a grace window.
 */
export class PendingDeletePurger {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private storage: Storage,
    private graceDays: number,
    private intervalMs: number,
    private nowFn: () => Date = () => new Date(),
    private coordination?: CoordinationStore,
  ) {}

  start(): void {
    this.stopped = false;
    this.startupTimeout = setTimeout(() => void this.poll(), 15_000);
    this.interval = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Test-driven entry point. Returns the number of accounts purged
   *  this tick. */
  async runOnce(): Promise<number> {
    if (this.graceDays <= 0) return 0;
    const accountLifecycle = this.storage.accountLifecycle;
    if (!accountLifecycle) return 0;
    const cutoff = new Date(
      this.nowFn().getTime() - this.graceDays * MS_PER_DAY,
    ).toISOString();
    const due = await accountLifecycle.listPendingDeletionDue(cutoff);
    let purged = 0;
    for (const row of due) {
      // The per-account lock keeps two purger instances from racing on the
      // same row. The cascade's in-transaction re-check is what guards
      // against a concurrent cancel. Use the cascade's boolean return to
      // track whether the row was actually purged (vs. short-circuited
      // because the user cancelled between list + cascade).
      const cascadeRan = this.coordination
        ? await this.coordination.withJobLock(
            `account-delete:${row.auth_user_id}`,
            () => this.storage.deleteAccountCascade(row.auth_user_id, cutoff),
          )
        : await this.storage.deleteAccountCascade(row.auth_user_id, cutoff);
      if (cascadeRan === true) purged += 1;
    }
    return purged;
  }

  /** Scheduler entry point — see TrashPurger.runScheduled. */
  runScheduled(): Promise<void> {
    return this.poll();
  }

  private async poll(): Promise<void> {
    try {
      const purged = this.coordination
        ? await this.coordination.withJobLock("account-deletion-purge", () =>
            this.runOnce(),
          )
        : await this.runOnce();
      if (purged !== undefined && purged > 0) {
        log("info", "Pending-delete purge", {
          purged,
          graceDays: this.graceDays,
        });
      }
    } catch (err) {
      logJobTickFailure("Pending-delete purge", err, this.stopped);
    }
  }
}

/**
 * Drops expired `rate_limit_windows` rows on a periodic tick. Expired rows
 * aren't a correctness risk (the upsert path overwrites them transparently);
 * the GC just keeps the table from growing unboundedly across the long tail
 * of one-shot windows (e.g. a single IP that hit `/auth/sign-up` once).
 *
 * Instance-wide, not space-scoped — the table has no `space_id` column.
 * Cluster-wide coordination lock keyed `"rate-limit-cleanup"` keeps
 * multi-instance deployments running once per tick.
 */
export class RateLimitWindowCleaner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private storage: Storage,
    private intervalMs: number,
    private nowFn: () => Date = () => new Date(),
    private coordination?: CoordinationStore,
  ) {}

  start(): void {
    this.stopped = false;
    this.startupTimeout = setTimeout(() => void this.poll(), 20_000);
    this.interval = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Test entry point — drops every expired window row. */
  async runOnce(): Promise<number> {
    return this.storage.rateLimits.cleanup(this.nowFn().toISOString());
  }

  /** Scheduler entry point — see TrashPurger.runScheduled. */
  runScheduled(): Promise<void> {
    return this.poll();
  }

  private async poll(): Promise<void> {
    try {
      const deleted = this.coordination
        ? await this.coordination.withJobLock("rate-limit-cleanup", () =>
            this.runOnce(),
          )
        : await this.runOnce();
      if (deleted !== undefined && deleted > 0) {
        log("info", "Rate-limit window cleanup", { deleted });
      }
    } catch (err) {
      logJobTickFailure("Rate-limit window cleanup", err, this.stopped);
    }
  }
}

/**
 * Reaps grantless OAuth Dynamic Client Registration (DCR) clients.
 *
 * Unauthenticated DCR (`allowUnauthenticatedClientRegistration: true`)
 * lets anyone register an `auth_oauth_client` row; without a reaper those
 * rows accumulate forever (DB growth) — most are abandoned registrations a
 * user never consented to. Each tick deletes every client that is BOTH:
 *
 *   - older than the retention window (`created_at < now - retentionDays`),
 *     AND
 *   - grantless — no access token, no refresh token, and no projected
 *     `system.connection { kind: "app" }` item for its `client_id`.
 *
 * Conservative: any single grant signal spares the row, so a client a user
 * actually authorized (or one with any live token) is never reaped. The
 * grant check is space-agnostic — a client with zero grants is dead
 * regardless of which space registered it — so this is an instance-wide
 * sweep (like `AuthSessionCleaner` / `RateLimitWindowCleaner`), not a
 * per-space fan-out. Cluster-wide coordination lock keyed
 * `"dcr-client-cleanup"`.
 *
 * `retentionDays <= 0` disables the job — the operator can leave the
 * deployment running with no DCR reaper by setting the env var to 0.
 */
export class DcrClientCleaner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private storage: Storage,
    private retentionDays: number,
    private intervalMs: number,
    private nowFn: () => Date = () => new Date(),
    private coordination?: CoordinationStore,
  ) {}

  start(): void {
    this.stopped = false;
    this.startupTimeout = setTimeout(() => void this.poll(), 25_000);
    this.interval = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Test entry point — deletes grantless clients older than the window.
   *  No-op when the job is disabled or the oauth-provider store is absent
   *  (test contexts that skip better-auth). */
  async runOnce(): Promise<number> {
    if (this.retentionDays <= 0) return 0;
    const provider = this.storage.oauthProvider;
    if (!provider) return 0;
    const cutoff = new Date(
      this.nowFn().getTime() - this.retentionDays * MS_PER_DAY,
    ).toISOString();
    return provider.deleteGrantlessClientsOlderThan(cutoff);
  }

  /** Scheduler entry point — see TrashPurger.runScheduled. */
  runScheduled(): Promise<void> {
    return this.poll();
  }

  private async poll(): Promise<void> {
    try {
      const deleted = this.coordination
        ? await this.coordination.withJobLock("dcr-client-cleanup", () =>
            this.runOnce(),
          )
        : await this.runOnce();
      if (deleted !== undefined && deleted > 0) {
        log("info", "DCR client cleanup", {
          deleted,
          retentionDays: this.retentionDays,
        });
      }
    } catch (err) {
      logJobTickFailure("DCR client cleanup", err, this.stopped);
    }
  }
}

/**
 * Retires runtime credentials. The runtime substrates mint one short-TTL
 * credential per dispatch; the mint path revokes superseded siblings and
 * the bearer gate refuses expired rows, but neither touches credentials
 * for connections that stop dispatching, nor rows minted before expiry
 * stamping existed. This sweep is the backstop that keeps `api_keys`
 * bounded. Three passes per tick:
 *
 *   1. Revoke runtime credentials past their `expires_at` — the bearer
 *      gate already refuses them, this makes the state visible and
 *      starts the hard-delete clock.
 *   2. Revoke legacy runtime credentials with no `expires_at` whose
 *      `created_at` is older than the default TTL + one-TTL grace. Rows
 *      minted before expiry stamping never age out on their own; any of
 *      them older than the grace window is long dead operationally.
 *   3. Hard-delete revoked runtime-credential rows whose `revoked_at` is
 *      older than seven days. Per-dispatch machine artifacts, not human
 *      credentials — a week of post-revocation visibility is plenty.
 *
 * Instance-wide, not space-scoped — expiry is a property of the row, not
 * of space policy. Cluster-wide coordination lock keyed
 * `"runtime-credential-reap"`. Disabled by wiring (interval `0` skips
 * construction in `index.ts`), matching the other cleaners.
 */
/**
 * Hard-deletes revoked ordinary API keys once their revocation is old
 * enough to stop being interesting.
 *
 * A sibling of `RuntimeCredentialReaper` rather than a fourth pass inside
 * it, and the reason is in that class's own docblock: its seven-day
 * window is reasoned as "per-dispatch machine artifacts, not human
 * credentials". An ordinary key is minted by a person or a test suite,
 * so how long its revocation stays visible is a different judgment, and
 * folding the two together would leave that class's name describing half
 * of what it does.
 *
 * Nothing swept these at all before. Staging reached 3,044 revoked
 * ordinary keys older than a week, against six on production — the
 * difference being that staging is where every suite and probe mints one.
 *
 * Instance-wide, not space-scoped: revocation age is a property of the
 * row, not of space policy. Matches the runtime reaper on that point.
 */
export class RevokedKeyReaper {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  /** Post-revocation retention before hard delete. Longer than the
   *  runtime reaper's seven days because a revoked human credential is
   *  worth more to an operator reading back than a machine artifact is,
   *  and there are orders of magnitude fewer of them. */
  static readonly REVOKED_RETENTION_MS = 30 * MS_PER_DAY;

  constructor(
    private storage: Storage,
    private intervalMs: number,
    private nowFn: () => Date = () => new Date(),
    private coordination?: CoordinationStore,
  ) {}

  start(): void {
    this.stopped = false;
    this.startupTimeout = setTimeout(() => void this.poll(), 45_000);
    this.interval = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Test entry point — one sweep, reporting the count. */
  async runOnce(): Promise<number> {
    const cutoff = new Date(
      this.nowFn().getTime() - RevokedKeyReaper.REVOKED_RETENTION_MS,
    ).toISOString();
    return this.storage.keys.deleteRevokedKeysOlderThan(cutoff);
  }

  /** Scheduler entry point — see TrashPurger.runScheduled. */
  runScheduled(): Promise<void> {
    return this.poll();
  }

  private async poll(): Promise<void> {
    try {
      const deleted = this.coordination
        ? await this.coordination.withJobLock("revoked-key-reap", () =>
            this.runOnce(),
          )
        : await this.runOnce();
      if (deleted !== undefined && deleted > 0) {
        log("info", "Revoked key reap", { deleted });
      }
    } catch (err) {
      logJobTickFailure("Revoked key reap", err, this.stopped);
    }
  }
}

export class RuntimeCredentialReaper {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  /** Post-revocation retention before hard delete. Fixed rather than
   *  env-tunable: the window exists for operator inspection, not policy. */
  static readonly REVOKED_RETENTION_MS = 7 * MS_PER_DAY;

  constructor(
    private storage: Storage,
    /** Default runtime-credential TTL — drives the legacy (NULL
     *  `expires_at`) cutoff of TTL + one-TTL grace. */
    private defaultTtlMs: number,
    private intervalMs: number,
    private nowFn: () => Date = () => new Date(),
    private coordination?: CoordinationStore,
  ) {}

  start(): void {
    this.stopped = false;
    this.startupTimeout = setTimeout(() => void this.poll(), 30_000);
    this.interval = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Test entry point — runs the three passes once and reports counts. */
  async runOnce(): Promise<{
    expired: number;
    legacy: number;
    deleted: number;
  }> {
    const now = this.nowFn();
    const nowIso = now.toISOString();
    const legacyCutoff = new Date(
      now.getTime() - 2 * this.defaultTtlMs,
    ).toISOString();
    const deleteCutoff = new Date(
      now.getTime() - RuntimeCredentialReaper.REVOKED_RETENTION_MS,
    ).toISOString();
    const expired =
      await this.storage.keys.revokeExpiredRuntimeCredentials(nowIso);
    const legacy =
      await this.storage.keys.revokeRuntimeCredentialsWithoutExpiryOlderThan(
        legacyCutoff,
        nowIso,
      );
    const deleted =
      await this.storage.keys.deleteRevokedRuntimeCredentialsOlderThan(
        deleteCutoff,
      );
    return { expired, legacy, deleted };
  }

  /** Test entry point for the scheduled path — the lock handshake and the
   *  error swallowing only exist here, not in `runOnce`. */
  async pollForTest(): Promise<void> {
    return this.poll();
  }

  /** Scheduler entry point — see TrashPurger.runScheduled. */
  runScheduled(): Promise<void> {
    return this.poll();
  }

  /** Test seam: whether `start()` has live timers pending. */
  scheduledForTest(): boolean {
    return this.interval !== null || this.startupTimeout !== null;
  }

  private async poll(): Promise<void> {
    try {
      const counts = this.coordination
        ? await this.coordination.withJobLock("runtime-credential-reap", () =>
            this.runOnce(),
          )
        : await this.runOnce();
      if (
        counts !== undefined &&
        counts.expired + counts.legacy + counts.deleted > 0
      ) {
        log("info", "Runtime credential reap", counts);
      }
    } catch (err) {
      logJobTickFailure("Runtime credential reap", err, this.stopped);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-space fan-out helper
// ---------------------------------------------------------------------------

/**
 * Shared fan-out runner. Used by `TrashPurger` for the unit-of-days delete
 * job (and exposed via {@link runSpaceCleanup} for the audit + event-log
 * jobs which live inline in `index.ts`).
 *
 * For each space + the NULL-space bucket, resolves an effective retention
 * (per-space override OR `instanceDefault`) and runs a space-scoped sweep
 * with `cutoff = now - retention * unitMs`. A value of `0` for the effective
 * retention is the documented "disable for this scope" sentinel and skips
 * the sweep without an error.
 *
 * Each per-space invocation grabs `coordination.withJobLock` on a
 * space-specific key (`<jobName>:<space-id-or-_no_space>`) so two server
 * instances racing the same tick don't double-process a space.
 */
async function runSpaceFanout(opts: {
  jobName: string;
  coordination: CoordinationStore | undefined;
  fanout: SpaceFanout;
  nowFn: () => Date;
  instanceDefault: number;
  unitMs: number;
  sweep: (cutoff: string, spaceId: string | null) => Promise<number>;
}): Promise<number> {
  const spaces = await opts.fanout.spaces.list();
  let total = 0;
  for (const space of spaces) {
    const config = await opts.fanout.spaces.getConfig(space.id);
    const override = config?.[opts.fanout.configField];
    const effective =
      typeof override === "number" ? override : opts.instanceDefault;
    if (effective <= 0) continue;
    const cutoff = new Date(
      opts.nowFn().getTime() - effective * opts.unitMs,
    ).toISOString();
    const deleted = await runOneScope(
      opts.coordination,
      `${opts.jobName}:${space.id}`,
      () => opts.sweep(cutoff, space.id),
    );
    if (deleted) total += deleted;
  }
  // NULL-space scope — single-space self-host items + any rows with
  // no space scope. Always uses the instance default, which is the
  // retention self-hosts get when they never configure per-space
  // overrides.
  if (opts.instanceDefault > 0) {
    const cutoff = new Date(
      opts.nowFn().getTime() - opts.instanceDefault * opts.unitMs,
    ).toISOString();
    const deleted = await runOneScope(
      opts.coordination,
      `${opts.jobName}:_no_space`,
      () => opts.sweep(cutoff, null),
    );
    if (deleted) total += deleted;
  }
  return total;
}

async function runOneScope(
  coordination: CoordinationStore | undefined,
  lockKey: string,
  sweep: () => Promise<number>,
): Promise<number | undefined> {
  if (!coordination) return sweep();
  return coordination.withJobLock(lockKey, sweep);
}

/**
 * Fan-out runner for the audit + event-log cleanup jobs that live inline in
 * `index.ts`. Same shape as the in-class fan-out above but exposed for
 * callsites that don't have their own Purger class. Returns the total number
 * of rows deleted across every scope swept this tick.
 *
 * `unitMs` is `MS_PER_DAY` for the audit job (retention is in days) and
 * `3_600_000` for the event-log job (retention is in hours); passed in by
 * the caller so the helper stays unit-agnostic.
 */
export async function runSpaceCleanup(opts: {
  jobName: string;
  coordination: CoordinationStore | undefined;
  fanout: SpaceFanout | undefined;
  instanceDefault: number;
  unitMs: number;
  /** Cleanup sweep — `spaceId === null` means "rows where space_id IS NULL". */
  sweep: (retention: number, spaceId?: string | null) => Promise<number>;
}): Promise<number> {
  if (!opts.fanout) {
    if (opts.instanceDefault <= 0) return 0;
    const fn = (): Promise<number> => opts.sweep(opts.instanceDefault);
    if (!opts.coordination) return fn();
    return (await opts.coordination.withJobLock(opts.jobName, fn)) ?? 0;
  }
  const spaces = await opts.fanout.spaces.list();
  let total = 0;
  for (const space of spaces) {
    const config = await opts.fanout.spaces.getConfig(space.id);
    const override = config?.[opts.fanout.configField];
    const effective =
      typeof override === "number" ? override : opts.instanceDefault;
    if (effective <= 0) continue;
    const deleted = await runOneScope(
      opts.coordination,
      `${opts.jobName}:${space.id}`,
      () => opts.sweep(effective, space.id),
    );
    if (deleted) total += deleted;
  }
  if (opts.instanceDefault > 0) {
    const deleted = await runOneScope(
      opts.coordination,
      `${opts.jobName}:_no_space`,
      () => opts.sweep(opts.instanceDefault, null),
    );
    if (deleted) total += deleted;
  }
  return total;
}
