import type { FiguresKeeper, ReportFigures } from "./instance-figures.js";

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

/**
 * A figure that could not be read is left out. CPU is the use since `since`,
 * the process total at the previous attempt.
 */
export function reportProperties(
  figures: ReportFigures,
  since: CpuSeconds,
): ReportProperties {
  const { process: p, files, counts, blobs } = figures;
  const candidates: ReportProperties = {
    release: p.release,
    memory_rss_bytes: p.rss_bytes ?? undefined,
    memory_rss_peak_bytes: p.rss_peak_bytes ?? undefined,
    heap_used_bytes: p.heap_used_bytes ?? undefined,
    heap_total_bytes: p.heap_total_bytes ?? undefined,
    cpu_user_seconds:
      p.cpu_user_seconds === null
        ? undefined
        : Math.max(0, p.cpu_user_seconds - since.user),
    cpu_system_seconds:
      p.cpu_system_seconds === null
        ? undefined
        : Math.max(0, p.cpu_system_seconds - since.system),
    uptime_seconds: p.uptime_seconds,
    database_bytes: files.database_bytes ?? undefined,
    wal_bytes: files.wal_bytes ?? undefined,
    items_count: counts.items ?? undefined,
    versions_count: counts.versions ?? undefined,
    event_log_count: counts.event_log ?? undefined,
    audit_log_count: counts.audit_log ?? undefined,
    blob_count: blobs?.count,
    blob_bytes: blobs?.total_bytes,
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
  /** Whether reporting is on now. When it is off, nothing counts or advances. */
  enabled: () => Promise<boolean>;
  send: (event: string, properties: ReportProperties) => Promise<void>;
  warn: (message: string, data: Record<string, unknown>) => void;
  firstDelayMs?: number;
  intervalMs?: number;
  sendTimeoutMs?: number;
}): DailyReport {
  const { keeper, enabled, send, warn } = options;
  const timeoutMs = options.sendTimeoutMs ?? REPORT_SEND_TIMEOUT_MS;
  let since: CpuSeconds = { user: 0, system: 0 };
  let running = false;
  let stopped = false;

  async function report(): Promise<void> {
    if (running || stopped) return;
    running = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!(await enabled())) return;
      const figures = await keeper.reportFigures();
      const properties = reportProperties(figures, since);
      // The baseline moves when a send is attempted, whatever comes of it: a
      // report that is lost loses its period's CPU rather than counting it
      // into the next one.
      const { cpu_user_seconds: user, cpu_system_seconds: system } =
        figures.process;
      since = { user: user ?? since.user, system: system ?? since.system };
      const sent = send(REPORT_EVENT, properties);
      const limit = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`no answer within ${String(timeoutMs)} ms`));
        }, timeoutMs);
        timeout.unref();
      });
      // The loser of the race must not become an unhandled rejection.
      sent.catch(() => undefined);
      await Promise.race([sent, limit]);
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
