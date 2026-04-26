import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
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
import type { SyncEventMap } from "../../src/events/types.js";

/**
 * Write-path integration tests. The round-trip is:
 *
 *   client.items.create()
 *     → optimistic apply (in-memory or PGlite, depending on which
 *       Bug 2 strategy is in play)
 *     → queue.enqueue()
 *     → drain → SDK → server.POST /items
 *     → server persists; Electric reads the WAL change
 *     → /sync/shapes/items proxy streams the row down
 *     → @electric-sql/pglite-sync inserts the row into local PGlite
 *
 * **Bug 2 reproduction:** before the fix, the optimistic create
 * writes the row directly into PGlite. When Electric replays the
 * server-confirmed row, pglite-sync's plain INSERT collides with
 * the optimistic row on the primary key. Postgres throws
 * `23505 items_pkey`; the engine emits `sync.failed`. The test
 * asserts the post-fix end state (queue drains, both stores hold
 * exactly one row, no items_pkey error surfaced) — before the fix
 * it fails specifically with that 23505 error captured.
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

/**
 * Capture process-level unhandled rejections during the test. Bug 2's
 * primary symptom is that `@electric-sql/pglite-sync` throws inside
 * its WASM async path on a primary-key collision; the throw escapes
 * its `onError` callback and surfaces as a process-level unhandled
 * rejection. Vitest treats these as warnings, not test failures, so
 * without an explicit hook a Bug 2 regression would silently appear
 * as "test passed but Vitest exited 1." This hook gives us a
 * deterministic per-test list to assert on.
 */
const unhandledRejections: unknown[] = [];
const captureUnhandled = (reason: unknown) => {
  unhandledRejections.push(reason);
};

beforeEach(() => {
  unhandledRejections.length = 0;
  process.on("unhandledRejection", captureUnhandled);
});

afterEach(async () => {
  process.off("unhandledRejection", captureUnhandled);
  while (clients.length > 0) {
    const c = clients.pop();
    if (c) await c.stop();
  }
  if (ctx) await ctx.cleanup();
});

function unhandledMatching(re: RegExp): unknown[] {
  return unhandledRejections.filter((r) => {
    const text = formatRejection(r);
    return re.test(text);
  });
}

function formatRejection(r: unknown): string {
  if (r instanceof Error) return `${r.name}: ${r.message}`;
  if (typeof r === "object" && r !== null) {
    return JSON.stringify(r, Object.getOwnPropertyNames(r));
  }
  return String(r);
}

afterAll(async () => {
  if (server) await server.stop();
});

interface Gate {
  server: SpawnedServer;
  env: IntegrationEnv;
  sdk: MymeClient;
  ctx: TestContext;
}

function gate(): Gate | null {
  if (skip || !server || !env || !sdk || !ctx) {
    console.warn(`[integration] skipping: ${skipReason || "preconditions unmet"}`);
    return null;
  }
  return { server, env, sdk, ctx };
}

/**
 * Subscribe to sync.failed events and capture them. The captured
 * payloads surface in the assertion error message so a failing test
 * names the underlying engine error (e.g., 23505 items_pkey) instead
 * of leaving the reader to guess.
 */
function captureSyncFailures(client: MymeSyncClient): {
  events: SyncEventMap["sync.failed"][];
  format: () => string;
  unsubscribe: () => void;
} {
  const events: SyncEventMap["sync.failed"][] = [];
  const unsubscribe = client.on("sync.failed", (payload) => {
    events.push(payload);
  });
  return {
    events,
    unsubscribe,
    format: () =>
      events.length === 0
        ? "(no sync.failed events)"
        : events
            .map(
              (e) =>
                `[${e.at.toISOString()}] ${e.error.code}: ${e.error.message}`,
            )
            .join("\n"),
  };
}

/**
 * Likewise capture mutation.* events so a failing test can show what
 * the queue did before the engine errored out.
 */
function captureMutationEvents(client: MymeSyncClient): {
  rejected: SyncEventMap["mutation.rejected"][];
  confirmed: SyncEventMap["mutation.confirmed"][];
  unsubscribers: Array<() => void>;
} {
  const rejected: SyncEventMap["mutation.rejected"][] = [];
  const confirmed: SyncEventMap["mutation.confirmed"][] = [];
  return {
    rejected,
    confirmed,
    unsubscribers: [
      client.on("mutation.rejected", (p) => rejected.push(p)),
      client.on("mutation.confirmed", (p) => confirmed.push(p)),
    ],
  };
}

