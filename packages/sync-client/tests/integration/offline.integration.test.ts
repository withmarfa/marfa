import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import {
  makeIntegrationClient,
  waitFor,
} from "./helpers/sync-client.js";
import { createTestContext, type TestContext } from "./helpers/cleanup.js";
import type { MymeSyncClient } from "../../src/client.js";

/**
 * Offline / reconnect integration tests. Each test owns its server
 * lifecycle (start → stop → optionally restart on the same port) so
 * the kill-and-revive scenarios are clean. The file-level beforeAll
 * only resolves Atlas reachability + env; per-test setup spins up
 * the ephemeral server.
 *
 * Note: the v0.1 sync engine does NOT transition `syncState.state`
 * to `'offline'` when pglite-sync's upstream is unreachable — it
 * emits `sync.failed` and stays in the prior state. The
 * `idle → offline → syncing → idle` flow the original plan
 * envisaged is a v0.2 follow-up; these tests assert the
 * observable v0.1 contract instead (reads keep working from local
 * PGlite, writes queue durably and drain on reconnect, attempt
 * counts climb through transient errors).
 */

let env: IntegrationEnv | null = null;
let skip = false;
let skipReason = "";

const clients: MymeSyncClient[] = [];
const servers: SpawnedServer[] = [];
let ctx: TestContext | null = null;

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
  }
});

afterEach(async () => {
  // Clients first — drain may still hold a fetch handle to the
  // server we're about to kill.
  while (clients.length > 0) {
    const c = clients.pop();
    if (c) {
      try {
        await c.stop();
      } catch {
        // best-effort
      }
    }
  }
  while (servers.length > 0) {
    const s = servers.pop();
    if (s) await s.stop();
  }
  if (ctx) await ctx.cleanup();
});

afterAll(async () => {
  // Last-ditch sweep in case a test leaked a server.
  while (servers.length > 0) {
    const s = servers.pop();
    if (s) await s.stop();
  }
});

interface Gate {
  env: IntegrationEnv;
}

function gate(): Gate | null {
  if (skip || !env) {
    console.warn(`[integration] skipping: ${skipReason || "preconditions unmet"}`);
    return null;
  }
  return { env };
}

async function startServerOn(
  port: number,
  e: IntegrationEnv,
): Promise<SpawnedServer> {
  const server = await startMymeServer({
    port,
    databaseUrl: e.databaseUrl,
    electricUrl: e.electricUrl,
    salt: e.salt,
  });
  servers.push(server);
  return server;
}

describe("offline / reconnect — read path", () => {
  it("reads survive server kill — local PGlite serves them", async () => {
    const g = gate();
    if (!g) return;

    const port = await pickEphemeralPort();
    const server = await startServerOn(port, g.env);
    ctx = createTestContext({ apiUrl: server.url, apiKey: g.env.apiKey });

    // Pre-seed a row so the local store has content after settle.
    const { MymeClient } = await import("@mymehq/sdk");
    const sdk = new MymeClient({ url: server.url, apiKey: g.env.apiKey });
    const seed = await sdk.items.create({
      type: "core.note",
      properties: { body: "offline-read-seed" },
    });
    ctx.trackItem(seed.id);

    const client = await makeIntegrationClient({
      apiUrl: server.url,
      apiKey: g.env.apiKey,
    });
    clients.push(client);

    await waitFor(
      async () => await client.items.get(seed.id),
      { timeoutMs: 10_000, description: "seed row visible locally" },
    );

    // Kill the server. Reads must keep working: they go through
    // PGlite via the optimistic-overlay merge; neither path
    // requires the network.
    await server.stop();
    // Drop the stopped server from the list so afterEach doesn't
    // try to stop it again.
    servers.length = 0;

    const stillThere = await client.items.get(seed.id);
    expect(stillThere?.id).toBe(seed.id);

    const list = await client.items.list({ type: "core.note", limit: 100 });
    expect(list.find((i) => i.id === seed.id)).toBeDefined();
  });
});

