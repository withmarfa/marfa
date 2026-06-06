import type { Attributes } from "@opentelemetry/api";
import type {
  ReadableSpan,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type {
  LogRecordProcessor,
  ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import type { AnyValueMap } from "@opentelemetry/api-logs";

/**
 * PII discipline for OpenTelemetry.
 *
 * Two layers, both keyed on the *attribute name* (case-insensitive):
 *
 *  - `DENYLIST_EXACT` — attributes dropped entirely. These are
 *    high-cardinality or unambiguously sensitive (auth/cookie headers,
 *    raw request/response bodies, raw SQL, email).
 *  - `REDACT_SUBSTRINGS` — any attribute whose key contains one of these
 *    substrings has its *value* replaced with `[REDACTED]`. Defense in
 *    depth: catches `*.authorization`, `*.api_key`, `*.token`, etc. that a
 *    future instrumentation might add under a name we didn't anticipate.
 *
 * Plus URL handling: query strings on URL-valued attributes are stripped
 * because magic-link / OAuth flows carry secrets in the query
 * (`?token=...`, `?code=...`).
 *
 * Explicitly KEPT (safe, useful for correlation): `tenant_id`, `key_id`,
 * `marfa.request_id`, `http.request.method`, `http.route`,
 * `http.response.status_code`, Marfa `error.code`, and the OTel exception
 * trio (`exception.type` / `exception.message` / `exception.stacktrace`) —
 * error tracking is worthless without them and none match a deny rule.
 *
 * The redaction runs in a SpanProcessor / LogRecordProcessor that is
 * registered BEFORE the exporting processor, so it mutates each record's
 * attributes before they are batched and exported. The pure
 * `redactAttributes` is the unit-tested core.
 */

/** Lowercased exact attribute names to drop. */
export const DENYLIST_EXACT: ReadonlySet<string> = new Set([
  "http.request.header.authorization",
  "http.request.header.cookie",
  "http.request.header.x-api-key",
  "http.response.header.set-cookie",
  "http.request.body",
  "http.response.body",
  "db.statement",
  "db.query.text",
  "user.email",
  "enduser.id",
]);

/** Lowercased substrings; any key containing one has its value redacted. */
export const REDACT_SUBSTRINGS: readonly string[] = [
  "authorization",
  "cookie",
  "password",
  "secret",
  "token",
  "api_key",
  "apikey",
  "email",
  "bearer",
];

/** Lowercased URL-valued attribute names whose query string is stripped. */
const URL_VALUE_KEYS: ReadonlySet<string> = new Set([
  "url.full",
  "http.url",
  "http.target",
]);

const REDACTED = "[REDACTED]";

function stripQuery(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const q = value.indexOf("?");
  return q === -1 ? value : `${value.slice(0, q)}?${REDACTED}`;
}

/**
 * Pure redaction over an attribute bag. Returns a NEW object — the input is
 * not mutated. Operates on a generic record so it serves both trace
 * `Attributes` and log `AnyValueMap` (whose values are a wider union); call
 * sites cast the result back to the concrete OTel type. This is the gating
 * unit-tested surface; the processors below just reassign each record's
 * `attributes` to the result.
 */
export function redactAttributes(
  attrs: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (DENYLIST_EXACT.has(lower)) continue; // drop entirely
    if (lower === "url.query") {
      out[key] = REDACTED;
      continue;
    }
    if (URL_VALUE_KEYS.has(lower)) {
      out[key] = stripQuery(value);
      continue;
    }
    if (REDACT_SUBSTRINGS.some((s) => lower.includes(s))) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = value;
  }
  return out;
}

type MutableSpan = { -readonly [K in keyof ReadableSpan]: ReadableSpan[K] };

/**
 * SpanProcessor that redacts a span's attributes (and any event
 * attributes — exception events can carry stray secrets) in `onEnd`,
 * before the exporting processor sees it. Register this FIRST.
 */
export class PiiRedactionSpanProcessor implements SpanProcessor {
  onStart(): void {
    /* no-op — attributes are populated during the span's life */
  }

  onEnd(span: ReadableSpan): void {
    const mut = span as MutableSpan;
    mut.attributes = redactAttributes(span.attributes) as Attributes;
    if (span.events.length > 0) {
      mut.events = span.events.map((e) => ({
        ...e,
        attributes: e.attributes
          ? (redactAttributes(e.attributes) as Attributes)
          : e.attributes,
      }));
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

type MutableLogRecord = {
  -readonly [K in keyof ReadableLogRecord]: ReadableLogRecord[K];
};

/**
 * LogRecordProcessor that redacts a log record's attributes in `onEmit`,
 * before the exporting processor sees it. Register this FIRST. The log
 * `body` is the Marfa-controlled message string (safe by construction), so
 * only attributes are redacted.
 */
export class PiiRedactionLogRecordProcessor implements LogRecordProcessor {
  onEmit(logRecord: ReadableLogRecord): void {
    (logRecord as MutableLogRecord).attributes = redactAttributes(
      logRecord.attributes,
    ) as AnyValueMap;
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
