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

/** Per-call options for {@link log}. */
export interface LogOptions {
  /**
   * Keep this line out of the OpenTelemetry mirror, so it reaches stdout and
   * nothing else.
   *
   * **The redactor cannot help here, and that is why the flag exists.** It
   * rewrites attributes and deliberately leaves the body alone, on the
   * reasoning that a message string is Marfa-controlled and so safe by
   * construction. A line whose message *is* a credential breaks that
   * reasoning, and there is exactly one: the bootstrap secret, which has to
   * be readable by whoever runs the instance and by nobody further. Exporting
   * it would make "can read the log" mean "can read the observability
   * backend", which is a much larger set than "runs this server".
   *
   * Not a general-purpose escape hatch. A line that needs this is a line
   * carrying a secret, and the answer for anything else is a redacted
   * attribute.
   */
  localOnly?: boolean;
}

/**
 * Emit one structured log line.
 *
 * Total by construction: no payload can make this throw, and every call emits
 * something. That is not defensiveness for its own sake. Every caller of this
 * function is reporting a problem, so a logger that throws takes out the code
 * path that was trying to tell someone — and the failure it swallows is the
 * one nobody then has any record of.
 */
export function log(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
  options?: LogOptions,
): void {
  let payload: Record<string, unknown>;
  let line: string;
  try {
    const prepared = prepareLogPayload(data);
    payload = prepared.payload;
    // The one-line summary is what a human greps for; the structured form is
    // what a log query filters on. A caller that supplied its own summary knows
    // more about the failure than this does, so it wins.
    if (
      prepared.firstError !== undefined &&
      payload.error_summary === undefined
    ) {
      payload.error_summary = formatErrorSummary(prepared.firstError);
    }
    line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...payload,
    });
  } catch (err) {
    // Unconditional net. Every rendering path above is individually guarded, so
    // nothing that satisfies this function's signature reaches here today and
    // no test can exercise it — which is the point: it is what stops the next
    // payload shape nobody anticipated from silently deleting a log line. Built
    // from primitives only, so it cannot fail in turn.
    payload = { log_payload_unrenderable: describeThrown(err) };
    line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message: safeString(message),
      ...payload,
    });
  }
  try {
    process.stdout.write(line + "\n");
  } catch {
    // stdout is gone (a closed pipe on shutdown). There is nothing left to
    // report the failure with, and throwing here would only hide the caller's.
  }
  if (options?.localOnly === true) return;
  try {
    emitOtelLog(level, message, payload);
  } catch {
    // The telemetry mirror is best-effort and must never take out the primary
    // stdout line, which has already been written above.
  }
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
  /**
   * The objects on the path from the payload root down to the value being
   * visited, and only those. A value is circular when it contains *itself*, not
   * when it appears twice — a traversal-wide set would render the second and
   * every later appearance of a repeated-but-acyclic value (the same space
   * record on ten rows, one shared config object) as `"[circular]"`, deleting
   * the evidence the line exists to carry. Entries are removed on the way back
   * up so siblings each get a full rendering.
   */
  const ancestors = new Set<object>();

  const visit = (value: unknown, depth: number): unknown => {
    if (value === null || value === undefined) return value;

    const kind = typeof value;
    // `JSON.stringify` throws outright on a BigInt, and silently drops symbols
    // and functions — a dropped key is lost evidence, so render them instead.
    if (kind === "bigint" || kind === "symbol" || kind === "function") {
      return stringifyThrownValue(value);
    }
    // Everything left that is not an object is a string, number or boolean.
    if (kind !== "object") return value;

    if (isErrorLike(value)) {
      firstError ??= value;
      return serializeError(value);
    }
    if (depth >= MAX_PAYLOAD_DEPTH) return "[truncated]";
    if (ancestors.has(value)) return "[circular]";

    ancestors.add(value);
    try {
      // Honor `toJSON` the way `JSON.stringify` would, but here rather than at
      // stringify time, where a throwing implementation would take the whole
      // line down. Dates, URLs and every other self-rendering value pass
      // through this; without it they flatten to `{}` (no own enumerable
      // properties) and the value is gone.
      const custom = viaToJson(value);
      if (custom.handled) return visit(custom.value, depth + 1);
      if (Array.isArray(value)) {
        return value.map((item) => visit(item, depth + 1));
      }
      const out: Record<string, unknown> = {};
      for (const [key, nested] of safeEntries(value)) {
        out[key] = visit(nested, depth + 1);
      }
      return out;
    } finally {
      ancestors.delete(value);
    }
  };

  for (const [key, value] of safeEntries(data)) {
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
  if (value instanceof Error) return true;
  return safeToStringTag(value) === "[object Error]";
}

// ---------------------------------------------------------------------------
// Total property access
//
// Everything below assumes the logged value is hostile: a getter that throws,
// a `toJSON` that throws, a `toString` that throws. None of that is exotic —
// a lazily-resolved ORM relation, a proxy over a torn-down resource, and a
// half-constructed config object all behave this way — and all of it reaches
// the logger precisely when something has already gone wrong.
// ---------------------------------------------------------------------------

/** Short, always-safe description of a value that could not be rendered. */
function describeThrown(err: unknown): string {
  try {
    if (err instanceof Error && typeof err.message === "string") {
      return err.message.slice(0, 200);
    }
  } catch {
    // A throwing `message` getter on the failure itself. Fall through.
  }
  return "unknown error";
}

