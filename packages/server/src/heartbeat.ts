import { log } from "./middleware/logger.js";

/**
 * Opt-in liveness heartbeat. GETs an operator-set URL on a timer so a
 * watcher running somewhere else can raise the alarm when the pings stop.
 * The principle: a system cannot report its own death, so the thing that
 * notices has to live outside the instance. Deliberately dumb — no payload,
 * no metrics, no identity beyond the URL the operator chose — because
 * anything more becomes a report and changes the privacy story.
 *
 * Failures are logged at warn and never escalate: an unreachable receiver
 * must not degrade the instance it exists to watch.
 */
export class HeartbeatPinger {
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly url: string,
    private readonly intervalMs: number,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(
      globalThis,
    ),
  ) {}

  start(): void {
    if (this.interval !== null) return;
    // Ping immediately so a freshly booted instance is visible before the
    // first interval elapses, then on the cadence.
    void this.ping();
    this.interval = setInterval(() => void this.ping(), this.intervalMs);
  }

  stop(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async ping(): Promise<void> {
    try {
      const res = await this.fetchImpl(this.url, {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        log("warn", "Heartbeat receiver answered non-2xx", {
          status: res.status,
        });
      }
    } catch (err) {
      log("warn", "Heartbeat ping failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
