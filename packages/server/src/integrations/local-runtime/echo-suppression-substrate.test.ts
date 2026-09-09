/**
 * Echo suppression, proven through the substrate rather than in isolation.
 *
 * The property: an integration that writes something out to another
 * service must not then read its own change back in and write it again.
 * Nothing has ever demonstrated that end to end. `echo-suppression.test.ts`
 * exercises the module against a bare map, which proves the arithmetic and
 * nothing about the substrate that has to carry it; `substrate-smoke.test.ts`
 * and `webhook-dispatch-race.test.ts` both construct echo suppression and
 * then never assert on it. Before this file, `shouldSkipReactive` — the half
 * that actually does the suppressing — was called by no test outside the
 * module's own unit suite.
 *
 * ## Why it lives here and not in conformance
 *
 * Two reasons, either fatal alone. Handler code cannot be installed over
 * HTTP: registrations are discovered from the server's own filesystem at
 * boot. And no runtime credential's key material is obtainable over HTTP —
 * the reachable mint generates a key, hashes it and discards the plaintext.
 * A remote suite can read an echo marker, which is a different thing from
 * controlling the timing that makes reading one mean anything.
 *
 * ## The clock is the test's, deliberately
 *
 * The reference `echo_ttl_seconds` and `lag_window_seconds` are both 60,
 * which is longer than this suite's whole timeout, so a test that waited
 * for a marker to expire could not be written. `createEchoSuppression`
 * takes its clock as a third argument, so each dispatch here supplies its
 * own and the interesting instants are chosen rather than waited for.
 *
 * ## What "the upstream" is
 *
 * A `Map` the handler closes over. There is no HTTP layer between a
 * handler and its upstream in this substrate, and adding a fake one would
 * put the assertion behind a second thing that can break. What matters is
 * that the write is observable and that the sweep which follows sees it,
 * which a map gives exactly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, TEST_API_KEY_SALT } from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";
import {
  ConnectionClient,
  createActivitySink,
  createBudget,
  createCursorStore,
  createEchoSuppression,
  dispatchMessage,
  familyOnlyMappingResolver,
  registerItemEventHandler,
  registerScheduleHandler,
  _resetHandlers,
  ECHO_MARKER_PREFIX,
  SDK_DEFAULT_HOP_BUDGET,
  type ConnectionContext,
  type CursorStorageAdapter,
  type EchoSuppression,
} from "@withmarfa/runtime-sdk";
import { createSupervisor } from "./supervisor.js";
import { readConnectionRuntimeState } from "./pg-cursor-store.js";
import type {
  LocalIntegrationRegistration,
  LocalRuntime,
  WorkerDispatchRequest,
  WorkerDispatchResponse,
} from "./types.js";
import type { PgBoss } from "pg-boss";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const MANIFEST = {
  name: "test/echo-substrate",
  version: "0.0.1",
  publisher: "test",
  description: "Bidirectional test integration for the local runtime",
  manifest_schema_version: "2.0.0",
  direction: "bidirectional" as const,
  target_types: ["core.note"] as const,
  triggers: [
    { type: "schedule" as const, config: { cron: "*/5 * * * *" } },
    { type: "item-event" as const, config: {} },
  ],
  bidirectional_handling: {
    echo_ttl_seconds: 60,
    lag_window_seconds: 60,
    tombstone_mapping: "state-trashed" as const,
    partial_write_mode: "all-or-nothing" as const,
  },
  oauth_requirements: {} as Record<string, never>,
  webhook_verification: { method: "hmac-sha256" as const },
  permissions: {
    extension: { "connection.runtime": "write" as const },
  },
};

const ECHO_CONFIG = { echo_ttl_seconds: 60, lag_window_seconds: 60 };

/* -------------------------------------------------------------------------
 * The world
 * ---------------------------------------------------------------------- */

/** The same in-memory adapter the worker thread builds, so a dispatch here
 *  takes the shape a real one does without spawning a thread. */
