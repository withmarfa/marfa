import type { CoordinationStore, ItemStore } from "./interface.js";
import { log } from "../middleware/logger.js";

const MS_PER_DAY = 86_400_000;

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
   */
  async runOnce(): Promise<number> {
    if (this.retentionDays <= 0) return 0;
    const cutoff = new Date(
      this.nowFn().getTime() - this.retentionDays * MS_PER_DAY,
    ).toISOString();
    return this.items.purgeTrashedOlderThan(cutoff);
  }

  private async poll(): Promise<void> {
    try {
      const deleted = this.coordination
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
 * Hard-deletes ambient items (those with `library: false`) whose
 * `updated_at` is older than the configured retention window. Operates
 * regardless of state — ambient capture is short-retention by definition.
 *
 * If `retentionDays <= 0`, the job is a no-op. The default at the config
 * layer is 0 (disabled) — ambient retention is opt-in per deployment.
 */
export class AmbientExpirer {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private items: ItemStore,
    private retentionDays: number,
    private intervalMs: number,
    private nowFn: () => Date = () => new Date(),
    private coordination?: CoordinationStore,
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
    if (this.retentionDays <= 0) return 0;
    const cutoff = new Date(
      this.nowFn().getTime() - this.retentionDays * MS_PER_DAY,
    ).toISOString();
    return this.items.expireAmbientOlderThan(cutoff);
  }

  private async poll(): Promise<void> {
    try {
      const deleted = this.coordination
        ? await this.coordination.withJobLock("ambient-expiry", () =>
            this.runOnce(),
          )
        : await this.runOnce();
      if (deleted !== undefined && deleted > 0) {
        log("info", "Ambient expiry", {
          deleted,
          retentionDays: this.retentionDays,
        });
      }
    } catch (err) {
      log("error", "Ambient expiry error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
