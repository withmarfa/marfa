import type {
  CoordinationStore,
  ItemStore,
  TenantStore,
} from "./interface.js";
import type { TenantConfig } from "@mymehq/shared";
import { log } from "../middleware/logger.js";

const MS_PER_DAY = 86_400_000;

/**
 * T-050: optional per-tenant fan-out wiring shared by both retention
 * jobs. When provided, the job:
 *   1. Lists every tenant via `tenants.list()`.
 *   2. For each tenant, resolves the effective retention (the tenant's
 *      `TenantConfig` override field, falling back to the instance
 *      default).
 *   3. Runs a tenant-scoped sweep with that effective retention.
 *   4. Also runs the NULL-tenant sweep at the instance default — this
 *      catches single-tenant self-host items and any unscoped legacy
 *      rows.
 *   5. Sums the deleted counts.
 *
 * Each per-tenant + the NULL sweep are gated by a per-tenant
 * coordination lock (`<jobName>:<tenant-id-or-null>`) so multi-instance
 * deployments still run each sweep once cluster-wide per tick.
 */
export interface TenantFanout {
  tenants: TenantStore;
  /**
   * Field on `TenantConfig` that holds the per-tenant retention
   * override. The fan-out reads `config[configField]` and treats `0`
   * as "disable for this tenant" (matches env-default semantics for
   * `TRASH_RETENTION_DAYS=0`).
   */
  configField: keyof Pick<
    TenantConfig,
    | "trash_retention_days"
    | "feed_retention_days"
    | "audit_retention_days"
    | "event_log_retention_hours"
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
 * T-050: when `fanout` is supplied, a single `runOnce()` tick fans out
 * across every tenant + a NULL-bucket sweep, honouring per-tenant
 * `trash_retention_days` overrides from `TenantConfig`. When `fanout`
 * is omitted the job behaves exactly as before — a single unscoped
 * sweep using the instance default. Single-tenant self-hosts that
 * never wire `tenants` keep the old behaviour for free.
 */
export class TrashPurger {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private items: ItemStore,
    private retentionDays: number,
    private intervalMs: number,
    private nowFn: () => Date = () => new Date(),
    private coordination?: CoordinationStore,
    private fanout?: TenantFanout,
  ) {}