function inMemoryCursor(snapshot: Record<string, unknown>): {
  cursorAdapter: CursorStorageAdapter;
  updates: Record<string, unknown>;
  deletes: Set<string>;
} {
  const live = new Map<string, unknown>(Object.entries(snapshot));
  const updates: Record<string, unknown> = {};
  const deletes = new Set<string>();
  const cursorAdapter: CursorStorageAdapter = {
    get(key) {
      return Promise.resolve(live.get(key) ?? null);
    },
    put(key, value) {
      live.set(key, value);
      updates[key] = value;
      deletes.delete(key);
      return Promise.resolve();
    },
    delete(key) {
      const had = live.has(key);
      live.delete(key);
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- cursor keys are integration-supplied on a value-typed Record
      delete updates[key];
      deletes.add(key);
      return Promise.resolve(had);
    },
  };
  return { cursorAdapter, updates, deletes };
}

async function createIntegrationItem(): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: MANIFEST.name,
        manifest_version: MANIFEST.version,
        publisher: MANIFEST.publisher,
        manifest: MANIFEST,
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  return item.id;
}

async function createActiveConnection(
  integrationItemId: string,
): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        integration_ref: integrationItemId,
        granted_at: new Date().toISOString(),
      },
    },
    ctx.spaceId,
  );
  return item.id;
}

/**
 * One dispatch's worth of handler body, with the pieces a bidirectional
 * integration actually touches handed in.
 *
 * `echo` is built per dispatch from the clock the caller chose, which is
 * the whole point: the interesting instants in this file are a handler
 * running long enough that its own clock has fallen behind the moment its
 * writes commit.
 */
type Body = (input: {
  echo: EchoSuppression;
  ctx: ConnectionContext;
}) => Promise<void>;

/**
 * A registration whose dispatch runs `body` under a clock the test picks.
 *
 * The handler is registered through the SDK registry and driven through
 * `dispatchMessage`, so the message reaches it by the same route the worker
 * thread uses. A handler wired up directly would prove the body works and
 * say nothing about whether a message can get to it.
 */
function registrationRunning(
  kind: "schedule" | "item-event",
  body: Body,
  clock: () => number,
  onRun?: () => void,
): LocalIntegrationRegistration {
  return {
    name: MANIFEST.name,
    handlerModulePath: null,
    directDispatch: async (request: WorkerDispatchRequest) => {
      const { cursorAdapter, updates, deletes } = inMemoryCursor(
        request.cursorSnapshot,
      );
      const client = new ConnectionClient({
        apiUrl: request.apiUrl,
        credential: request.credential,
        refreshCredential: () => Promise.resolve(request.credential),
      });
      const echo = createEchoSuppression(cursorAdapter, request.echo, clock);
      const connectionContext: ConnectionContext = {
        connection_id: request.message.connection_id,
        integration_name: request.message.integration_name,
        ...(request.message.space_id !== undefined && {
          space_id: request.message.space_id,
        }),
        marfa: client,
        cursor: createCursorStore(cursorAdapter),
        activity: createActivitySink(client, request.message.connection_id),
        echo,
        mapping: familyOnlyMappingResolver(),
        cycle: null,
        budget: createBudget({
          startedAtMs: request.startedAtMs,
          softLimitMs: request.softLimitMs,
        }).budget,
      };
      _resetHandlers();
      const run = async (): Promise<{ ok: true; done: true }> => {
        onRun?.();
        await body({ echo, ctx: connectionContext });
        return { ok: true, done: true };
      };
      if (kind === "schedule") registerScheduleHandler(run);
      else registerItemEventHandler(run);
      const result = await dispatchMessage(connectionContext, request.message);
      const response: WorkerDispatchResponse = {
        result,
        cursorUpdates: updates,
        cursorDeletes: Array.from(deletes),
        threw: false,
      };
      return response;
    },
    scheduleCron: "*/5 * * * *",
    echo: ECHO_CONFIG,
    triggerKinds: new Set([kind]),
    manifest: MANIFEST,
  } as unknown as LocalIntegrationRegistration;
}

function runtimeFor(
  registration: LocalIntegrationRegistration,
  boss: PgBoss | null = null,
): LocalRuntime {
  return createSupervisor(ctx.storage, {
    apiUrl: "http://test.local",
    apiKeySalt: TEST_API_KEY_SALT,
    authMode: "keys" as const,
    registrations: [registration],
    executor: {
      dispatch: (reg, request) => reg.directDispatch!(request),
      terminate: () => Promise.resolve(),
    },
    boss,
  });
}

