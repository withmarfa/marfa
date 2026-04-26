import { createConnection } from "node:net";
import { URL } from "node:url";

/**
 * Reachability gate for the integration suite. Probes Atlas Postgres
 * and Atlas Electric over TCP (the user's machine should be on the
 * tailnet; if not, we skip the suite cleanly rather than producing red
 * runs).
 *
 * Required env (set by the user before running integration):
 *   MYME_INTEGRATION_DATABASE_URL  e.g. postgres://myme@aic-atlas:5432/myme_mock?sslmode=disable
 *   MYME_INTEGRATION_ELECTRIC_URL  e.g. http://aic-atlas:8604
 *   MYME_INTEGRATION_SALT          API key salt for the mock instance
 *   MYME_INTEGRATION_API_KEY       myme_k1_… key valid against the same instance
 */

export interface AtlasReachability {
  ok: boolean;
  reason: string;
}

const PROBE_TIMEOUT_MS = 2_000;

function probe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, PROBE_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

interface HostPort {
  host: string;
  port: number;
}

function parsePostgresUrl(value: string): HostPort | null {
  // postgres://[user[:pass]@]host[:port]/db[?…]
  const stripped = value.replace(/^postgres(ql)?:\/\//, "");
  const atIdx = stripped.indexOf("@");
  const afterAt = atIdx >= 0 ? stripped.slice(atIdx + 1) : stripped;
  const slashIdx = afterAt.indexOf("/");
  const hostPort = slashIdx >= 0 ? afterAt.slice(0, slashIdx) : afterAt;
  const [host, portStr] = hostPort.split(":");
  if (!host) return null;
  const port = portStr ? Number(portStr) : 5432;
  if (Number.isNaN(port)) return null;
  return { host, port };
}

function parseHttpUrl(value: string): HostPort | null {
  try {
    const u = new URL(value);
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80,
    };
  } catch {
    return null;
  }
}

export interface IntegrationEnv {
  databaseUrl: string;
  electricUrl: string;
  salt: string;
  apiKey: string;
}

export function readIntegrationEnv(): IntegrationEnv | null {
  const databaseUrl = process.env.MYME_INTEGRATION_DATABASE_URL;
  const electricUrl = process.env.MYME_INTEGRATION_ELECTRIC_URL;
  const salt = process.env.MYME_INTEGRATION_SALT;
  const apiKey = process.env.MYME_INTEGRATION_API_KEY;
  if (!databaseUrl || !electricUrl || !salt || !apiKey) return null;
  return { databaseUrl, electricUrl, salt, apiKey };
}

/**
 * Resolve all preconditions for the integration suite:
 *   1. Required env vars are set.
 *   2. The database host is reachable on its TCP port.
 *   3. The Electric host is reachable on its TCP port.
 *
 * Returns `{ ok: false, reason }` on any failure so the suite's
 * `beforeAll` can call `it.skip` for everything in the file with a
 * clear log line.
 */
export async function checkAtlasReachable(): Promise<AtlasReachability> {
  const env = readIntegrationEnv();
  if (!env) {
    return {
      ok: false,
      reason:
        "MYME_INTEGRATION_{DATABASE_URL,ELECTRIC_URL,SALT,API_KEY} must be set",
    };
  }
  const pg = parsePostgresUrl(env.databaseUrl);
  if (!pg) {
    return {
      ok: false,
      reason: `MYME_INTEGRATION_DATABASE_URL is not parseable: ${env.databaseUrl}`,
    };
  }
  const el = parseHttpUrl(env.electricUrl);
  if (!el) {
    return {
      ok: false,
      reason: `MYME_INTEGRATION_ELECTRIC_URL is not parseable: ${env.electricUrl}`,
    };
  }
  const [pgOk, elOk] = await Promise.all([
    probe(pg.host, pg.port),
    probe(el.host, el.port),
  ]);
  if (!pgOk) {
    return {
      ok: false,
      reason: `cannot reach Postgres at ${pg.host}:${String(pg.port)}`,
    };
  }
  if (!elOk) {
    return {
      ok: false,
      reason: `cannot reach Electric at ${el.host}:${String(el.port)}`,
    };
  }
  return { ok: true, reason: "" };
}
