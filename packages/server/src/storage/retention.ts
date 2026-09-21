import type {
  AuthSessionStore,
  ItemStore,
  SettingsStore,
  Storage,
} from "./interface.js";
import type { InstanceConfig } from "@withmarfa/shared";
import { readInstanceConfig } from "./instance-config.js";
import type { BlobLayer } from "./blob-layer.js";
import { log } from "../middleware/logger.js";
import { logJobTickFailure } from "./job-tick.js";
import { sweepUnreferencedBlobs } from "./blob-orphans.js";
import { revokeProjectedGrant } from "../auth/grant-lifecycle.js";

const MS_PER_DAY = 86_400_000;

/**
 * Optional instance-config wiring shared by the retention jobs. When
 * provided, a tick resolves the effective retention from the instance
 * configuration (`InstanceConfig`'s override field, falling back to the
 * instance default) and runs one sweep with it.
 */
export interface RetentionOverride {
  settings: SettingsStore;
  /**
   * Field on `InstanceConfig` that holds the retention override. The tick
   * reads `config[configField]` and treats `0` as "disabled" (matches
   * env-default semantics for `TRASH_RETENTION_DAYS=0`).
   */
  configField: keyof Pick<
    InstanceConfig,
    | "trash_retention_days"
    | "audit_retention_days"
    | "event_log_retention_hours"
    | "activity_retention_days"
  >;
}

