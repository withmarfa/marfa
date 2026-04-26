import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MymeClient } from "@mymehq/sdk";
import { uuidv7 } from "uuidv7";
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
 * Read-path integration tests. The sync-client subscribes to the
 * worktree's `/sync/shapes/:family` proxy, which forwards to Atlas
 * Electric. Server-side mutations stream back via Electric and land
 * in the local PGlite. These tests assert the round-trip from server
 * to local store works under representative conditions.
 *
 * Bug 2 (optimistic-write PK collision) does not affect read-only
 * tests — the local store is empty before each test, so the first
 * Electric replay is a clean insert. The writes integration test is
 * what exercises Bug 2.
 */

let server: SpawnedServer | null = null;
let env: IntegrationEnv | null = null;
let skip = false;
let skipReason = "";
let sdk: MymeClient | null = null;

const clients: MymeSyncClient[] = [];
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
    return;
  }
  const port = await pickEphemeralPort();
  server = await startMymeServer({
    port,
    databaseUrl: env.databaseUrl,
    electricUrl: env.electricUrl,
    salt: env.salt,
  });
  sdk = new MymeClient({ url: server.url, apiKey: env.apiKey });
  ctx = createTestContext({ apiUrl: server.url, apiKey: env.apiKey });
});

afterEach(async () => {
  while (clients.length > 0) {
    const c = clients.pop();
    if (c) await c.stop();
  }
  if (ctx) await ctx.cleanup();
});

afterAll(async () => {
  if (server) await server.stop();
});

function gate(): { server: SpawnedServer; env: IntegrationEnv; sdk: MymeClient; ctx: TestContext } | null {
  if (skip || !server || !env || !sdk || !ctx) {
    console.warn(`[integration] skipping: ${skipReason || "preconditions unmet"}`);
    return null;
  }
  return { server, env, sdk, ctx };
}

