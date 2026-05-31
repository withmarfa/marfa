import { createMiddleware } from "hono/factory";
import { generateId } from "@withmarfa/shared";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { AnyValue, AnyValueMap } from "@opentelemetry/api-logs";
import type { AppEnv } from "./auth.js";

// ---------------------------------------------------------------------------
// Structured log entry
// ---------------------------------------------------------------------------

interface LogEntry {
  timestamp: string;
  request_id: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  key_id?: string;
  error_code?: string;
}

// ---------------------------------------------------------------------------
// Request-ID resolution
// ---------------------------------------------------------------------------

/**
 * Safe character class for a client-provided `X-Request-ID`.
 *
 * Most request-ID conventions (UUIDv7, UUIDv4, Datadog trace IDs, opaque
 * correlation keys) use only ASCII alphanumerics plus `-` / `_`. Capping at
 * 128 chars avoids log amplification from a pathological client. Headers
 * outside this pattern are discarded silently and the server generates its
 * own ID — callers see their round-trip ID in the response header, so a
 * dropped value is self-diagnosable.
 */
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Resolves the request ID for this request. Prefers the client's
 * `X-Request-ID` header when present and well-formed so a stuck-mutation
 * log line on the client pairs cleanly with the server entry; falls back
 * to a server-generated UUIDv7 otherwise.
 *
 * Exported for unit testing.
 */
export function resolveRequestId(incomingHeader: string | undefined): string {
  if (incomingHeader && CLIENT_REQUEST_ID_PATTERN.test(incomingHeader)) {
    return incomingHeader;
  }
  return generateId();
}

// ---------------------------------------------------------------------------
// Standalone logger for non-request contexts (startup, shutdown, background)
// ---------------------------------------------------------------------------

type LogLevel = "info" | "warn" | "error";

const LEVEL_TO_SEVERITY: Record<LogLevel, SeverityNumber> = {
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

/**
 * T-275: mirror a log line to the OpenTelemetry logs pipeline. A pure no-op
 * unless a global `LoggerProvider` is registered by `instrumentation.ts`
 * (i.e. only when `MARFA_OTEL_ENABLED=true` with a logs endpoint). The OTLP
 * log exporter ships these to PostHog in hosted mode. PII redaction runs in
 * the `PiiRedactionLogRecordProcessor` before export; the `log()` body /
 * request line is Marfa-controlled and safe.
 */
function emitOtelLog(
  level: LogLevel,
  body: string,
  attributes: Record<string, unknown>,
): void {
  logs.getLogger("marfa-server").emit({
    severityNumber: LEVEL_TO_SEVERITY[level],
    severityText: level.toUpperCase(),
    body,
    attributes: attributes as Record<string, AnyValue> satisfies AnyValueMap,
    timestamp: new Date(),
  });
}

export function log(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  process.stdout.write(JSON.stringify(entry) + "\n");
  emitOtelLog(level, message, data ?? {});
}

// ---------------------------------------------------------------------------
// Hono middleware — logs every request as JSON to stdout at completion
// ---------------------------------------------------------------------------

export function loggerMiddleware() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const requestId = resolveRequestId(c.req.header("X-Request-ID"));
    c.set("requestId", requestId);
    c.header("X-Request-ID", requestId);

    const start = performance.now();
    await next();
    const duration = performance.now() - start;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      request_id: requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Math.round(duration * 100) / 100,
    };

    const apiKey = c.get("apiKey");
    if (apiKey) entry.key_id = apiKey.id;

    // Extract error code from response body if it's an error status
    if (c.res.status >= 400) {
      const errorCode = c.res.headers.get("X-Error-Code");
      if (errorCode) entry.error_code = errorCode;
    }

    process.stdout.write(JSON.stringify(entry) + "\n");

    // T-275: mirror to OTel logs (no-op unless a LoggerProvider is
    // registered). Severity tracks the response status.
    const level: LogLevel =
      entry.status >= 500 ? "error" : entry.status >= 400 ? "warn" : "info";
    emitOtelLog(level, `${entry.method} ${entry.path}`, { ...entry });
  });
}
