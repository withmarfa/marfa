import type {
  AuthSessionStore,
  ItemStore,
  SettingsStore,
  Storage,
} from "./interface.js";
import type { InstanceConfig } from "@withmarfa/shared";
import { runAuditedTransaction } from "./audited-transaction.js";
import { itemWrites } from "./item-writes.js";
import { readInstanceConfig } from "./instance-config.js";
import { log } from "../middleware/logger.js";
import { isConnectionLostError } from "./job-tick.js";
import { revokeProjectedGrant } from "../auth/grant-lifecycle.js";

/**
 * The retention sweeps. Each is a class with one `runOnce()` that does a
 * sweep and answers a count; the housekeeping scheduler owns the cadence,
 * records the outcome and classifies a failure, so nothing here keeps a
 * timer or logs a run. A sweep that found something to do says so at
 * `info`; one that found nothing is silent.
 */

const MS_PER_DAY = 86_400_000;

/**
 * Optional instance-config wiring shared by the retention housekeeping
 * jobs. When provided, a run resolves the effective retention from the
 * instance configuration (`InstanceConfig`'s override field, falling back
 * to the instance default) and runs one sweep with it.
 */
export interface RetentionOverride {
  settings: SettingsStore;
  /**
   * Field on `InstanceConfig` that holds the retention override. The run
   * reads `config[configField]` and treats `0` as "disabled" (matches
   * env-default semantics for `TRASH_RETENTION_DAYS=0`).
   */
  configField: keyof Pick<
    InstanceConfig,
    | "trash_retention_days"
    | "audit_retention_days"
    | "event_log_retention_hours"
  >;
}

/**
 * Hard-deletes trashed items that entered the bin longer ago than the
 * configured retention window. Idempotent.
 *
 * If `retentionDays <= 0`, the housekeeping job is a no-op: the operator
 * can leave the deployment running with no trash purge by setting the env
 * var to 0. The default at the config layer is 60.
 *
 * When `override` is supplied, a `runOnce()` honors the
 * `trash_retention_days` override from the instance configuration. When
 * `override` is omitted the housekeeping job sweeps at the instance default.
 *
 * **This sweep announces nothing, and neither does `RevokedGrantPurger`.**
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
  constructor(
    private storage: Storage,
    private retentionDays: number,
    private nowFn: () => Date = () => new Date(),
    private configOverride?: RetentionOverride,
  ) {}

  /**
   * One sweep. Computes the cutoff date from the injected clock and deletes
   * at most 200 trashed rows strictly older than it, with one audit.
   *
   * Returns the number of rows deleted, at the configured override when
   * one is wired and at the instance default otherwise.
   */
  async runOnce(): Promise<number> {
    const deleted = this.configOverride
      ? await runSweepToCutoff({
          override: this.configOverride,
          nowFn: this.nowFn,
          instanceDefault: this.retentionDays,
          unitMs: MS_PER_DAY,
          sweep: (cutoff) => this.purge(cutoff),
        })
      : await this.runOnceGlobal();
    if (deleted > 0) {
      log("info", "Trash purge", {
        deleted,
        retentionDays: this.retentionDays,
      });
    }
    return deleted;
  }

  private purge(cutoff: string): Promise<number> {
    return runAuditedTransaction(
      this.storage,
      () => itemWrites(this.storage).purgeTrashedOlderThan(cutoff, 200),
      (deleted) =>
        deleted > 0
          ? {
              action: "items.trash_purged",
              resource_type: "item",
              client_ip: null,
              details: { deleted, before: cutoff },
            }
          : null,
    );
  }

  private async runOnceGlobal(): Promise<number> {
    if (this.retentionDays <= 0) return 0;
    const cutoff = new Date(
      this.nowFn().getTime() - this.retentionDays * MS_PER_DAY,
    ).toISOString();
    return this.purge(cutoff);
  }
}