function itemEventEnvelope(
  connectionId: string,
  hopCount = 0,
): Parameters<LocalRuntime["dispatchForTest"]>[0] {
  return {
    integration_name: MANIFEST.name,
    message: {
      kind: "item-event",
      integration_name: MANIFEST.name,
      connection_id: connectionId,
      event_type: "item.created",
      item_id: "item_echo",
      cycle: {
        originating_connection_id: connectionId,
        hop_count: hopCount,
      },
      payload: { item: {}, metadata: {} },
    },
  };
}

function scheduleEnvelope(
  connectionId: string,
): Parameters<LocalRuntime["dispatchForTest"]>[0] {
  return {
    integration_name: MANIFEST.name,
    message: {
      kind: "schedule",
      integration_name: MANIFEST.name,
      connection_id: connectionId,
      scheduled_for_ms: Date.now(),
    },
  };
}

/** What the external service holds, keyed by its own id. */
type Upstream = Map<string, string>;

/** The sweep a bidirectional integration runs: read the upstream, and
 *  write in anything that is not this connection's own echo. */
function inboundSweep(upstream: Upstream, wroteIn: string[]): Body {
  return async ({ echo }) => {
    for (const [externalId, contentHash] of upstream) {
      if (await echo.shouldSkipReactive(externalId, contentHash)) continue;
      wroteIn.push(externalId);
    }
  };
}

/** The outbound half: push to the upstream and leave the note that stops
 *  the next sweep reading it back. */
function outboundWrite(
  upstream: Upstream,
  externalId: string,
  contentHash: string,
): Body {
  return async ({ echo }) => {
    upstream.set(externalId, contentHash);
    await echo.trackOutboundWrite(externalId, contentHash);
  };
}

/* -------------------------------------------------------------------------
 * The tests
 * ---------------------------------------------------------------------- */

