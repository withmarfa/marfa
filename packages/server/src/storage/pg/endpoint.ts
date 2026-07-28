/**
 * Parsing helpers for Postgres connection strings.
 *
 * Deliberately dependency-free and separate from `connection.ts`: `config.ts`
 * needs these for its boot guard, and `config.ts` is loaded by the OpenTelemetry
 * bootstrap that runs before the app's own modules. Importing them from
 * `connection.ts` would drag Drizzle, postgres.js and the generated schema DDL
 * into that path, which is supposed to be a true no-op when telemetry is off.
 */

/** Port Postgres listens on when a connection string omits one. */
const DEFAULT_PG_PORT = "5432";

interface PgEndpoint {
  host: string;
  port: string;
}

function parsePgEndpoint(connectionString: string): PgEndpoint | null {
  try {
    const url = new URL(connectionString.trim());
    const host = url.hostname.toLowerCase();
    if (host === "") return null;
    return { host, port: url.port === "" ? DEFAULT_PG_PORT : url.port };
  } catch {
    return null;
  }
}

/**
 * Host of a Postgres URL, for logging. Never the whole connection string —
 * that carries the password. Returns `"unknown"` rather than throwing, since
 * a log line is not worth failing a boot over.
 */
export function pgEndpointHost(connectionString: string): string {
  return parsePgEndpoint(connectionString)?.host ?? "unknown";
}

/**
 * `host:port` of a Postgres URL, for a guard message. Same no-credentials rule
 * as `pgEndpointHost`; falls back to `"unknown"` on anything unparseable.
 */
export function pgEndpointLabel(connectionString: string): string {
  const endpoint = parsePgEndpoint(connectionString);
  return endpoint === null ? "unknown" : `${endpoint.host}:${endpoint.port}`;
}

/**
 * True when two connection strings address the same listener.
 *
 * The comparison is on host **and** port, not host alone. A single host:port is
 * one listener and is therefore either a pooler or a Postgres, never both — so
 * equality here means the two URLs cannot be a pooled/direct pair. Port matters
 * because the common self-hosted topology runs PgBouncer beside Postgres on one
 * machine (`localhost:6432` pooled, `localhost:5432` direct), which a host-only
 * comparison would wrongly reject. On Neon the pair differs the other way: same
 * port, and hostnames separated by six characters (`ep-x-pooler…` vs `ep-x…`).
 *
 * Strings that fail to parse only match when they are byte-identical, which
 * still catches the same value being handed to both variables.
 */
export function isSamePgEndpoint(a: string, b: string): boolean {
  const left = a.trim();
  const right = b.trim();
  if (left === "" || right === "") return false;
  if (left === right) return true;
  const parsedLeft = parsePgEndpoint(left);
  const parsedRight = parsePgEndpoint(right);
  if (parsedLeft === null || parsedRight === null) return false;
  return (
    parsedLeft.host === parsedRight.host && parsedLeft.port === parsedRight.port
  );
}