/**
 * Hard-deletes revoked application-grant rows once they are older than the
 * configured window.
 *
 * **The row it sweeps is not trash and is not in a terminal lifecycle state.**
 * A grant revoked through the user-facing path keeps `state: "active"` — the
 * revoke writes `status: "revoked"` and `revoked_at` onto the properties and
 * leaves the item alone, so the record survives as a record. The trash purge
 * above cannot reach it, because it asks about `state`.
 *
 * **Why they accumulate at all.** The grant lookup skips a row whose status is
 * revoked, so an operator soft-delete is permanent rather than reusable, and
 * each revoke-then-reconnect cycle leaves one behind.
 *
 * **The window is the audit window and that is deliberate.** A revoked grant
 * row and the audit row that recorded the revocation are the same fact written twice,
 * so keeping them for different lengths of time would let the two disagree
 * about whether a revocation is still visible. Ninety days, matching
 * `AUDIT_RETENTION_DAYS`, and `0` switches the housekeeping job off as it
 * does for the others.
 *
 * The store predicate asks `kind = 'app'`: an application grant, not any
 * revoked connection.
 */
export class RevokedGrantPurger {
  constructor(
    private items: Pick<ItemStore, "purgeRevokedAppGrantsOlderThan">,
    private retentionDays: number,
    private nowFn: () => Date = () => new Date(),
  ) {}

  async runOnce(): Promise<number> {
    if (this.retentionDays <= 0) return 0;
    const cutoff = new Date(
      this.nowFn().getTime() - this.retentionDays * MS_PER_DAY,
    ).toISOString();
    const deleted = await this.items.purgeRevokedAppGrantsOlderThan(cutoff);
    if (deleted > 0) {
      log("info", "Revoked grant rows purged", { deleted });
    }
    return deleted;
  }
}

/**
 * Retires app grants nobody has used for a long time.
 *
 * A grant lasts for as long as nobody revokes it: the tokens under it
 * rotate forever, the consent row and the projection stand, and the app
 * keeps its access to data it has stopped reading. The rule for keys is
 * the rule here: standing authority nobody is tracking needs an owner in
 * code.
 *
 * Every live app grant whose `last_used_at`, or `granted_at` where it was
 * never used, is older than the window goes through the same cascade the
 * person's own Disconnect runs, and an `auth.grant.retired` row says why
 * and when it was last used. The window is long by design (365 days by
 * default, `MARFA_GRANT_INACTIVITY_DAYS`, `0` disables): a person's
 * once-a-year app should still be connected in the spring.
 *
 * **What follows from a retirement is a chain already in place.** The
 * cascade leaves a revoked grant row, `status: "revoked"`; `RevokedGrantPurger`
 * removes that after its own window; and a client with no grant left then
 * falls to `DcrClientCleaner`. Nothing here reaches into either.
 *
 * The window is a property of the deployment rather than of anything a
 * caller configures per credential.
 */
/** Grants retired by one run; the remainder wait for the next. */
const RETIRE_PER_RUN = 500;

export class GrantInactivityRetirer {
  constructor(
    private storage: Storage,
    private inactivityDays: number,
    private nowFn: () => Date = () => new Date(),
  ) {}

