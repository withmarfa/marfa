import { describe, expect, it, afterEach } from "vitest";
import { MymeSyncClient } from "../../src/client.js";

const clients: MymeSyncClient[] = [];

afterEach(async () => {
  while (clients.length > 0) {
    const c = clients.pop();
    if (c) await c.stop();
  }
});

function makeClient(): MymeSyncClient {
  const client = new MymeSyncClient({
    apiUrl: "http://localhost:0",
    apiKey: "myme_k1_test",
    storage: "memory",
    // Bootstrap tests don't exercise the network — the engine would
    // try to hit a closed port and surface a `sync.failed` event we
    // don't care about here.
    autoStartSync: false,
  });
  clients.push(client);
  return client;
}

describe("MymeSyncClient bootstrap", () => {
  it("constructs without start (no PGlite spin-up yet)", () => {
    const client = makeClient();
    expect(client.syncState.state).toBe("starting");
  });

  it("start() resolves and sets state to idle", async () => {
    const client = makeClient();
    await client.start();
    expect(client.syncState.state).toBe("idle");
  });

  it("start() is idempotent", async () => {
    const client = makeClient();
    await client.start();
    await client.start();
    expect(client.syncState.state).toBe("idle");
  });

  it("creates the local schema (items / edges / metadata + local-only tables)", async () => {
    const client = makeClient();
    await client.start();
    const result = await client.db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
       ORDER BY table_name`,
    );
    const names = result.rows.map((r) => r.table_name);
    expect(names).toContain("items");
    expect(names).toContain("edges");
    expect(names).toContain("metadata");
    expect(names).toContain("_myme_mutation_queue");
    expect(names).toContain("_myme_sync_state");
    expect(names).toContain("_myme_schema_meta");
  });

  it("stamps schema version into _myme_schema_meta", async () => {
    const client = makeClient();
    await client.start();
    const result = await client.db.query<{ value: string }>(
      `SELECT value FROM _myme_schema_meta WHERE key = 'pglite_schema_v'`,
    );
    expect(result.rows[0]?.value).toBe("1");
  });

  it("hasPendingMutations is false on a fresh DB", async () => {
    const client = makeClient();
    await client.start();
    expect(await client.hasPendingMutations()).toBe(false);
    expect(await client.pendingMutationCount()).toBe(0);
  });

  it("emits sync.started after start", async () => {
    const client = makeClient();
    let startedAt: Date | null = null;
    client.on("sync.started", (p) => {
      startedAt = p.at;
    });
    await client.start();
    expect(startedAt).not.toBeNull();
  });

  it("syncUrl falls back to apiUrl + /sync", () => {
    const client = makeClient();
    expect(client.syncUrl).toBe("http://localhost:0/sync");
  });

  it("items API is unavailable before start()", () => {
    const client = makeClient();
    expect(() => client.items).toThrow(/start/);
  });

  it("items API is available after start()", async () => {
    const client = makeClient();
    await client.start();
    expect(client.items).toBeDefined();
    expect(typeof client.items.create).toBe("function");
  });
});
