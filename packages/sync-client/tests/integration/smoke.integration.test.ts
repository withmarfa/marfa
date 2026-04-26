import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkAtlasReachable,
  readIntegrationEnv,
  type IntegrationEnv,
} from "./helpers/reachability.js";
import {
  pickEphemeralPort,
  startMymeServer,
  type SpawnedServer,
} from "./helpers/server.js";

/**
 * Phase-2 smoke. Proves the harness:
 *   1. Detects Atlas reachability and self-skips when offline.
 *   2. Reads the required env without crashing.
 *   3. Spawns the worktree's server, hits /openapi.json, and shuts
 *      down cleanly.
 *
 * No sync-client involvement here — this is purely the test plumbing.
 * Failure of this test means the integration tier is unrunnable, full
 * stop. Higher-tier tests inherit the same beforeAll gate.
 */

let server: SpawnedServer | null = null;
let env: IntegrationEnv | null = null;
let skip = false;
let skipReason = "";

beforeAll(async () => {
  const reach = await checkAtlasReachable();
  if (!reach.ok) {
    skip = true;
    skipReason = reach.reason;
    console.warn(`[integration] skipping: ${reach.reason}`);
    return;
  }
  env = readIntegrationEnv();
  if (!env) {
    skip = true;
    skipReason = "integration env missing";
    return;
  }
  const port = await pickEphemeralPort();
  server = await startMymeServer({
    port,
    databaseUrl: env.databaseUrl,
    electricUrl: env.electricUrl,
    salt: env.salt,
  });
});

afterAll(async () => {
  if (server) await server.stop();
});

describe("integration harness smoke", () => {
  it("server responds to /openapi.json", async () => {
    if (skip) {
      console.warn(`[integration] skipping: ${skipReason}`);
      return;
    }
    if (!server) throw new Error("server did not start");
    const res = await fetch(`${server.url}/openapi.json`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { openapi: string };
    expect(typeof body.openapi).toBe("string");
  });

  it("admin key authenticates against /items", async () => {
    if (skip || !server || !env) {
      console.warn(`[integration] skipping: ${skipReason}`);
      return;
    }
    const res = await fetch(`${server.url}/items?limit=1`, {
      headers: { Authorization: `Bearer ${env.apiKey}` },
    });
    expect(res.ok).toBe(true);
  });
});