describe("write path — round-trip", () => {
  it("optimistic create round-trips and clears", async () => {
    const g = gate();
    if (!g) return;

    const client = await makeIntegrationClient({
      apiUrl: g.server.url,
      apiKey: g.env.apiKey,
    });
    clients.push(client);

    const failures = captureSyncFailures(client);
    const mutations = captureMutationEvents(client);

    await waitFor(() => client.syncState.state === "idle", {
      timeoutMs: 10_000,
      description: "engine reaches idle before issuing optimistic write",
    });

    const created = await client.items.create({
      type: "core.note",
      properties: { body: "round-trip" },
    });
    g.ctx.trackItem(created.id);
    expect(created.id).toBeDefined();

    // 1. Queue drains.
    await waitFor(
      async () => ((await client.pendingMutationCount()) === 0 ? "drained" : null),
      { timeoutMs: 10_000, description: "mutation queue drains" },
    );

    // 2. Server has the row.
    const serverRow = await g.sdk.items.get(created.id);
    expect(serverRow.id).toBe(created.id);
    expect((serverRow.properties as { body?: unknown }).body).toBe("round-trip");

    // 3. Local store has the row, exactly one.
    //    Wait for the Electric replay to land — even after queue
    //    drain the shape stream is still propagating.
    const localItem = await waitFor(
      async () => await client.items.get(created.id),
      { timeoutMs: 10_000, description: "Electric replay lands locally" },
    );
    expect(localItem.id).toBe(created.id);

    // 4. PGlite has exactly one row for that id.
    const localCount = (
      await client.db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM items WHERE id = $1`,
        [created.id],
      )
    ).rows[0]?.n;
    expect(localCount).toBe(1);

    // 5. **The Bug 2 assertion.** Two surfaces, both must be clean:
    //    (a) sync.failed events from the engine's onError callback;
    //    (b) process-level unhandled rejections — pglite-sync throws
    //        inside its WASM async path on primary-key collisions
    //        and the throw escapes `onError`. The unhandled-rejection
    //        hook in beforeEach captures these.
    //    Either surface populated with an items_pkey/23505 message
    //    means Bug 2 has resurfaced. The assertion message names the
    //    error so the reader doesn't have to chase the stack.
    const pkeyFailure = failures.events.find((e) =>
      /items_pkey|duplicate key|23505/i.test(e.error.message),
    );
    const pkeyUnhandled = unhandledMatching(/items_pkey|23505/i);
    expect(
      pkeyFailure,
      `Bug 2 sync.failed surface: optimistic write collided with Electric replay.\n` +
        `Captured sync.failed events:\n${failures.format()}\n` +
        `Captured mutation events: ${String(mutations.confirmed.length)} confirmed, ${String(mutations.rejected.length)} rejected.`,
    ).toBeUndefined();
    expect(
      pkeyUnhandled.length,
      `Bug 2 unhandled-rejection surface: pglite-sync threw on a primary-key collision.\n` +
        `Captured rejections:\n${pkeyUnhandled.map(formatRejection).join("\n")}`,
    ).toBe(0);

    failures.unsubscribe();
    for (const u of mutations.unsubscribers) u();
  });

  it("optimistic update round-trips", async () => {
    const g = gate();
    if (!g) return;

    const client = await makeIntegrationClient({
      apiUrl: g.server.url,
      apiKey: g.env.apiKey,
    });
    clients.push(client);

    await waitFor(() => client.syncState.state === "idle", {
      timeoutMs: 10_000,
      description: "engine idle",
    });

    const created = await client.items.create({
      type: "core.note",
      properties: { body: "before" },
    });
    g.ctx.trackItem(created.id);

    await waitFor(
      async () => ((await client.pendingMutationCount()) === 0 ? "drained" : null),
      { timeoutMs: 10_000, description: "create drains" },
    );
    // Wait for the Electric replay so the update operates on the
    // canonical row, not just the optimistic delta.
    await waitFor(
      async () => await client.items.get(created.id),
      { timeoutMs: 10_000, description: "create replay lands" },
    );

    await client.items.update(created.id, { body: "after" });

    await waitFor(
      async () => ((await client.pendingMutationCount()) === 0 ? "drained" : null),
      { timeoutMs: 10_000, description: "update drains" },
    );
    const updated = await waitFor(
      async () => {
        const item = await client.items.get(created.id);
        if (!item) return null;
        const body = (item.properties as { body?: string }).body;
        return body === "after" ? item : null;
      },
      { timeoutMs: 10_000, description: "update replay lands" },
    );
    expect((updated.properties as { body?: string }).body).toBe("after");

    const serverRow = await g.sdk.items.get(created.id);
    expect((serverRow.properties as { body?: string }).body).toBe("after");
  });

  it("4xx (404) surfaces mutation.rejected", async () => {
    const g = gate();
    if (!g) return;

    const client = await makeIntegrationClient({
      apiUrl: g.server.url,
      apiKey: g.env.apiKey,
    });
    clients.push(client);

    const mutations = captureMutationEvents(client);
    await waitFor(() => client.syncState.state === "idle", {
      timeoutMs: 10_000,
      description: "engine idle",
    });

    // Force a permanent 404 via deleteItem on a server-unknown id.
    // The drain loop's PERMANENT_STATUSES = {400, 403, 404} treats
    // 404 as non-retriable and emits mutation.rejected. We construct
    // the id directly (no preceding create) so the server has never
    // seen it and returns 404 on DELETE.
    const ghostId = uuidv7();
    await client.items.delete(ghostId);

    const rejection = await waitFor(
      () => mutations.rejected[0] ?? null,
      { timeoutMs: 10_000, description: "mutation.rejected fires" },
    );
    expect(rejection.kind).toBe("deleteItem");

    for (const u of mutations.unsubscribers) u();
  });
});

describe("write path — edges/metadata round-trip is deferred", () => {
  // The A-minimal Bug 2 fix only re-points items writes through the
  // OptimisticItemStore. Edges and metadata still write directly to
  // PGlite via api/edges.ts + api/metadata.ts and have the same
  // round-trip primary-key collision risk. v0.2 will extend the
  // OptimisticItemStore pattern to those tables; until then, the
  // round-trip assertion is intentionally skipped here.
  //
  // See packages/sync-client/CHANGELOG.md (0.1.0 entry) for the
  // exact deferred operations.

  it.skip("[deferred to v0.2] optimistic edges create round-trips and clears", () => {
    // No assertion. Skipped on purpose; CHANGELOG.md is canonical.
  });

  it.skip("[deferred to v0.2] optimistic metadata write round-trips and clears", () => {
    // No assertion. Skipped on purpose; CHANGELOG.md is canonical.
  });
});
