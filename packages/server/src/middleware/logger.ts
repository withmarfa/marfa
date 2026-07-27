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
 * Mirror a log line to the OpenTelemetry logs pipeline. A pure no-op
 * unless a global `LoggerProvider` is registered by `instrumentation.ts`
 * (i.e. only when `MARFA_OTEL_ENABLED=true` with a logs endpoint). PII
 * redaction runs in the `PiiRedactionLogRecordProcessor` before export.
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
  const { payload, firstError } = prepareLogPayload(data);
  // The one-line summary is what a human greps for; the structured form is
  // what a log query filters on. A caller that supplied its own summary knows
  // more about the failure than this does, so it wins.
  if (firstError !== undefined && payload.error_summary === undefined) {
    payload.error_summary = formatErrorSummary(firstError);
  }
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...payload,
  };
  process.stdout.write(JSON.stringify(entry) + "\n");
  emitOtelLog(level, message, payload);
}

/**
 * Render a log payload so `JSON.stringify` cannot silently discard the most
 * important thing in it.
 *
 * An `Error` holds its `message`, `name`, and `stack` on non-enumerable
 * properties, so `JSON.stringify(err)` is `{}`. Better Auth's logger bridge
 * hands this function `{ args: [Error] }`, which means a database failure
 * reached the log line as `{"args":[{}]}` — SQLSTATE, message and all,
 * deleted at the log layer. That absence was then read as evidence that no
 * such failure was happening.
 *
 * Errors are replaced with `serializeError`'s structured form wherever they
 * appear: passed directly, nested in an object, or inside an array. The first
 * one found is returned so the caller can also stamp a one-line summary.
 */
function prepareLogPayload(data: Record<string, unknown> | undefined): {
  payload: Record<string, unknown>;
  firstError: unknown;
} {
  const payload: Record<string, unknown> = {};
  if (!data) return { payload, firstError: undefined };

  let firstError: unknown;
  // Cycles are rare in log payloads but fatal when they happen: an unguarded
  // `JSON.stringify` throws, and a logger that throws takes out the code path
  // that was trying to report a problem.
  const seen = new WeakSet();

  const visit = (value: unknown, depth: number): unknown => {
    if (value == null || typeof value !== "object") return value;
    if (isErrorLike(value)) {
      firstError ??= value;
      return serializeError(value);
    }
    if (depth >= MAX_PAYLOAD_DEPTH) return "[truncated]";
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (Array.isArray(value))
      return value.map((item) => visit(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = visit(nested, depth + 1);
    }
    return out;
  };

  for (const [key, value] of Object.entries(data)) {
    payload[key] = visit(value, 0);
  }
  return { payload, firstError };
}

/** Depth beyond which a logged payload is noise rather than diagnosis. */
const MAX_PAYLOAD_DEPTH = 6;

/**
 * `instanceof Error` misses errors thrown across a realm boundary — a
 * `worker_thread`, a `vm` context, or a dependency bundling its own copy of a
 * subclass. The internal-class tag survives all three.
 */
function isErrorLike(value: object): boolean {
  return (
    value instanceof Error ||
    Object.prototype.toString.call(value) === "[object Error]"
  );
}

// ---------------------------------------------------------------------------
// Error serialization for log lines
// ---------------------------------------------------------------------------

/**
 * Fields worth lifting off a thrown value so a failure is diagnosable from
 * the log line alone. Node socket errors carry `code` / `errno` / `syscall` /
 * `address` / `port`; `postgres.js` carries the SQLSTATE `code` plus
 * `detail` / `routine` / `severity` — the difference between "the database
 * refused the connection" and "a lock is held" lives in exactly these.
 */
const ERROR_DETAIL_KEYS = [
  "code",
  "errno",
  "syscall",
  "address",
  "port",
  "severity",
  "detail",
  "hint",
  "routine",
  "table",
  "constraint",
] as const;

/** Guards against a self-referential or pathologically deep cause chain. */
const MAX_CAUSE_DEPTH = 5;

/** `AggregateError.errors` can be arbitrarily long; a handful is enough. */
const MAX_AGGREGATE_ERRORS = 5;

/**
 * One-line human summary of a thrown value, walking the cause chain.
 *
 * `err.message` alone is not enough: an `AggregateError` (what Node raises
 * when every address a host resolves to refuses the connection) has an empty
 * message and hides the real detail in `errors`, and a wrapped error hides it
 * in `cause`. Both collapse to `""` under a naive `err.message` read, which
 * makes a failed boot indistinguishable from any other failed boot.
 */
export function formatErrorSummary(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current != null && depth <= MAX_CAUSE_DEPTH; depth += 1) {
    parts.push(describeErrorValue(current));
    current = nextInChain(current);
  }
  if (parts.length === 0) return "unknown error";
  return parts.join(" <- caused by ");
}