describe("sync engine — read path", () => {
  it("initial snapshot includes pre-existing rows the key can see", async () => {
    const g = gate();
    if (!g) return;

    // Seed a row before client.start so it's part of the initial
    // snapshot rather than a streaming update. Using a
    // sync-client-distinct source so other test runs / the live
    // mock-myme conformance don't accidentally collide on filter.
    const seedId = uuidv7();
    const seedSource = `sync-client-int-${seedId.slice(0, 8)}`;
    const created = await g.sdk.items.create({
      id: seedId,
      type: "core.note",
      properties: { body: "snapshot-seed" },
      source: seedSource,
    });
    g.ctx.trackItem(created.id);

    const client = await makeIntegrationClient({
      apiUrl: g.server.url,
      apiKey: g.env.apiKey,
    });
    clients.push(client);

    // Assert via `get(id)` — the row identity is the test target.
    // `list({source})` is not — it cuts in a filter that isn't part
    // of the read-path contract under test here.
    const found = await waitFor(
      async () => await client.items.get(seedId),
      { timeoutMs: 10_000, description: "seeded row appears in local store" },
    );
    expect(found.id).toBe(seedId);
    expect((found.properties as { body?: unknown }).body).toBe("snapshot-seed");
    // Note: server overrides `source` from the API key (here:
    // 'orchestrator-mbp'), not from the request body. The seedSource
    // variable is used only to keep test rows distinguishable from
    // other concurrent test runs in audit logs, not for assertions.
  });

  it("server-side create streams down via Electric", async () => {
    const g = gate();
    if (!g) return;

    const client = await makeIntegrationClient({
      apiUrl: g.server.url,
      apiKey: g.env.apiKey,
    });
    clients.push(client);

    // Wait for the engine to settle so we know the change we're
    // about to make is delivered through the *streaming* path, not
    // the snapshot path.
    await waitFor(() => client.syncState.state === "idle", {
      timeoutMs: 10_000,
      description: "sync state idle",
    });

    const id = uuidv7();
    const source = `sync-client-int-${id.slice(0, 8)}`;
    const created = await g.sdk.items.create({
      id,
      type: "core.note",
      properties: { body: "stream-create" },
      source,
    });
    g.ctx.trackItem(created.id);

    const found = await waitFor(
      async () => await client.items.get(id),
      { timeoutMs: 10_000, description: "streamed create lands locally" },
    );
    expect(found.id).toBe(id);
    expect((found.properties as { body?: unknown }).body).toBe("stream-create");
  });

  it("server-side update streams down", async () => {
    const g = gate();
    if (!g) return;

    const id = uuidv7();
    const source = `sync-client-int-${id.slice(0, 8)}`;
    const created = await g.sdk.items.create({
      id,
      type: "core.note",
      properties: { body: "before-update" },
      source,
    });
    g.ctx.trackItem(created.id);

    const client = await makeIntegrationClient({
      apiUrl: g.server.url,
      apiKey: g.env.apiKey,
    });
    clients.push(client);

    // Wait for the snapshot to land before issuing the update so the
    // assertion targets the streaming change-feed.
    await waitFor(
      async () => (await client.items.get(id)) !== null,
      { timeoutMs: 10_000, description: "seeded row visible locally" },
    );

    await g.sdk.items.update(id, { body: "after-update" }, {
      expectedVersion: created.version,
    });

    const updated = await waitFor(
      async () => {
        const item = await client.items.get(id);
        if (!item) return null;
        const body = (item.properties as { body?: string }).body;
        return body === "after-update" ? item : null;
      },
      { timeoutMs: 10_000, description: "streamed update lands locally" },
    );
    expect((updated.properties as { body?: string }).body).toBe("after-update");
  });

  it("server-side delete streams down — local list excludes trashed", async () => {
    const g = gate();
    if (!g) return;

    const id = uuidv7();
    const source = `sync-client-int-${id.slice(0, 8)}`;
    const created = await g.sdk.items.create({
      id,
      type: "core.note",
      properties: { body: "to-be-deleted" },
      source,
    });
    g.ctx.trackItem(created.id);

    const client = await makeIntegrationClient({
      apiUrl: g.server.url,
      apiKey: g.env.apiKey,
    });
    clients.push(client);

    await waitFor(
      async () => (await client.items.get(id)) !== null,
      { timeoutMs: 10_000, description: "seeded row visible locally" },
    );

    // Server-side delete trashes the item. The proxy's items shape
    // filter excludes `state = 'trashed'`, so Electric stops
    // replicating it; pglite-sync then deletes the local row.
    await g.sdk.items.delete(id);

    await waitFor(
      async () => ((await client.items.get(id)) === null ? "gone" : null),
      { timeoutMs: 10_000, description: "trashed row drops out of local store" },
    );
  });

  it("sync state transitions: starting → syncing → idle", async () => {
    const g = gate();
    if (!g) return;

    const transitions: string[] = [];
    const client = await makeIntegrationClient({
      apiUrl: g.server.url,
      apiKey: g.env.apiKey,
      autoStart: false,
    });
    clients.push(client);
    client.observeSyncState((info) => {
      // Only record state name changes, not every snapshot — the
      // observable fires with the same state on consumer subscribe.
      if (transitions[transitions.length - 1] !== info.state) {
        transitions.push(info.state);
      }
    });

    await client.start();
    await waitFor(() => client.syncState.state === "idle", {
      timeoutMs: 10_000,
      description: "engine reaches idle",
    });

    // The engine flips `syncing` immediately on start() and `idle`
    // when pglite-sync's onInitialSync fires. We don't pin the exact
    // sequence (pglite-sync may emit multiple syncing transitions),
    // only that the run started in `starting`, transitioned through
    // `syncing`, and ended in `idle`.
    expect(transitions[0]).toBe("starting");
    expect(transitions).toContain("syncing");
    expect(transitions[transitions.length - 1]).toBe("idle");
  });
});
