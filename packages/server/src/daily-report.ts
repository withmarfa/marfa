import type { FiguresKeeper, InstanceFigures } from "./instance-figures.js";

/** The event name PostHog shows. */
export const REPORT_EVENT = "marfa server report";

/**
 * Every property the report can carry. A figure is added here or not sent;
 * nothing is copied across by name, so no id, content, path, host or address
 * can ride along.
 */
export const REPORT_KEYS = [
  "release",
  "memory_rss_bytes",
  "memory_rss_peak_bytes",
  "heap_used_bytes",
  "heap_total_bytes",
  "cpu_user_seconds",
  "cpu_system_seconds",
  "uptime_seconds",
  "database_bytes",
  "wal_bytes",
  "items_count",
  "versions_count",
  "event_log_count",
  "audit_log_count",
  "blob_count",
  "blob_bytes",
] as const;

export type ReportKey = (typeof REPORT_KEYS)[number];
export type ReportProperties = Partial<Record<ReportKey, number | string>>;

export interface CpuSeconds {
  user: number;
  system: number;
}

export const FIRST_REPORT_DELAY_MS = 30_000;
export const REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const REPORT_SEND_TIMEOUT_MS = 10_000;

/** A figure that could not be read is left out. CPU is the use since `since`. */
export function reportProperties(
  figures: InstanceFigures,
  since: CpuSeconds,
): ReportProperties {
  const { process: p, storage: s } = figures;
  const candidates: ReportProperties = {
    release: p.release,
    memory_rss_bytes: p.rss_bytes,
    memory_rss_peak_bytes: p.rss_peak_bytes,
    heap_used_bytes: p.heap_used_bytes,
    heap_total_bytes: p.heap_total_bytes,
    cpu_user_seconds: Math.max(0, p.cpu_user_seconds - since.user),
    cpu_system_seconds: Math.max(0, p.cpu_system_seconds - since.system),
    uptime_seconds: p.uptime_seconds,
    database_bytes: s.database_bytes ?? undefined,
    wal_bytes: s.wal_bytes ?? undefined,
    items_count: s.items ?? undefined,
    versions_count: s.versions ?? undefined,
    event_log_count: s.event_log ?? undefined,
    audit_log_count: s.audit_log ?? undefined,
    blob_count: s.blobs ?? undefined,
    blob_bytes: s.blob_bytes ?? undefined,
  };
  const out: ReportProperties = {};
  for (const key of REPORT_KEYS) {
    const value = candidates[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export interface DailyReport {
  stop(): void;
}

export function startDailyReport(options: {
  keeper: FiguresKeeper;
  send: (event: string, properties: ReportProperties) => Promise<void>;
  warn: (message: string, data: Record<string, unknown>) => void;
  firstDelayMs?: number;
  intervalMs?: number;
  sendTimeoutMs?: number;
}): DailyReport {
  const { keeper, send, warn } = options;
  const timeoutMs = options.sendTimeoutMs ?? REPORT_SEND_TIMEOUT_MS;
  let since: CpuSeconds = { user: 0, system: 0 };
  let running = false;
  let stopped = false;

  async function report(): Promise<void> {
    if (running || stopped) return;
    running = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await keeper.refresh();
      const figures = await keeper.read();
      const sent = send(REPORT_EVENT, reportProperties(figures, since));
      const limit = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`no answer within ${String(timeoutMs)} ms`));
        }, timeoutMs);
        timeout.unref();
      });
      // The loser of the race must not become an unhandled rejection.
      sent.catch(() => undefined);
      await Promise.race([sent, limit]);
      since = {
        user: figures.process.cpu_user_seconds,
        system: figures.process.cpu_system_seconds,
      };
    } catch (error) {
      warn("The daily server report was not sent; the next one tries again", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      running = false;
    }
  }

  let every: ReturnType<typeof setInterval> | undefined;
  const first = setTimeout(() => {
    void report();
    if (stopped) return;
    every = setInterval(() => {
      void report();
    }, options.intervalMs ?? REPORT_INTERVAL_MS);
    every.unref();
  }, options.firstDelayMs ?? FIRST_REPORT_DELAY_MS);
  first.unref();

  return {
    stop() {
      stopped = true;
      clearTimeout(first);
      if (every) clearInterval(every);
    },
  };
}