  /** One sweep: retires every grant inactive past the window and returns
   *  how many. */
  async runOnce(): Promise<number> {
    if (this.inactivityDays <= 0) return 0;
    const cutoff = new Date(
      this.nowFn().getTime() - this.inactivityDays * MS_PER_DAY,
    ).toISOString();
    const inactive = await this.storage.items.listInactiveAppGrants(cutoff);
    let retired = 0;
    // The first run on a mature instance meets every dormant grant at once;
    // the cap keeps one run's cascade, and the lock it holds, bounded, and
    // the rest go tomorrow. One grant that cannot be revoked is logged and
    // passed over rather than costing every grant behind it: the cascade
    // aborts on a fault by design, and a persistent fault on one row would
    // otherwise stall the sweep at that row every day.
    for (const grant of inactive.slice(0, RETIRE_PER_RUN)) {
      try {
        await revokeProjectedGrant(this.storage, {
          itemId: grant.id,
          properties: grant.properties,
          clientId: grant.clientId ?? undefined,
          authUserId: grant.authUserId ?? undefined,
        });
      } catch (err) {
        // A lost client ends the sweep, not one grant: the scheduler
        // classifies it. Anything else is this grant's own fault.
        if (isConnectionLostError(err)) throw err;
        log("error", "Inactive grant retirement error", {
          grant_item_id: grant.id,
          error: err instanceof Error ? err.message : String(err),
        });
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
    if (retired > 0) {
      log("info", "Inactive grants retired", {
        retired,
        inactivityDays: this.inactivityDays,
      });
    }
    return retired;
  }
}

/**
 * Drops expired better-auth `auth_session` rows. Better Auth itself owns
 * the session TTL via `expiresAt`; this sweep exists only so the table
 * doesn't grow unbounded between natural expiries (browser-side ephemeral
 * cookies vanish on tab close, but the server-side row stays around until
 * the sweep catches up).
 *
 * Instance-wide: the deletion criterion is purely time-based.
 */
export class AuthSessionCleaner {
  constructor(
    private store: AuthSessionStore,
    private nowFn: () => Date = () => new Date(),
  ) {}

  /** One sweep — drops every row whose `expires_at` is strictly before
   *  the injected clock. */
  async runOnce(): Promise<number> {
    const deleted = await this.store.deleteExpired(this.nowFn());
    if (deleted > 0) {
      log("info", "Auth session cleanup", { deleted });
    }
    return deleted;
  }
}

/**
 * Drops expired `rate_limit_windows` rows. Expired rows aren't a
 * correctness risk (the upsert path overwrites them transparently); the GC
 * just keeps the table from growing unboundedly across the long tail of
 * one-shot windows (such as a single IP that asked `GET /` once).
 *
 * Instance-wide.
 */
export class RateLimitWindowCleaner {
  constructor(
    private storage: Storage,
    private nowFn: () => Date = () => new Date(),
  ) {}

  /** One sweep — drops every expired window row. */
  async runOnce(): Promise<number> {
    const deleted = await this.storage.rateLimits.cleanup(
      this.nowFn().toISOString(),
    );
    if (deleted > 0) {
      log("info", "Rate-limit window cleanup", { deleted });
    }
    return deleted;
  }
}

/**
 * Reaps grantless OAuth Dynamic Client Registration (DCR) clients.
 *
 * Unauthenticated DCR (`allowUnauthenticatedClientRegistration: true`)
 * lets anyone register an `auth_oauth_client` row; without a reaper those
 * rows accumulate forever (DB growth) — most are abandoned registrations a
 * user never consented to. Each run deletes every client that is BOTH:
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
 * `retentionDays <= 0` switches the housekeeping job off: the operator can
 * leave the deployment running with no DCR reaper by setting the env var to 0.
 */
export class DcrClientCleaner {
  constructor(
    private storage: Storage,
    private retentionDays: number,
    private nowFn: () => Date = () => new Date(),
  ) {}

  /** One sweep — deletes grantless clients older than the window. No-op
   *  when the window is off or the oauth-provider store is absent (test
   *  contexts that skip better-auth). */
  async runOnce(): Promise<number> {
    if (this.retentionDays <= 0) return 0;
    const provider = this.storage.oauthProvider;
    if (!provider) return 0;
    const cutoff = new Date(
      this.nowFn().getTime() - this.retentionDays * MS_PER_DAY,
    ).toISOString();
    const deleted = await provider.deleteGrantlessClientsOlderThan(cutoff);
    if (deleted > 0) {
      log("info", "DCR client cleanup", {
        deleted,
        retentionDays: this.retentionDays,
      });
    }
    return deleted;
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
  /** Post-revocation retention before hard delete. Generous because a
   *  revoked human credential is worth reading back, and there are few
   *  enough of them that keeping a month of them costs nothing. */
  static readonly REVOKED_RETENTION_MS = 30 * MS_PER_DAY;

  constructor(
    private storage: Storage,
    private nowFn: () => Date = () => new Date(),
  ) {}

  /** One sweep, reporting the count. */
  async runOnce(): Promise<number> {
    const cutoff = new Date(
      this.nowFn().getTime() - RevokedKeyReaper.REVOKED_RETENTION_MS,
    ).toISOString();
    const deleted = await this.storage.keys.deleteRevokedKeysOlderThan(cutoff);
    if (deleted > 0) {
      log("info", "Revoked key reap", { deleted });
    }
    return deleted;
  }
}

// ---------------------------------------------------------------------------
// Retention-override helpers
// ---------------------------------------------------------------------------

/** The retention a housekeeping job runs at: the instance configuration's
 *  override for its field when one is set, the instance default otherwise. */
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
 * Cleanup runner for the audit and event-log housekeeping jobs, which
 * `housekeeping/registrations.ts` registers as closures rather than as a
 * purger class of their own. Returns the number of rows deleted this run.
 *
 * The retention reaches `sweep` in whatever unit the housekeeping job keeps
 * it in, days for the audit log and hours for the event log, because
 * nothing here converts it and the store on the other side takes the same
 * unit it was configured with.
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