/** `String(value)` that cannot be defeated by a throwing `toString`. */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return safeToStringTag(value);
  }
}

function safeToStringTag(value: unknown): string {
  try {
    return Object.prototype.toString.call(value);
  } catch {
    return "[unrenderable]";
  }
}

/** Own enumerable entries, with each property read guarded individually. */
function safeEntries(value: object): [string, unknown][] {
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch (err) {
    return [["log_keys_unreadable", describeThrown(err)]];
  }
  return keys.map((key) => [key, readProperty(value, key)]);
}

function readProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch (err) {
    return `[unreadable: ${describeThrown(err)}]`;
  }
}

/** Result of consulting a value's own `toJSON`, if it has a usable one. */
function viaToJson(value: object): { handled: boolean; value?: unknown } {
  let toJson: unknown;
  try {
    toJson = (value as { toJSON?: unknown }).toJSON;
  } catch (err) {
    return { handled: true, value: `[unreadable: ${describeThrown(err)}]` };
  }
  if (typeof toJson !== "function") return { handled: false };
  try {
    return { handled: true, value: (toJson as () => unknown).call(value) };
  } catch (err) {
    return { handled: true, value: `[unserializable: ${describeThrown(err)}]` };
  }
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
  try {
    const parts: string[] = [];
    let current: unknown = err;
    for (
      let depth = 0;
      current !== null && current !== undefined && depth <= MAX_CAUSE_DEPTH;
      depth += 1
    ) {
      parts.push(describeErrorValue(current));
      current = nextInChain(current);
    }
    if (parts.length === 0) return "unknown error";
    return parts.join(" <- caused by ");
  } catch (err2) {
    return `[unsummarizable: ${describeThrown(err2)}]`;
  }
}

function nextInChain(err: unknown): unknown {
  if (err === null || err === undefined || typeof err !== "object") {
    return undefined;
  }
  const cause = readProperty(err, "cause");
  if (cause !== null && cause !== undefined) return cause;
  // Only the first sub-error rides the summary; serializeError keeps them all.
  const errors = readProperty(err, "errors");
  if (Array.isArray(errors) && errors.length > 0) return errors[0];
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
    return safeString(value);
  }
  if (typeof value === "function") {
    return `[function ${readFunctionName(value)}]`;
  }
  try {
    const json = JSON.stringify(value);
    // `slice` stays inside the try: `JSON.stringify` is typed as returning a
    // string but returns undefined for a value that renders to nothing.
    if (json !== "{}") return json.slice(0, 200);
  } catch {
    // Circular, a BigInt, or a throwing toJSON — fall through to the tag below.
  }
  return safeToStringTag(value);
}

function readFunctionName(value: object): string {
  const name = readProperty(value, "name");
  return typeof name === "string" && name !== "" ? name : "anonymous";
}

function describeErrorValue(err: unknown): string {
  if (err === null || err === undefined) return "unknown error";
  if (typeof err !== "object") return stringifyThrownValue(err);
  const rawName = readProperty(err, "name");
  const rawMessage = readProperty(err, "message");
  const name =
    typeof rawName === "string" && rawName !== "" ? rawName : undefined;
  const message = typeof rawMessage === "string" ? rawMessage.trim() : "";

  let text: string;
  if (message && name && name !== "Error") text = `${name}: ${message}`;
  else if (message) text = message;
  else if (name) text = name;
  else text = stringifyThrownValue(err);

  const code = readProperty(err, "code");
  if (typeof code === "string" || typeof code === "number") {
    const codeText = safeString(code);
    if (!text.includes(codeText)) text += ` (${codeText})`;
  }
  return text;
}

/**
 * Structured form of a thrown value: message, name, the diagnostic fields
 * above, the full cause chain, and every branch of an `AggregateError`.
 * Stacks ride along outside production, where they are worth more than the
 * noise they add.
 *
 * Every field is read through a guard. An `Error` subclass that computes its
 * `message` lazily — and throws while doing so, because whatever it needed is
 * exactly what has just failed — is otherwise able to suppress the log line
 * describing its own failure.
 */
export function serializeError(err: unknown, depth = 0): unknown {
  if (err === null || err === undefined) return null;
  if (typeof err !== "object") return stringifyThrownValue(err);

  const out: Record<string, unknown> = {};
  const name = readProperty(err, "name");
  if (typeof name === "string" && name !== "") out.name = name;
  const message = readProperty(err, "message");
  out.message = typeof message === "string" ? message : "";

  for (const key of ERROR_DETAIL_KEYS) {
    const value = readProperty(err, key);
    if (typeof value === "string" || typeof value === "number") {
      out[key] = value;
    }
  }

  if (process.env.NODE_ENV !== "production") {
    const stack = readProperty(err, "stack");
    if (typeof stack === "string") out.stack = stack;
  }

  if (depth < MAX_CAUSE_DEPTH) {
    const cause = readProperty(err, "cause");
    if (cause !== null && cause !== undefined) {
      out.cause = serializeError(cause, depth + 1);
    }
    const errors = readProperty(err, "errors");
    if (Array.isArray(errors) && errors.length > 0) {
      out.errors = errors
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
