import { log } from "./middleware/logger.js";

/**
 * Opt-in liveness heartbeat. GETs an operator-set URL on the housekeeping
 * cadence so a watcher running somewhere else can raise the alarm when the
 * pings stop. The principle: a system cannot report its own death, so the
 * thing that notices has to live outside the instance. Deliberately dumb —
 * no payload, no metrics, no identity beyond the URL the operator chose —
 * because anything more becomes a report and changes the privacy story.
 *
 * Failures are logged at warn and never escalate: an unreachable receiver
 * must not degrade the instance it exists to watch, so a ping never throws.
 */
export class HeartbeatPinger {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(
      globalThis,
    ),
  ) {}

  /** One ping. Reports whether the receiver answered 2xx and with what. */
  async runOnce(): Promise<{ ok: boolean; status: number | null }> {
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
      return { ok: res.ok, status: res.status };
    } catch (err) {
      log("warn", "Heartbeat ping failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, status: null };
    }
  }
}