describe("echo suppression through the substrate", () => {
  it("delivers an item event to a registered handler, whose write reaches the upstream", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);
    const upstream: Upstream = new Map();
    let ran = 0;

    const result = await runtimeFor(
      registrationRunning(
        "item-event",
        outboundWrite(upstream, "ext_1", "hash_a"),
        () => Date.now(),
        () => ran++,
      ),
    ).dispatchForTest(itemEventEnvelope(connectionId));

    expect(result.ok).toBe(true);
    // The handler ran, rather than the dispatch merely not failing. An
    // acked message that reached nothing looks identical from outside.
    expect(ran).toBe(1);
    expect(upstream.get("ext_1")).toBe("hash_a");

    // And the note it left is committed connection state, not something
    // that lived only inside the dispatch.
    const state = await readConnectionRuntimeState(ctx.storage, connectionId);
    expect(state.cursors[`${ECHO_MARKER_PREFIX}ext_1`]).toBeDefined();
  });

  it("does not read an outbound write back in on the sweep that follows", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);
    const upstream: Upstream = new Map();
    const wroteIn: string[] = [];

    await runtimeFor(
      registrationRunning(
        "item-event",
        outboundWrite(upstream, "ext_2", "hash_b"),
        () => Date.now(),
      ),
    ).dispatchForTest(itemEventEnvelope(connectionId));

    await runtimeFor(
      registrationRunning("schedule", inboundSweep(upstream, wroteIn), () =>
        Date.now(),
      ),
    ).dispatchForTest(scheduleEnvelope(connectionId));

    // The sweep saw the upstream record — it is in the map — and declined
    // to write it in. That is the whole property.
    expect(upstream.get("ext_2")).toBe("hash_b");
    expect(wroteIn).toEqual([]);
  });

  it("writes in an upstream change the connection did not make", async () => {
    // The control, and the reason the assertion above is not vacuous. A
    // suppression that swallowed everything would pass that test and be
    // the worst possible defect: an integration that silently stops
    // syncing. Same sweep, same connection, a record it never wrote.
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);
    const upstream: Upstream = new Map([["ext_theirs", "hash_theirs"]]);
    const wroteIn: string[] = [];

    await runtimeFor(
      registrationRunning("schedule", inboundSweep(upstream, wroteIn), () =>
        Date.now(),
      ),
    ).dispatchForTest(scheduleEnvelope(connectionId));

    expect(wroteIn).toEqual(["ext_theirs"]);
  });

  it("writes in a later upstream edit of a record it wrote itself", async () => {
    // The suppression is on one version of a record, not on the record.
    // Somebody editing upstream afterwards produces the same external id
    // with different content, and that is a change the connection has to
    // take. A guard that matched on the id alone would swallow it, and the
    // symptom is the worst kind: an integration that keeps running and
    // silently stops syncing anything it has ever touched.
    //
    // This exists because a mutation found it. Suppressing whenever a
    // marker existed, ignoring the hash, left every other test in this
    // file green — including the control above, which has no marker at all
    // and so never reaches the comparison.
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);
    const upstream: Upstream = new Map();
    const wroteIn: string[] = [];

    await runtimeFor(
      registrationRunning(
        "item-event",
        outboundWrite(upstream, "ext_5", "hash_mine"),
        () => Date.now(),
      ),
    ).dispatchForTest(itemEventEnvelope(connectionId));

    // Somebody else edits the same record upstream.
    upstream.set("ext_5", "hash_theirs");

    await runtimeFor(
      registrationRunning("schedule", inboundSweep(upstream, wroteIn), () =>
        Date.now(),
      ),
    ).dispatchForTest(scheduleEnvelope(connectionId));

    expect(wroteIn).toEqual(["ext_5"]);
  });

  it("suppresses a read in a later slice, from a marker written on a clock that had fallen behind", async () => {
    // The case chunking creates, and the one with the least margin.
    //
    // A worker's writes are invisible until its dispatch returns, so a
    // marker stamped from the handler's own clock is stamped before the
    // moment it commits. A slice that runs long enough stamps one that is
    // already expired when it lands, and the next slice's read then finds
    // it expired, DELETES it, and writes the record back in — losing the
    // suppression and the evidence together.
    //
    // The clock here is an hour behind, which is the shape of a long run
    // and gives the assertion a gap it can see; a marker a few
    // milliseconds stale would pass whether or not anything rebased it.
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);
    const upstream: Upstream = new Map();
    const wroteIn: string[] = [];
    const anHourAgo = Date.now() - 60 * 60_000;

    // Slice one: the outbound write, on the lagging clock.
    await runtimeFor(
      registrationRunning(
        "schedule",
        outboundWrite(upstream, "ext_3", "hash_c"),
        () => anHourAgo,
      ),
    ).dispatchForTest(scheduleEnvelope(connectionId));

    // Slice two: a fresh dispatch reading the committed state, on the
    // real clock. This is where a marker carrying the handler's own
    // stamp would already be expired.
    await runtimeFor(
      registrationRunning("schedule", inboundSweep(upstream, wroteIn), () =>
        Date.now(),
      ),
    ).dispatchForTest(scheduleEnvelope(connectionId));

    expect(wroteIn).toEqual([]);

    // And the marker survived the read rather than being swept as
    // expired, which is what makes a third slice safe too.
    const state = await readConnectionRuntimeState(ctx.storage, connectionId);
    expect(state.cursors[`${ECHO_MARKER_PREFIX}ext_3`]).toBeDefined();
  });

  it("stops a cycle at the hop budget, where echo suppression would not have", async () => {
    // The two guards answer different failures and the difference matters.
    // Echo suppression stops a connection reading back what it just wrote;
    // it says nothing about two connections writing to each other, because
    // neither one's marker names the other's content. The hop budget is
    // what ends that, and it ends it before the handler is reached at all
    // — so a handler that would have written outbound never gets to.
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);
    const upstream: Upstream = new Map();
    let ran = 0;

    const runtime = runtimeFor(
      registrationRunning(
        "item-event",
        outboundWrite(upstream, "ext_4", "hash_d"),
        () => Date.now(),
        () => ran++,
      ),
    );

    // Under the budget: the handler runs and the cycle continues.
    const under = await runtime.dispatchForTest(
      itemEventEnvelope(connectionId, SDK_DEFAULT_HOP_BUDGET - 1),
    );
    expect(under.ok).toBe(true);
    expect(ran).toBe(1);

    // At the budget: acked, and the handler is not reached. No echo
    // marker could have stopped this one — the content is new and this
    // connection never wrote it.
    const at = await runtime.dispatchForTest(
      itemEventEnvelope(connectionId, SDK_DEFAULT_HOP_BUDGET),
    );
    expect(at.ok).toBe(true);
    expect(ran).toBe(1);
  });
});