describe("offline / reconnect — write path", () => {
  it("writes queue durably while server is down and drain on reconnect", async () => {
    const g = gate();
    if (!g) return;

    const port = await pickEphemeralPort();
    const server = await startServerOn(port, g.env);
    ctx = createTestContext({ apiUrl: server.url, apiKey: g.env.apiKey });

    const client = await makeIntegrationClient({
      apiUrl: server.url,
      apiKey: g.env.apiKey,
    });
    clients.push(client);

    await waitFor(() => client.syncState.state === "idle", {
      timeoutMs: 10_000,
      description: "engine idle",
    });

    // Kill the server.
    await server.stop();
    servers.length = 0;

    // While offline: optimistic create succeeds locally and
    // accumulates in the durable queue. The drain loop's first
    // attempt to send fails and the row stays pending (transient,
    // attempt_count climbs). We don't assert specific timing — just
    // the non-zero pending count and the eventual drain on
    // reconnect.
    const offlineCreated = await client.items.create({
      type: "core.note",
      properties: { body: "queued-while-offline" },
    });
    ctx.trackItem(offlineCreated.id);
    expect(await client.pendingMutationCount()).toBe(1);

    // Confirm the optimistic apply is visible locally even though
    // the canonical row never landed.
    const local = await client.items.get(offlineCreated.id);
    expect(local?.id).toBe(offlineCreated.id);

    // Bring the server back on the same port. The drain's next tick
    // will succeed once the server accepts requests. We give the
    // OS a moment to release the port; pickEphemeralPort grabbed
    // it cleanly to begin with so re-binding is generally fine.
    const restarted = await startServerOn(port, g.env);

    await waitFor(
      async () =>
        ((await client.pendingMutationCount()) === 0 ? "drained" : null),
      { timeoutMs: 30_000, description: "queue drains after reconnect" },
    );

    // Server has the row.
    const { MymeClient } = await import("@mymehq/sdk");
    const sdk = new MymeClient({ url: restarted.url, apiKey: g.env.apiKey });
    const onServer = await sdk.items.get(offlineCreated.id);
    expect(onServer.id).toBe(offlineCreated.id);
    expect((onServer.properties as { body?: string }).body).toBe(
      "queued-while-offline",
    );
  });

  it("transient failures grow attempt_count (backoff observable)", async () => {
    const g = gate();
    if (!g) return;

    // Strategy: start the server so the client minted an SDK with
    // a working URL, then kill it before any writes. The drain's
    // attempts will fail with `ECONNREFUSED` (transient — not in
    // PERMANENT_STATUSES). attempt_count climbs in the queue row;
    // we observe by reading PGlite.
    const port = await pickEphemeralPort();
    const server = await startServerOn(port, g.env);
    ctx = createTestContext({ apiUrl: server.url, apiKey: g.env.apiKey });

    const client = await makeIntegrationClient({
      apiUrl: server.url,
      apiKey: g.env.apiKey,
    });
    clients.push(client);
    await waitFor(() => client.syncState.state === "idle", {
      timeoutMs: 10_000,
      description: "engine idle",
    });

    await server.stop();
    servers.length = 0;

    const created = await client.items.create({
      type: "core.note",
      properties: { body: "backoff-probe" },
    });
    ctx.trackItem(created.id);

    // Wait until attempt_count climbs — the drain loop spaces out
    // attempts via nextReconnectDelay (1s base + jitter), so 3
    // attempts take ~3-15s.
    const attemptCount = await waitFor(
      async () => {
        const r = await client.db.query<{ n: number }>(
          `SELECT attempt_count AS n FROM _myme_mutation_queue
            WHERE write_id IS NOT NULL
            ORDER BY created_at DESC
            LIMIT 1`,
        );
        const n = r.rows[0]?.n ?? 0;
        return n >= 2 ? n : null;
      },
      {
        timeoutMs: 25_000,
        description: "drain accumulated >= 2 transient failures",
      },
    );
    expect(attemptCount).toBeGreaterThanOrEqual(2);

    // The mutation is still in the queue (transient → never
    // dropped). When we end the test, afterEach stops the client
    // gracefully; the mutation is lost (it lives in PGlite which
    // is in-memory). That's the contract for `storage: 'memory'`.
    expect(await client.pendingMutationCount()).toBeGreaterThan(0);
  });
});