/**
 * Hard-deletes trashed items that entered the bin longer ago than the
 * configured retention window. Pattern mirrors `VersionThinner`:
 * in-process timer, synchronous `runOnce()` entry point for tests,
 * idempotent sweep.
 *
 * If `retentionDays <= 0`, the job is a no-op — the operator can leave
 * the deployment running with no trash purge by setting the env var to 0.
 * The default at the config layer is 60.
 *
 * When `override` is supplied, a `runOnce()` tick honors the
 * `trash_retention_days` override from the instance configuration. When
 * `override` is omitted the job sweeps at the instance default.
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
    private configOverride?: RetentionOverride,
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
   * Returns the number of rows deleted, at the configured override when
   * one is wired and at the instance default otherwise.
   */
  async runOnce(): Promise<number> {
    return this.configOverride
      ? runSweepToCutoff({
          override: this.configOverride,
          nowFn: this.nowFn,
          instanceDefault: this.retentionDays,
          unitMs: MS_PER_DAY,
          sweep: (cutoff) => this.items.purgeTrashedOlderThan(cutoff),
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
      const deleted = await this.runOnce();
      if (deleted > 0) {
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
 * Ages out `system.activity` items, the one item type written per run
 * rather than per record, and so the one that grows without a bound of its
 * own. Same shape as `TrashPurger` above: honors the
 * `activity_retention_days` override when the instance configuration is
 * wired, and sweeps at the instance default otherwise.
 *
 * This job bounds the rows; it does not decide whether a run deserves one.
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
 * **A connector's revoked connection is not a tombstone and is not swept.**
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
      const deleted = await this.runOnce();
      if (deleted > 0) {
        log("info", "Revoked grant tombstones purged", { deleted });
      }
    } catch (err) {
      logJobTickFailure("Revoked grant purge", err, this.stopped);
    }
  }
}

/**
 * Retires app grants nobody has used for a long time.
 *
 * A grant lasted for as long as nobody revoked it: the tokens under it
 * rotated forever, the consent row and the projection stood, and the app
 * kept its access to data it had stopped reading. Three keys holding
 * everything accumulated on production from finished sessions the same way,
 * and the rule for keys is the rule here: standing authority nobody is
 * tracking needs an owner in code.
 *
 * Every live app grant whose `last_used_at`, or `granted_at` where it was
 * never used, is older than the window goes through the same cascade the
 * person's own Disconnect runs, and an `auth.grant.retired` row says why
 * and when it was last used. The window is long by design (365 days by
 * default, `MARFA_GRANT_INACTIVITY_DAYS`, `0` disables): a person's
 * once-a-year app should still be connected in the spring.
 *
 * **What follows from a retirement is a chain already in place.** The
 * cascade leaves a tombstone with `status: "revoked"`; `RevokedGrantPurger`
 * removes that after its own window; and a client with no grant left then
 * falls to `DcrClientCleaner`. Nothing here reaches into either.
 *
 * The window is a property of the deployment rather than of anything a
 * caller configures per credential.
 */
/** Grants retired by one tick; the remainder wait for the next. */
const RETIRE_PER_TICK = 500;

export class GrantInactivityRetirer {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private storage: Storage,
    private inactivityDays: number,
    private intervalMs: number,
    private nowFn: () => Date = () => new Date(),
  ) {}

  start(): void {
    this.stopped = false;
    this.startupTimeout = setTimeout(() => void this.poll(), 40_000);
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

  /** Test entry point: retires every grant inactive past the window and
   *  returns how many. */
  async runOnce(): Promise<number> {
    if (this.inactivityDays <= 0) return 0;
    const cutoff = new Date(
      this.nowFn().getTime() - this.inactivityDays * MS_PER_DAY,
    ).toISOString();
    const inactive = await this.storage.items.listInactiveAppGrants(cutoff);
    let retired = 0;
    // The first tick on a mature instance meets every dormant grant at once;
    // the cap keeps one tick's cascade, and the lock it holds, bounded, and
    // the rest go tomorrow. One grant that cannot be revoked is logged and
    // passed over rather than costing every grant behind it: the cascade
    // aborts on a fault by design, and a persistent fault on one row would
    // otherwise stall the sweep at that row every day.
    for (const grant of inactive.slice(0, RETIRE_PER_TICK)) {
      try {
        await revokeProjectedGrant(this.storage, {
          itemId: grant.id,
          properties: grant.properties,
          clientId: grant.clientId ?? undefined,
          authUserId: grant.authUserId ?? undefined,
        });
      } catch (err) {
        // Through the one classifier every job's failure takes, so a tick
        // cut short by shutdown stands down at info here as everywhere.
        logJobTickFailure(
          `Inactive grant retirement (grant ${grant.id})`,
          err,
          this.stopped,
        );
        continue;
      }
      // Fire-and-forget like every other revoke door's row: the tracker
      // drains it at close, and a retirement that cannot be audited is still
      // a retirement the projection's own `revoked_at` records. This row is
      // the only record of why, so it is written first of the two.
      void this.storage.audit.log({
        action: "auth.grant.retired",
        resource_type: "oauth_grant",
        resource_id: grant.clientId ?? grant.id,
        client_ip: null,
        details: {
          client_id: grant.clientId,
          user_id: grant.authUserId,
          grant_item_id: grant.id,
          reason: "inactive",
          last_used_at: grant.lastUsedAt,
          granted_at: grant.grantedAt,
          inactivity_days: this.inactivityDays,
        },
      });
      retired += 1;
    }
    return retired;
  }

  /** Scheduler entry point: the same locked, logged tick the timer drives. */
  runScheduled(): Promise<void> {
    return this.poll();
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    try {
      const retired = await this.runOnce();
      if (retired > 0) {
        log("info", "Inactive grants retired", {
          retired,
          inactivityDays: this.inactivityDays,
        });
      }
    } catch (err) {
      logJobTickFailure("Inactive grant retirement", err, this.stopped);
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
    private configOverride?: RetentionOverride,
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
    return this.configOverride
      ? runSweepToCutoff({
          override: this.configOverride,
          nowFn: this.nowFn,
          instanceDefault: this.retentionDays,
          unitMs: MS_PER_DAY,
          sweep: (cutoff) => this.items.purgeActivityOlderThan(cutoff),
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
      const deleted = await this.runOnce();
      if (deleted > 0) {
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
 * Instance-wide: the deletion criterion is purely time-based.
 */
export class AuthSessionCleaner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private store: AuthSessionStore,
    private intervalMs: number,
    private nowFn: () => Date = () => new Date(),
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
      const deleted = await this.runOnce();
      if (deleted > 0) {
        log("info", "Auth session cleanup", { deleted });
      }
    } catch (err) {
      logJobTickFailure("Auth session cleanup", err, this.stopped);
    }
  }
}

/**
 * Drops expired `rate_limit_windows` rows on a periodic tick. Expired rows
 * aren't a correctness risk (the upsert path overwrites them transparently);
 * the GC just keeps the table from growing unboundedly across the long tail
 * of one-shot windows (e.g. a single IP that hit `/auth/sign-up` once).
 *
 * Instance-wide.
 */
export class RateLimitWindowCleaner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private storage: Storage,
    private intervalMs: number,
    private nowFn: () => Date = () => new Date(),
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
      const deleted = await this.runOnce();
      if (deleted > 0) {
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
 * grant check asks only whether a client has any grant left, so this is an
 * instance-wide sweep like `AuthSessionCleaner` and
 * `RateLimitWindowCleaner`, with no configurable override.
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
      const deleted = await this.runOnce();
      if (deleted > 0) {
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
 * Reclaims blobs nothing references.
 *
 * `POST /blobs` and `POST /items` are separate calls, and the bytes are
 * stored by the first one. An item write refused for any reason leaves the
 * blob registered with nothing pointing at it, and nothing else reconciles
 * the two.
 *
 * The grace window is what makes running it unattended safe. Unreferenced
 * is also the ordinary state of a blob between its upload and the item
 * write that names it, so the sweep considers only hashes registered
 * longer than `graceMs` ago and lets the rest wait for the next tick.
 *
 * Instance-wide, like the other sweeps with no configurable override: a
 * hash is deleted from every store once, so the question "does anything
 * reference this" has to be asked of every item at once.
 *
 * `graceMs <= 0` disables the job. A zero window would sweep a blob the
 * instant it is unreferenced, which is the defect rather than a
 * configuration of it, so the value doubles as the operator's off switch.
 */
export class BlobOrphanCleaner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private storage: Storage,
    private blobs: BlobLayer,
    private graceMs: number,
    private intervalMs: number,
    private nowFn: () => Date = () => new Date(),
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

  /** Test entry point. Returns the number of blobs removed this tick. */
  async runOnce(): Promise<number> {
    if (this.graceMs <= 0) return 0;
    const result = await sweepUnreferencedBlobs({
      storage: this.storage,
      blobs: this.blobs,
      dryRun: false,
      registeredBefore: new Date(
        this.nowFn().getTime() - this.graceMs,
      ).toISOString(),
    });
    return result.removed;
  }

  /** Scheduler entry point — see TrashPurger.runScheduled. */
  runScheduled(): Promise<void> {
    return this.poll();
  }

  private async poll(): Promise<void> {
    try {
      const removed = await this.runOnce();
      if (removed > 0) {
        log("info", "Blob cleanup", { removed, graceMs: this.graceMs });
      }
    } catch (err) {
      logJobTickFailure("Blob cleanup", err, this.stopped);
    }
  }
}

/**
 * Hard-deletes revoked ordinary API keys once their revocation is old
 * enough to stop being interesting. An instance a test suite mints against
 * revokes thousands of them a week, and nothing else bounds the table.
 *
 * Instance-wide and not configurable: revocation age is a property of the
 * row.
 */
export class RevokedKeyReaper {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  /** Post-revocation retention before hard delete. Generous because a
   *  revoked human credential is worth reading back, and there are few
   *  enough of them that keeping a month of them costs nothing. */
  static readonly REVOKED_RETENTION_MS = 30 * MS_PER_DAY;

  constructor(
    private storage: Storage,
    private intervalMs: number,
    private nowFn: () => Date = () => new Date(),
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
      const deleted = await this.runOnce();
      if (deleted > 0) {
        log("info", "Revoked key reap", { deleted });
      }
    } catch (err) {
      logJobTickFailure("Revoked key reap", err, this.stopped);
    }
  }
}

// ---------------------------------------------------------------------------
// Retention-override helpers
// ---------------------------------------------------------------------------

/** The retention a job runs at: the instance configuration's override for
 *  the job's field when one is set, the instance default otherwise. */
async function effectiveRetention(
  override: RetentionOverride,
  instanceDefault: number,
): Promise<number> {
  const config = await readInstanceConfig(override.settings);
  const configured = config?.[override.configField];
  return typeof configured === "number" ? configured : instanceDefault;
}

/** One sweep at the effective retention. */
async function runSweepToCutoff(opts: {
  override: RetentionOverride;
  nowFn: () => Date;
  instanceDefault: number;
  unitMs: number;
  sweep: (cutoff: string) => Promise<number>;
}): Promise<number> {
  const effective = await effectiveRetention(
    opts.override,
    opts.instanceDefault,
  );
  if (effective <= 0) return 0;
  const cutoff = new Date(
    opts.nowFn().getTime() - effective * opts.unitMs,
  ).toISOString();
  return opts.sweep(cutoff);
}

/**
 * Cleanup runner for the audit + event-log jobs that live inline in
 * `index.ts`. Same shape as the in-class runner above but exposed for
 * callsites that don't have their own Purger class. Returns the number of
 * rows deleted this tick.
 *
 * The retention reaches `sweep` in whatever unit the job keeps it in — days
 * for the audit job, hours for the event log — because nothing here converts
 * it and the store on the other side takes the same unit it was configured
 * with.
 */
export async function runSweepAtRetention(opts: {
  override: RetentionOverride | undefined;
  instanceDefault: number;
  sweep: (retention: number) => Promise<number>;
}): Promise<number> {
  const effective = opts.override
    ? await effectiveRetention(opts.override, opts.instanceDefault)
    : opts.instanceDefault;
  if (effective <= 0) return 0;
  return opts.sweep(effective);
}