  start(): void {
    this.startupTimeout = setTimeout(() => void this.poll(), 5_000);
    this.interval = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
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
   * Returns the total number of rows deleted across every tenant in
   * the fan-out (or just the global sweep when fan-out isn't wired).
   */
  async runOnce(): Promise<number> {
    return this.fanout
      ? runTenantFanout({
          jobName: "trash-purge",
          coordination: this.coordination,
          fanout: this.fanout,
          nowFn: this.nowFn,
          instanceDefault: this.retentionDays,
          unitMs: MS_PER_DAY,
          sweep: (cutoff, tenantId) =>
            this.items.purgeTrashedOlderThan(cutoff, tenantId),
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

  private async poll(): Promise<void> {
    try {
      // Per-tenant fan-out paths grab their own per-tenant locks
      // inside runOnce; the global path holds a single cluster-wide
      // lock here.
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
      log("error", "Trash purge error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Hard-deletes feed-tier items whose `updated_at` is older than the
 * configured retention window. Operates regardless of state — feed
 * capture is short-retention by definition.
 *
 * If `retentionDays <= 0`, the job is a no-op. The default at the config
 * layer is 0 (disabled) — feed retention is opt-in per deployment.
 *
 * T-050: same fan-out shape as `TrashPurger`; when `fanout` is wired
 * the job iterates per-tenant honouring `feed_retention_days`
 * overrides.
 */
export class FeedExpirer {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private items: ItemStore,
    private retentionDays: number,
    private intervalMs: number,
    private nowFn: () => Date = () => new Date(),
    private coordination?: CoordinationStore,
    private fanout?: TenantFanout,
  ) {}

  start(): void {
    this.startupTimeout = setTimeout(() => void this.poll(), 5_000);
    this.interval = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
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
      ? runTenantFanout({
          jobName: "feed-expiry",
          coordination: this.coordination,
          fanout: this.fanout,
          nowFn: this.nowFn,
          instanceDefault: this.retentionDays,
          unitMs: MS_PER_DAY,
          sweep: (cutoff, tenantId) =>
            this.items.expireFeedOlderThan(cutoff, tenantId),
        })
      : this.runOnceGlobal();
  }

  private async runOnceGlobal(): Promise<number> {
    if (this.retentionDays <= 0) return 0;
    const cutoff = new Date(
      this.nowFn().getTime() - this.retentionDays * MS_PER_DAY,
    ).toISOString();
    return this.items.expireFeedOlderThan(cutoff);
  }

  private async poll(): Promise<void> {
    try {
      const deleted = this.fanout
        ? await this.runOnce()
        : this.coordination
          ? await this.coordination.withJobLock("feed-expiry", () =>
              this.runOnce(),
            )
          : await this.runOnce();
      if (deleted !== undefined && deleted > 0) {
        log("info", "Feed expiry", {
          deleted,
          retentionDays: this.retentionDays,
        });
      }
    } catch (err) {
      log("error", "Feed expiry error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Per-tenant fan-out helper
// ---------------------------------------------------------------------------

/**
 * T-050: shared fan-out runner. Used by `TrashPurger` and `FeedExpirer`
 * for the unit-of-days delete jobs (and exposed via {@link runTenantCleanup}
 * for the audit + event-log jobs which live inline in `index.ts`).
 *
 * For each tenant + the NULL-tenant bucket, resolves an effective
 * retention (per-tenant override OR `instanceDefault`) and runs a
 * tenant-scoped sweep with `cutoff = now - retention * unitMs`. A
 * value of `0` for the effective retention is the documented "disable
 * for this scope" sentinel and skips the sweep without an error.
 *
 * Each per-tenant invocation grabs `coordination.withJobLock` on a
 * tenant-specific key (`<jobName>:<tenant-id-or-_no_tenant>`) so two
 * server instances racing the same tick don't double-process a tenant.
 */
async function runTenantFanout(opts: {
  jobName: string;
  coordination: CoordinationStore | undefined;
  fanout: TenantFanout;
  nowFn: () => Date;
  instanceDefault: number;
  unitMs: number;
  sweep: (cutoff: string, tenantId: string | null) => Promise<number>;
}): Promise<number> {
  const tenants = await opts.fanout.tenants.list();
  let total = 0;
  // Per-tenant scopes — each honours the tenant override when set.
  for (const tenant of tenants) {
    const config = await opts.fanout.tenants.getConfig(tenant.id);
    const override = config?.[opts.fanout.configField];
    const effective =
      typeof override === "number" ? override : opts.instanceDefault;
    if (effective <= 0) continue;
    const cutoff = new Date(
      opts.nowFn().getTime() - effective * opts.unitMs,
    ).toISOString();
    const deleted = await runOneScope(
      opts.coordination,
      `${opts.jobName}:${tenant.id}`,
      () => opts.sweep(cutoff, tenant.id),
    );
    if (deleted) total += deleted;
  }
  // NULL-tenant scope — single-tenant self-host items + any unscoped
  // legacy rows. Always uses the instance default (the legacy
  // unscoped semantics are preserved for self-hosts that never
  // configured per-tenant overrides).
  if (opts.instanceDefault > 0) {
    const cutoff = new Date(
      opts.nowFn().getTime() - opts.instanceDefault * opts.unitMs,
    ).toISOString();
    const deleted = await runOneScope(
      opts.coordination,
      `${opts.jobName}:_no_tenant`,
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
 * T-050: fan-out runner for the audit + event-log cleanup jobs that
 * live inline in `index.ts`. Same shape as the in-class fan-out above
 * but exposed for the inline callsites that don't have their own
 * Purger class. Returns the total number of rows deleted across every
 * scope swept this tick.
 *
 * `unitMs` is `MS_PER_DAY` for the audit job (retention is in days)
 * and `3_600_000` for the event-log job (retention is in hours);
 * passed in by the caller so the helper stays unit-agnostic.
 */
export async function runTenantCleanup(opts: {
  jobName: string;
  coordination: CoordinationStore | undefined;
  fanout: TenantFanout | undefined;
  instanceDefault: number;
  unitMs: number;
  /** Cleanup sweep — `tenantId === null` means "rows where tenant_id IS NULL". */
  sweep: (retention: number, tenantId?: string | null) => Promise<number>;
  nowFn?: () => Date;
}): Promise<number> {
  const nowFn = opts.nowFn ?? (() => new Date());
  if (!opts.fanout) {
    // Legacy global path — preserves single-tenant self-host
    // behaviour exactly. The cleanup methods take retention values
    // directly (not pre-computed cutoffs); pass through.
    if (opts.instanceDefault <= 0) return 0;
    const fn = (): Promise<number> => opts.sweep(opts.instanceDefault);
    if (!opts.coordination) return fn();
    return (await opts.coordination.withJobLock(opts.jobName, fn)) ?? 0;
  }
  const tenants = await opts.fanout.tenants.list();
  let total = 0;
  for (const tenant of tenants) {
    const config = await opts.fanout.tenants.getConfig(tenant.id);
    const override = config?.[opts.fanout.configField];
    const effective =
      typeof override === "number" ? override : opts.instanceDefault;
    if (effective <= 0) continue;
    const deleted = await runOneScope(
      opts.coordination,
      `${opts.jobName}:${tenant.id}`,
      () => opts.sweep(effective, tenant.id),
    );
    if (deleted) total += deleted;
  }
  if (opts.instanceDefault > 0) {
    const deleted = await runOneScope(
      opts.coordination,
      `${opts.jobName}:_no_tenant`,
      () => opts.sweep(opts.instanceDefault, null),
    );
    if (deleted) total += deleted;
  }
  // Quiet a TS unused-var warning: nowFn is reserved for future
  // pre-computed-cutoff variants. The audit/eventLog stores compute
  // their own cutoffs from the retention argument, so we don't use
  // it today.
  void nowFn;
  return total;
}