function nextInChain(err: unknown): unknown {
  if (err == null || typeof err !== "object") return undefined;
  const e = err as { cause?: unknown; errors?: unknown };
  if (e.cause != null) return e.cause;
  // Only the first sub-error rides the summary; serializeError keeps them all.
  if (Array.isArray(e.errors) && e.errors.length > 0) return e.errors[0];
  return undefined;
}

/**
 * Last-resort rendering for a thrown value that is not an Error. Anything
 * can be thrown; a log line is worth more than a `[object Object]`.
 */
function stringifyThrownValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return value.toString();
  }
  if (typeof value === "function") {
    return `[function ${value.name || "anonymous"}]`;
  }
  try {
    const json = JSON.stringify(value);
    if (json !== "{}") return json.slice(0, 200);
  } catch {
    // Circular or non-serializable — fall through to the tag below.
  }
  return Object.prototype.toString.call(value);
}

function describeErrorValue(err: unknown): string {
  if (err == null) return "unknown error";
  if (typeof err !== "object") return stringifyThrownValue(err);
  const e = err as { name?: unknown; message?: unknown; code?: unknown };
  const name = typeof e.name === "string" && e.name !== "" ? e.name : undefined;
  const message = typeof e.message === "string" ? e.message.trim() : "";

  let text: string;
  if (message && name && name !== "Error") text = `${name}: ${message}`;
  else if (message) text = message;
  else if (name) text = name;
  else text = stringifyThrownValue(err);

  const code = e.code;
  if (typeof code === "string" || typeof code === "number") {
    const codeText = code.toString();
    if (!text.includes(codeText)) text += ` (${codeText})`;
  }
  return text;
}

/**
 * Structured form of a thrown value: message, name, the diagnostic fields
 * above, the full cause chain, and every branch of an `AggregateError`.
 * Stacks ride along outside production, where they are worth more than the
 * noise they add.
 */
export function serializeError(err: unknown, depth = 0): unknown {
  if (err == null) return null;
  if (typeof err !== "object") return stringifyThrownValue(err);

  const e = err as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof e.name === "string" && e.name !== "") out.name = e.name;
  out.message = typeof e.message === "string" ? e.message : "";

  for (const key of ERROR_DETAIL_KEYS) {
    const value = e[key];
    if (typeof value === "string" || typeof value === "number") {
      out[key] = value;
    }
  }

  if (process.env.NODE_ENV !== "production" && typeof e.stack === "string") {
    out.stack = e.stack;
  }

  if (depth < MAX_CAUSE_DEPTH) {
    if (e.cause != null) out.cause = serializeError(e.cause, depth + 1);
    if (Array.isArray(e.errors) && e.errors.length > 0) {
      out.errors = e.errors
        .slice(0, MAX_AGGREGATE_ERRORS)
        .map((sub) => serializeError(sub, depth + 1));
    }
  }

  return out;
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

    if (c.res.status >= 400) {
      const errorCode = c.res.headers.get("X-Error-Code");
      if (errorCode) entry.error_code = errorCode;
    }

    process.stdout.write(JSON.stringify(entry) + "\n");

    const level: LogLevel =
      entry.status >= 500 ? "error" : entry.status >= 400 ? "warn" : "info";
    emitOtelLog(level, `${entry.method} ${entry.path}`, { ...entry });
  });
}
