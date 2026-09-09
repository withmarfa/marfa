/**
 * Supervisor end-to-end (without spawning worker_threads) — exercises
 * the lock + cursor merge + activity emit path against a real
 * Postgres-backed test context using a `directDispatch` registration.
 *
 * The worker_thread boundary is covered separately — `executor.test.ts`
 * for the pool's spawn/error handling, `substrate-smoke.test.ts` for
 * loading a real compiled integration through it. This file focuses on
 * the substrate's other invariants:
 *
 *   - cursor snapshot → handler writes → applyCursorDelta merge
 *   - permanent failure → recent_errors tail entry + action_required
 *     activity row
 *   - hop-budget refusal for item-event messages
 *   - dispatch against a Connection whose runtime credential mints
 *     correctly via the in-process short-circuit
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";
import {
  registerScheduleHandler,
  _resetHandlers,
  SDK_DEFAULT_HOP_BUDGET,
  type ConnectionContext,
  type HandlerResult,
  type ScheduleMessage,
  familyOnlyMappingResolver,
  progressFingerprint,
} from "@withmarfa/runtime-sdk";
import { initEventLog, __resetCycleDetectionForTests } from "../../pubsub.js";
import type { Item } from "@withmarfa/shared";
import { createSupervisor, QUEUE_NAME } from "./supervisor.js";
import type { PgBoss } from "pg-boss";
import type {
  LocalIntegrationRegistration,
  LocalRuntime,
  SchedulerEnvelope,
  WorkerDispatchRequest,
  WorkerDispatchResponse,
} from "./types.js";
import {
  CONNECTION_RUNTIME_NAMESPACE,
  applyCursorDelta,
  readConnectionRuntimeState,
} from "./pg-cursor-store.js";
import { dispatchMessage } from "@withmarfa/runtime-sdk";
import {
  ConnectionClient,
  createActivitySink,
  createCursorStore,
  createBudget,
  createEchoSuppression,
  ECHO_MARKER_PREFIX,
  type CursorStorageAdapter,
  type SweepResult,
} from "@withmarfa/runtime-sdk";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const TEMPLATE_MANIFEST = {
  name: "test/local-runtime",
  version: "0.0.1",
  publisher: "test",
  description: "Test integration for the local runtime",
  manifest_schema_version: "2.0.0",
  direction: "read" as const,
  target_types: ["core.note"] as const,
  triggers: [{ type: "schedule" as const, config: { cron: "*/5 * * * *" } }],
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

interface InMemoryConnectionState {
  cursorAdapter: CursorStorageAdapter;
  updates: Record<string, unknown>;
  deletes: Set<string>;
}

/** Build the same in-memory cursor adapter the worker thread does, so
 *  the test's directDispatch can share the dispatch-shape with the
 *  worker-side flow without actually spawning a thread. */
function inMemoryCursor(
  snapshot: Record<string, unknown>,
): InMemoryConnectionState {
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
        manifest_name: TEMPLATE_MANIFEST.name,
        manifest_version: TEMPLATE_MANIFEST.version,
        publisher: TEMPLATE_MANIFEST.publisher,
        manifest: TEMPLATE_MANIFEST,
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );
  return item.id;
}

async function createActiveConnection(
  integrationItemId: string,
  properties: Record<string, unknown> = {},
): Promise<string> {
  const item = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        integration_ref: integrationItemId,
        granted_at: new Date().toISOString(),
        ...properties,
      },
    },
    ctx.spaceId,
  );
  return item.id;
}

function buildRegistration(
  handler: (
    ctxCtx: ConnectionContext,
    message: ScheduleMessage,
  ) => Promise<SweepResult>,
): LocalIntegrationRegistration {
  return {
    name: TEMPLATE_MANIFEST.name,
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
      const connectionContext: ConnectionContext = {
        connection_id: request.message.connection_id,
        integration_name: request.message.integration_name,
        ...(request.message.space_id !== undefined && {
          space_id: request.message.space_id,
        }),
        marfa: client,
        cursor: createCursorStore(cursorAdapter),
        activity: createActivitySink(client, request.message.connection_id),
        echo: createEchoSuppression(cursorAdapter, request.echo),
        mapping: familyOnlyMappingResolver(),
        cycle: null,
        // The real budget off the request's own numbers, not a stub that
        // never yields. A fixed `shouldYield: false` here would let a
        // handler's yield branch pass every test while never running.
        budget: createBudget({
          startedAtMs: request.startedAtMs,
          softLimitMs: request.softLimitMs,
        }).budget,
      };
      // Register and dispatch via the SDK registry so the same code
      // path the worker thread uses is exercised.
      _resetHandlers();
      registerScheduleHandler((c, m) => handler(c, m));
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
    echo: { echo_ttl_seconds: 60, lag_window_seconds: 60 },
    triggerKinds: new Set(["schedule"]),
  };
}

describe("local-runtime supervisor", () => {
  it("dispatches a schedule message, applies cursor delta, returns ok", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);

    const registration = buildRegistration(async (cContext) => {
      const previous = (await cContext.cursor.read("main")) as {
        run_count: number;
      } | null;
      const run_count = (previous?.run_count ?? 0) + 1;
      await cContext.cursor.write("main", { run_count });
      return { ok: true, done: true };
    });

    const runtime = createSupervisor(ctx.storage, {
      apiUrl: "http://test.local",
      apiKeySalt: TEST_API_KEY_SALT,
      authMode: "keys" as const,
      registrations: [registration],
      executor: {
        dispatch: (reg, request) => reg.directDispatch!(request),
        terminate: () => Promise.resolve(),
      },
      boss: null,
    });

    const result = await runtime.dispatchForTest({
      integration_name: TEMPLATE_MANIFEST.name,
      message: {
        kind: "schedule",
        integration_name: TEMPLATE_MANIFEST.name,
        connection_id: connectionId,
        scheduled_for_ms: Date.now(),
      },
    });
    expect(result.ok).toBe(true);

    const state = await readConnectionRuntimeState(ctx.storage, connectionId);
    expect(state.cursors).toEqual({ "cursor:main": { run_count: 1 } });

    // Second dispatch increments to 2, demonstrating the snapshot →
    // delta → merge cycle is read-back correctly.
    const result2 = await runtime.dispatchForTest({
      integration_name: TEMPLATE_MANIFEST.name,
      message: {
        kind: "schedule",
        integration_name: TEMPLATE_MANIFEST.name,
        connection_id: connectionId,
        scheduled_for_ms: Date.now(),
      },
    });
    expect(result2.ok).toBe(true);
    const state2 = await readConnectionRuntimeState(ctx.storage, connectionId);
    expect(state2.cursors).toEqual({ "cursor:main": { run_count: 2 } });
  });

  it("records a recent_errors entry on permanent failure", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);

    const registration = buildRegistration(() =>
      Promise.resolve({
        ok: false,
        retry: false,
        reason: "test_permanent_failure",
      }),
    );

    const runtime = createSupervisor(ctx.storage, {
      apiUrl: "http://test.local",
      apiKeySalt: TEST_API_KEY_SALT,
      authMode: "keys" as const,
      registrations: [registration],
      executor: {
        dispatch: (reg, request) => reg.directDispatch!(request),
        terminate: () => Promise.resolve(),
      },
      boss: null,
    });

    const result = await runtime.dispatchForTest({
      integration_name: TEMPLATE_MANIFEST.name,
      message: {
        kind: "schedule",
        integration_name: TEMPLATE_MANIFEST.name,
        connection_id: connectionId,
        scheduled_for_ms: Date.now(),
      },
    });
    expect(result.ok).toBe(false);

    const state = await readConnectionRuntimeState(ctx.storage, connectionId);
    expect(state.recent_errors.length).toBe(1);
    expect(state.recent_errors[0]?.reason).toBe("test_permanent_failure");
    expect(state.recent_errors[0]?.message_kind).toBe("schedule");

    // The operator-facing half. The tail entry is per-connection state; this
    // is the row a person actually sees, and it used to be written through a
    // credential minted outside the dispatch lock.
    const activity = await ctx.storage.items.list({ type: "system.activity" });
    const reported = activity.data.filter((item) => {
      const props = item.properties as {
        summary?: string;
        connection_id?: string;
        severity?: string;
      };
      return (
        props.connection_id === connectionId &&
        (props.summary ?? "").includes("Permanent failure")
      );
    });
    expect(reported).toHaveLength(1);
    expect((reported[0]?.properties as { severity?: string }).severity).toBe(
      "action_required",
    );
    expect(
      (reported[0]?.properties as { detail?: { reason?: string } }).detail
        ?.reason,
    ).toBe("test_permanent_failure");
  });

  it("retries a handler throw on the first delivery, terminal on a redelivery", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);

    // Shaped like the worker-entry response for a handler that threw:
    // a non-retryable result plus the `threw` flag. The supervisor is what
    // turns the first of those into a retry, matching the hosted consumer.
    const registration: LocalIntegrationRegistration = {
      name: TEMPLATE_MANIFEST.name,
      handlerModulePath: null,
      directDispatch: () =>
        Promise.resolve({
          result: {
            ok: false,
            retry: false,
            reason: "dispatch_threw: upstream blip",
          },
          cursorUpdates: {},
          cursorDeletes: [],
          threw: true,
          thrownMessage: "upstream blip",
          thrownClassName: "TypeError",
        } satisfies WorkerDispatchResponse),
      scheduleCron: "*/5 * * * *",
      echo: { echo_ttl_seconds: 60, lag_window_seconds: 60 },
      triggerKinds: new Set(["schedule"]),
    };

    const runtime = createSupervisor(ctx.storage, {
      apiUrl: "http://test.local",
      apiKeySalt: TEST_API_KEY_SALT,
      authMode: "keys" as const,
      registrations: [registration],
      executor: {
        dispatch: (reg, request) => reg.directDispatch!(request),
        terminate: () => Promise.resolve(),
      },
      boss: null,
    });

    const envelope = {
      integration_name: TEMPLATE_MANIFEST.name,
      message: {
        kind: "schedule" as const,
        integration_name: TEMPLATE_MANIFEST.name,
        connection_id: connectionId,
        scheduled_for_ms: Date.now(),
      },
    };

    const first = await runtime.dispatchForTest(envelope, 0);
    expect(first).toEqual({
      ok: false,
      retry: true,
      reason: "dispatch_threw: upstream blip",
    });
    const afterFirst = await readConnectionRuntimeState(
      ctx.storage,
      connectionId,
    );
    expect(afterFirst.recent_errors).toHaveLength(0);

    const second = await runtime.dispatchForTest(envelope, 1);
    expect(second).toEqual({
      ok: false,
      retry: false,
      reason: "dispatch_threw: upstream blip",
    });
    const afterSecond = await readConnectionRuntimeState(
      ctx.storage,
      connectionId,
    );
    expect(afterSecond.recent_errors).toHaveLength(1);
    expect(afterSecond.recent_errors[0]?.reason).toBe("upstream blip");
  });

  it("leaves a running dispatch's credential alone when an event is dropped", async () => {
    // The mint that starts a dispatch retires the connection's other
    // credentials, on the evidence that it holds `connection-dispatch:<id>`
    // and so nothing else can be running. The hop-budget row is written
    // before that lock is taken, and used to mint a credential of its own to
    // write through, which retired the one the dispatch below is holding.
    // The bearer gate refuses a revoked credential exactly as it refuses an
    // expired one, so the dispatch started taking 401s partway through with
    // nothing logged where the revocation happened.
    const integrationId = await createIntegrationItem();
    // Opted into feed surfacing, so the row this writes has to carry the
    // tier the route would have stamped on it.
    const connectionId = await createActiveConnection(integrationId, {
      feed_activity: true,
    });

    let held: string | undefined;
    // The registration needs the supervisor that the supervisor needs the
    // registration to build, so the handler reaches it through a holder
    // rather than closing over a binding that does not exist yet.
    const supervisor: { current?: LocalRuntime } = {};

    const registration: LocalIntegrationRegistration = {
      name: TEMPLATE_MANIFEST.name,
      handlerModulePath: null,
      directDispatch: async (dispatchRequest: WorkerDispatchRequest) => {
        held = dispatchRequest.credential.api_key;
        // An over-budget item event for the same connection, arriving while
        // this dispatch is mid-flight. It mints ahead of the lock, so it
        // does not wait on the dispatch that is running.
        await supervisor.current!.dispatchForTest({
          integration_name: TEMPLATE_MANIFEST.name,
          message: {
            kind: "item-event",
            integration_name: TEMPLATE_MANIFEST.name,
            connection_id: connectionId,
            event_type: "item.created",
            item_id: "item_out_of_band",
            cycle: {
              originating_connection_id: "other_conn",
              hop_count: SDK_DEFAULT_HOP_BUDGET,
            },
            payload: { item: {}, metadata: {} },
          },
        });
        const response: WorkerDispatchResponse = {
          result: { ok: true, done: true },
          cursorUpdates: {},
          cursorDeletes: [],
          threw: false,
        };
        return response;
      },
      echo: { echo_ttl_seconds: 60 },
      triggerKinds: new Set(["schedule", "item-event"]),
    };

    supervisor.current = createSupervisor(ctx.storage, {
      apiUrl: "http://test.local",
      apiKeySalt: TEST_API_KEY_SALT,
      authMode: "keys" as const,
      registrations: [registration],
      executor: {
        dispatch: (reg, dispatchRequest) =>
          reg.directDispatch!(dispatchRequest),
        terminate: () => Promise.resolve(),
      },
      boss: null,
    });

    const before = await ctx.storage.keys.countRuntimeCredentials(
      new Date().toISOString(),
    );

    const result = await supervisor.current.dispatchForTest({
      integration_name: TEMPLATE_MANIFEST.name,
      message: {
        kind: "schedule",
        integration_name: TEMPLATE_MANIFEST.name,
        connection_id: connectionId,
        scheduled_for_ms: Date.now(),
      },
    });
    expect(result.ok).toBe(true);
    expect(held).toBeDefined();

    const res = await request(ctx.app, "POST", "/items", {
      key: held,
      body: { type: "core.note", properties: { body: "written after" } },
    });
    expect(res.status).toBe(201);

    // The dropped event still gets recorded, which is also what proves the
    // path ran: it is best-effort and swallows its own failures, so without
    // this the case above would pass just as well against a boundary that
    // had gone quiet.
    const activity = await ctx.storage.items.list({ type: "system.activity" });
    const dropped = activity.data.filter((item) => {
      const props = item.properties as {
        summary?: string;
        connection_id?: string;
      };
      return (
        props.connection_id === connectionId &&
        (props.summary ?? "").includes("cycle hop budget")
      );
    });
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.tier).toBe("feed");

    // And it minted nothing to write it with. Counted rather than listed,
    // because `listByConnectionId` hides revoked rows: it answers one both
    // when the boundary minted nothing and when it minted a replacement and
    // revoked the credential the dispatch was holding, which is the defect.
    // `total` counts revoked rows precisely so accumulation is visible.
    const after = await ctx.storage.keys.countRuntimeCredentials(
      new Date().toISOString(),
    );
    expect(after.total).toBe(before.total + 1);
  });

  it("writes the row for a hosted connection whose message carries no space", async () => {
    // The space comes from the connection, not the message. A manual run
    // carries the caller's space, and the operator key has none, so keying
    // the hosted guard on the message would drop the row for an in-space
    // connection somebody ran by hand. The mint this replaced read the
    // connection.
    if (!ctx.storage.spaces) {
      throw new Error("spaces store missing, test pre-condition violated");
    }
    const space = await ctx.storage.spaces.create("supervisor-hosted-space");
    const integrationItem = await ctx.storage.items.create(
      {
        type: "system.integration",
        properties: {
          manifest_name: TEMPLATE_MANIFEST.name,
          manifest_version: TEMPLATE_MANIFEST.version,
          publisher: TEMPLATE_MANIFEST.publisher,
          manifest: TEMPLATE_MANIFEST,
          registered_at: new Date().toISOString(),
        },
      },
      space.id,
    );
    const connection = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "integration",
          status: "active",
          integration_ref: integrationItem.id,
          granted_at: new Date().toISOString(),
        },
      },
      space.id,
    );

    const registration: LocalIntegrationRegistration = {
      name: TEMPLATE_MANIFEST.name,
      handlerModulePath: null,
      directDispatch: () =>
        Promise.resolve({
          result: { ok: false, retry: false, reason: "hosted_failure" },
          cursorUpdates: {},
          cursorDeletes: [],
          threw: false,
        } as WorkerDispatchResponse),
      echo: { echo_ttl_seconds: 60 },
      triggerKinds: new Set(["schedule"]),
    };

    const runtime = createSupervisor(ctx.storage, {
      apiUrl: "http://test.local",
      apiKeySalt: TEST_API_KEY_SALT,
      authMode: "hosted" as const,
      registrations: [registration],
      executor: {
        dispatch: (reg, dispatchRequest) =>
          reg.directDispatch!(dispatchRequest),
        terminate: () => Promise.resolve(),
      },
      boss: null,
    });

    await runtime.dispatchForTest({
      integration_name: TEMPLATE_MANIFEST.name,
      message: {
        kind: "manual",
        integration_name: TEMPLATE_MANIFEST.name,
        connection_id: connection.id,
        requested_at_ms: Date.now(),
      },
    });

    const inSpace = await ctx.storage.items.list({
      spaceId: space.id,
      type: "system.activity",
    });
    const reported = inSpace.data.filter(
      (item) =>
        (item.properties as { connection_id?: string }).connection_id ===
        connection.id,
    );
    expect(reported).toHaveLength(1);
    expect(reported[0]?.space_id).toBe(space.id);
  });

  it("writes nothing for a connection that has no space", async () => {
    // A space-less credential is the operator tier, so the mint refuses one
    // in every mode. Such a connection cannot dispatch at all: the mint
    // throws before the handler runs. The two paths that reach the row
    // without minting are the hop-budget boundary, which runs before the
    // lock, and the dead-letter worker. This drives the first.
    //
    // Built inline rather than through `createActiveConnection`, which puts
    // a connection in the context's space like every other case here. The
    // absent space is the premise, so it has to be stated.
    const integrationId = await createIntegrationItem();
    const orphan = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "integration",
          status: "active",
          integration_ref: integrationId,
          granted_at: new Date().toISOString(),
        },
      },
      undefined,
    );
    const connectionId = orphan.id;

    let dispatched = 0;
    const registration: LocalIntegrationRegistration = {
      name: TEMPLATE_MANIFEST.name,
      handlerModulePath: null,
      directDispatch: () => {
        dispatched += 1;
        return Promise.resolve({
          result: { ok: true },
          cursorUpdates: {},
          cursorDeletes: [],
          threw: false,
        } as WorkerDispatchResponse);
      },
      echo: { echo_ttl_seconds: 60 },
      triggerKinds: new Set(["item-event"]),
    };

    const runtime = createSupervisor(ctx.storage, {
      apiUrl: "http://test.local",
      apiKeySalt: TEST_API_KEY_SALT,
      authMode: "hosted" as const,
      registrations: [registration],
      executor: {
        dispatch: (reg, dispatchRequest) =>
          reg.directDispatch!(dispatchRequest),
        terminate: () => Promise.resolve(),
      },
      boss: null,
    });

    const result = await runtime.dispatchForTest({
      integration_name: TEMPLATE_MANIFEST.name,
      message: {
        kind: "item-event",
        integration_name: TEMPLATE_MANIFEST.name,
        connection_id: connectionId,
        event_type: "item.created",
        item_id: "item_spaceless",
        cycle: {
          originating_connection_id: "other_conn",
          hop_count: SDK_DEFAULT_HOP_BUDGET,
        },
        payload: { item: {}, metadata: {} },
      },
    });
    expect(result.ok).toBe(true);
    expect(dispatched).toBe(0);

    const activity = await ctx.storage.items.list({ type: "system.activity" });
    expect(
      activity.data.filter(
        (item) =>
          (item.properties as { connection_id?: string }).connection_id ===
          connectionId,
      ),
    ).toHaveLength(0);
  });

  it("still retires the previous dispatch's credential on the next dispatch", async () => {
    // The control for the case above. Without it, that one would pass just
    // as well against a mint that had stopped superseding altogether.
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);

    const seen: string[] = [];
    const registration: LocalIntegrationRegistration = {
      name: TEMPLATE_MANIFEST.name,
      handlerModulePath: null,
      directDispatch: (dispatchRequest: WorkerDispatchRequest) => {
        seen.push(dispatchRequest.credential.api_key);
        const response: WorkerDispatchResponse = {
          result: { ok: true },
          cursorUpdates: {},
          cursorDeletes: [],
          threw: false,
        };
        return Promise.resolve(response);
      },
      echo: { echo_ttl_seconds: 60 },
      triggerKinds: new Set(["schedule"]),
    };

    const runtime = createSupervisor(ctx.storage, {
      apiUrl: "http://test.local",
      apiKeySalt: TEST_API_KEY_SALT,
      authMode: "keys" as const,
      registrations: [registration],
      executor: {
        dispatch: (reg, dispatchRequest) =>
          reg.directDispatch!(dispatchRequest),
        terminate: () => Promise.resolve(),
      },
      boss: null,
    });

    const envelope = {
      integration_name: TEMPLATE_MANIFEST.name,
      message: {
        kind: "schedule" as const,
        integration_name: TEMPLATE_MANIFEST.name,
        connection_id: connectionId,
        scheduled_for_ms: Date.now(),
      },
    };
    await runtime.dispatchForTest(envelope);
    await runtime.dispatchForTest(envelope);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);

    const refused = await request(ctx.app, "POST", "/items", {
      key: seen[0],
      body: { type: "core.note", properties: { body: "superseded" } },
    });
    expect(refused.status).toBe(401);

    // The second one works, so the 401 above is the supersede rather than
    // runtime credentials being broken outright.
    const accepted = await request(ctx.app, "POST", "/items", {
      key: seen[1],
      body: { type: "core.note", properties: { body: "current" } },
    });
    expect(accepted.status).toBe(201);
  });

  it("acks item-event messages that meet the hop budget without dispatching the handler", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);

    let dispatchCount = 0;
    const registration: LocalIntegrationRegistration = {
      name: TEMPLATE_MANIFEST.name,
      handlerModulePath: null,
      directDispatch: () => {
        dispatchCount++;
        return Promise.resolve({
          result: { ok: true },
          cursorUpdates: {},
          cursorDeletes: [],
          threw: false,
        });
      },
      echo: { echo_ttl_seconds: 60 },
      triggerKinds: new Set(["item-event"]),
    };

    const runtime = createSupervisor(ctx.storage, {
      apiUrl: "http://test.local",
      apiKeySalt: TEST_API_KEY_SALT,
      authMode: "keys" as const,
      registrations: [registration],
      executor: {
        dispatch: (reg, request) => reg.directDispatch!(request),
        terminate: () => Promise.resolve(),
      },
      boss: null,
    });

    const result = await runtime.dispatchForTest({
      integration_name: TEMPLATE_MANIFEST.name,
      message: {
        kind: "item-event",
        integration_name: TEMPLATE_MANIFEST.name,
        connection_id: connectionId,
        event_type: "item.created",
        item_id: "item_test",
        cycle: {
          originating_connection_id: "other_conn",
          hop_count: SDK_DEFAULT_HOP_BUDGET,
        },
        payload: { item: {}, metadata: {} },
      },
    });
    expect(result.ok).toBe(true);
    expect(dispatchCount).toBe(0);
  });

  // The budget is the space's, not the SDK constant. It was the constant
  // here while the publish path resolved per space, so an operator who
  // raised `max_event_hop_budget` got events past the bus and dropped at
  // this boundary, with the activity row naming a number they never chose.
  it("honors a raised per-space hop budget instead of the SDK default", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);
    const raised = SDK_DEFAULT_HOP_BUDGET + 4;

    // The stub answers for one space and the default for anything else, so
    // the test pins that the message's own space reaches the lookup. A
    // resolver called with `undefined` regardless would pass an assertion
    // about the ceiling alone.
    const space = "01a02f00-0000-7000-8000-000000000001";
    const asked: (string | undefined)[] = [];
    initEventLog(ctx.storage.eventLog, {
      getHopBudget: (spaceId) => {
        asked.push(spaceId);
        return Promise.resolve(
          spaceId === space ? raised : SDK_DEFAULT_HOP_BUDGET,
        );
      },
    });

    let dispatchCount = 0;
    const registration: LocalIntegrationRegistration = {
      name: TEMPLATE_MANIFEST.name,
      handlerModulePath: null,
      directDispatch: () => {
        dispatchCount++;
        return Promise.resolve({
          result: { ok: true },
          cursorUpdates: {},
          cursorDeletes: [],
          threw: false,
        });
      },
      echo: { echo_ttl_seconds: 60 },
      triggerKinds: new Set(["item-event"]),
    };

    const runtime = createSupervisor(ctx.storage, {
      apiUrl: "http://test.local",
      apiKeySalt: TEST_API_KEY_SALT,
      authMode: "keys" as const,
      registrations: [registration],
      executor: {
        dispatch: (reg, request) => reg.directDispatch!(request),
        terminate: () => Promise.resolve(),
      },
      boss: null,
    });

    const message = (hops: number, spaceId?: string) =>
      ({
        integration_name: TEMPLATE_MANIFEST.name,
        message: {
          kind: "item-event" as const,
          integration_name: TEMPLATE_MANIFEST.name,
          connection_id: connectionId,
          ...(spaceId !== undefined && { space_id: spaceId }),
          event_type: "item.created",
          item_id: "item_test",
          cycle: {
            originating_connection_id: "other_conn",
            hop_count: hops,
          },
          payload: { item: {}, metadata: {} },
        },
      }) as Parameters<typeof runtime.dispatchForTest>[0];

    try {
      // At the old constant, which this space's raised budget allows through.
      const allowed = await runtime.dispatchForTest(
        message(SDK_DEFAULT_HOP_BUDGET, space),
      );
      expect(allowed.ok).toBe(true);
      expect(dispatchCount).toBe(1);

      // At the raised budget, which still stops it.
      const stopped = await runtime.dispatchForTest(message(raised, space));
      expect(stopped.ok).toBe(true);
      expect(dispatchCount).toBe(1);

      // The message's own space is what was asked about. Resolving a constant
      // `undefined` would satisfy every assertion above.
      expect(asked).toEqual([space, space]);

      // A message from a space with no raised budget is stopped at the
      // default, on the same runtime, which is the other half of "per space".
      const other = await runtime.dispatchForTest(
        message(SDK_DEFAULT_HOP_BUDGET, "01a02f00-0000-7000-8000-000000000002"),
      );
      expect(other.ok).toBe(true);
      expect(dispatchCount).toBe(1);
    } finally {
      __resetCycleDetectionForTests();
    }
  });

  /**
   * These replace a test that asserted the opposite: that a revoked
   * Connection's dispatch throws at the credential mint. It did throw, and
   * that was the defect. The throw left the job lock, left `dispatchOne`
   * and reached pg-boss as a rejected handler, so the job burned its whole
   * retry ladder and dead-lettered over a settled state nobody can act on,
   * degrading `/health` while it sat there.
   *
   * The mint's own refusal is untouched and is still asserted, in
   * `credentials.test.ts` and `runtime-credential-lifecycle.test.ts`. It is
   * the fail-closed backstop for every other caller, and a test that only
   * calls the mint would pass with the gate below deleted — which is why
   * every fixture here is a real dispatch.
   */
  function supervisorFor(
    registration: LocalIntegrationRegistration,
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
      boss: null,
    });
  }

  /** Activity rows this dispatch wrote against one connection. */
  async function activityFor(connectionId: string): Promise<Item[]> {
    const rows = await ctx.storage.items.list({ type: "system.activity" });
    return rows.data.filter(
      (item) =>
        (item.properties as { connection_id?: string }).connection_id ===
        connectionId,
    );
  }

  it("acks a schedule tick for a revoked Connection rather than throwing at the mint", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);
    await ctx.storage.items.transition(connectionId, "revoked", undefined);

    let handlerRan = false;
    const runtime = supervisorFor(
      buildRegistration(() => {
        handlerRan = true;
        return Promise.resolve({ ok: true, done: true });
      }),
    );

    const result = await runtime.dispatchForTest({
      integration_name: TEMPLATE_MANIFEST.name,
      message: {
        kind: "schedule",
        integration_name: TEMPLATE_MANIFEST.name,
        connection_id: connectionId,
        scheduled_for_ms: Date.now(),
      },
    });

    expect(result).toEqual({ ok: true });
    expect(handlerRan).toBe(false);

    // Acking silently would trade an unactionable dead letter for no
    // record at all, so the drop says so somewhere a person reads.
    const rows = await activityFor(connectionId);
    expect(rows).toHaveLength(1);
    const props = rows[0]!.properties as {
      severity?: string;
      summary?: string;
      detail?: { connection_state?: string; message_kind?: string };
    };
    expect(props.severity).toBe("warning");
    expect(props.detail?.connection_state).toBe("revoked");
    expect(props.detail?.message_kind).toBe("schedule");
  });

  it("acks a webhook for a revoked Connection, where a paused one retries", async () => {
    // The one place this parts company with the pause gate, and the reason
    // it is a separate verdict rather than the same one. A paused webhook
    // retries so it can reach the dead-letter surface, because a resume
    // makes a replay work. Revoked is terminal: the retry cannot succeed
    // and the row it would leave can never be replayed, which is the exact
    // row this gate exists to stop writing.
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);
    await ctx.storage.items.transition(connectionId, "revoked", undefined);

    let handlerRan = false;
    const runtime = supervisorFor(
      buildRegistration(() => {
        handlerRan = true;
        return Promise.resolve({ ok: true, done: true });
      }),
    );

    const result = await runtime.dispatchForTest({
      integration_name: TEMPLATE_MANIFEST.name,
      message: {
        kind: "webhook",
        integration_name: TEMPLATE_MANIFEST.name,
        connection_id: connectionId,
        delivery_id: "queued-before-revocation",
        headers: {},
        body_base64: Buffer.from("{}").toString("base64"),
        verified_at_ms: Date.now(),
      },
    });

    expect(result).toEqual({ ok: true });
    expect(handlerRan).toBe(false);
  });

  it("lets the terminal verdict win over a stale paused mark", async () => {
    // The two gates read different properties, and this pins which one
    // answers when both are set. It is defensive rather than reachable
    // today: the single writer that revokes a connection overwrites
    // `runtime_status` in the same transaction, so the pair cannot
    // legitimately disagree. It could once — a compensation path moved
    // `state` alone and left the properties reading healthy — and that is
    // the shape this orders against.
    //
    // Ordering it the other way is not a cosmetic difference. The pause
    // gate retries a webhook, so a connection wearing both marks would
    // retry a delivery it can never dispatch, straight into the
    // unreplayable dead letter this whole change exists to stop writing.
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId, {
      runtime_status: "paused",
    });
    await ctx.storage.items.transition(connectionId, "revoked", undefined);

    let handlerRan = false;
    const runtime = supervisorFor(
      buildRegistration(() => {
        handlerRan = true;
        return Promise.resolve({ ok: true, done: true });
      }),
    );

    const result = await runtime.dispatchForTest({
      integration_name: TEMPLATE_MANIFEST.name,
      message: {
        kind: "webhook",
        integration_name: TEMPLATE_MANIFEST.name,
        connection_id: connectionId,
        delivery_id: "paused-then-revoked",
        headers: {},
        body_base64: Buffer.from("{}").toString("base64"),
        verified_at_ms: Date.now(),
      },
    });

    // The pause gate's answer would be `{ ok: false, retry: true }`.
    expect(result).toEqual({ ok: true });
    expect(handlerRan).toBe(false);
    const rows = await activityFor(connectionId);
    expect(rows).toHaveLength(1);
  });

  it("acks a dispatch whose Connection row is gone entirely", async () => {
    // The same ladder by a different route, and the reason the gate reads
    // `type` before `state`: a purged row is not a connection at all, so a
    // state test alone would not see it. Before the gate it fell past the
    // pause check to the mint, which threw `CONNECTION_NOT_FOUND` and
    // dead-lettered identically to the revoked case.
    //
    // Purged rather than deleted, deliberately. `items.delete` is a soft
    // delete and a `system.connection`'s soft-delete state is `revoked`,
    // not `trashed` — so deleting a connection produces the case above,
    // and only a purge reaches this one.
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);
    await ctx.storage.items.delete(connectionId, undefined);
    await ctx.storage.items.purge(connectionId, undefined);

    let handlerRan = false;
    const runtime = supervisorFor(
      buildRegistration(() => {
        handlerRan = true;
        return Promise.resolve({ ok: true, done: true });
      }),
    );

    const result = await runtime.dispatchForTest({
      integration_name: TEMPLATE_MANIFEST.name,
      message: {
        kind: "schedule",
        integration_name: TEMPLATE_MANIFEST.name,
        connection_id: connectionId,
        scheduled_for_ms: Date.now(),
      },
    });

    expect(result).toEqual({ ok: true });
    expect(handlerRan).toBe(false);
    const rows = await activityFor(connectionId);
    expect(rows).toHaveLength(1);
    expect(
      (rows[0]!.properties as { detail?: { connection_state?: string } }).detail
        ?.connection_state,
    ).toBe("missing");
  });

  it("acks a queued schedule message for a paused Connection without dispatching", async () => {
    // A queued schedule tick for a paused connection is skipped with a
    // clean ack — the schedule is an ongoing stream, so dropping the
    // residue is a no-op and resume does not inherit burned retries.
    // (Webhooks differ: see the retry case below.)
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);
    const row = await ctx.storage.items.get(connectionId, undefined);
    await ctx.storage.items.update(
      connectionId,
      { properties: { ...row!.properties, runtime_status: "paused" } },
      undefined,
    );

    let handlerRan = false;
    const registration = buildRegistration(() => {
      handlerRan = true;
      return Promise.resolve({ ok: true, done: true });
    });

    const runtime = createSupervisor(ctx.storage, {
      apiUrl: "http://test.local",
      apiKeySalt: TEST_API_KEY_SALT,
      authMode: "keys" as const,
      registrations: [registration],
      executor: {
        dispatch: (reg, request) => reg.directDispatch!(request),
        terminate: () => Promise.resolve(),
      },
      boss: null,
    });

    const result = await runtime.dispatchForTest({
      integration_name: TEMPLATE_MANIFEST.name,
      message: {
        kind: "schedule",
        integration_name: TEMPLATE_MANIFEST.name,
        connection_id: connectionId,
        scheduled_for_ms: Date.now(),
      },
    });
    expect(result).toEqual({ ok: true });
    expect(handlerRan).toBe(false);
  });

  it("retries a queued webhook for a paused Connection instead of dropping it", async () => {
    // A webhook delivery is a one-off the sender already handed over —
    // ack-and-drop would lose it silently (the receipt route's dedup
    // window swallows the redelivery). Retrying pushes it toward the
    // dead-letter surface if the pause outlasts the ladder: visible and
    // replayable.
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);
    const row = await ctx.storage.items.get(connectionId, undefined);
    await ctx.storage.items.update(
      connectionId,
      { properties: { ...row!.properties, runtime_status: "paused" } },
      undefined,
    );

    let handlerRan = false;
    const registration = buildRegistration(() => {
      handlerRan = true;
      return Promise.resolve({ ok: true, done: true });
    });

    const runtime = createSupervisor(ctx.storage, {
      apiUrl: "http://test.local",
      apiKeySalt: TEST_API_KEY_SALT,
      authMode: "keys" as const,
      registrations: [registration],
      executor: {
        dispatch: (reg, request) => reg.directDispatch!(request),
        terminate: () => Promise.resolve(),
      },
      boss: null,
    });

    const result = await runtime.dispatchForTest({
      integration_name: TEMPLATE_MANIFEST.name,
      message: {
        kind: "webhook",
        integration_name: TEMPLATE_MANIFEST.name,
        connection_id: connectionId,
        delivery_id: "queued-before-pause",
        headers: {},
        body_base64: Buffer.from("{}").toString("base64"),
        verified_at_ms: Date.now(),
      },
    });
    expect(result).toEqual({
      ok: false,
      retry: true,
      reason: "connection_paused",
    });
    expect(handlerRan).toBe(false);
  });

  it("ignores integrations with no registration (envelope filter)", async () => {
    const runtime = createSupervisor(ctx.storage, {
      apiUrl: "http://test.local",
      apiKeySalt: TEST_API_KEY_SALT,
      authMode: "keys" as const,
      registrations: [],
      executor: {
        dispatch: () => {
          throw new Error("should not be called");
        },
        terminate: () => Promise.resolve(),
      },
      boss: null,
    });

    const result = await runtime.dispatchForTest({
      integration_name: "missing/integration",
      message: {
        kind: "schedule",
        integration_name: "missing/integration",
        connection_id: "conn_does_not_matter",
        scheduled_for_ms: Date.now(),
      },
    });
    expect(result.ok).toBe(true);
  });
});

// Quiet the unused-namespace-import lint — the import is here so the
// extension reads use the namespace constant rather than a magic string.
void CONNECTION_RUNTIME_NAMESPACE;

/**
 * A dispatch whose queue job is taken away while it is still running.
 *
 * pg-boss arms one expiry timer per fetched batch and hands every job in that
 * batch the same `AbortController`; when the timer fires it aborts that
 * controller and fails every job id. Nothing terminates the worker thread, so
 * the handler returns normally afterwards, and the supervisor used to believe
 * it and stamp a completed sync.
 *
 * These drive the real signal rather than a clock. The budget pg-boss enforces
 * is per batch, so timing one dispatch cannot see an overrun the batch shares,
 * and an aborted `AbortSignal` is the same object production reads.
 */
describe("local-runtime supervisor: the job was reclaimed mid-run", () => {
  function scheduleEnvelope(connectionId: string) {
    return {
      integration_name: TEMPLATE_MANIFEST.name,
      message: {
        kind: "schedule" as const,
        integration_name: TEMPLATE_MANIFEST.name,
        connection_id: connectionId,
        scheduled_for_ms: Date.now(),
      },
    };
  }

  function runtimeFor(
    registration: LocalIntegrationRegistration,
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
      boss: null,
    });
  }

  async function readTimings(connectionId: string) {
    const connection = await ctx.storage.items.get(connectionId);
    return (connection?.properties ?? {}) as {
      last_sync_at?: string | null;
      last_error_at?: string | null;
    };
  }

  async function reclaimedActivity(connectionId: string) {
    const activity = await ctx.storage.items.list({ type: "system.activity" });
    return activity.data.filter((item) => {
      const props = item.properties as {
        summary?: string;
        connection_id?: string;
      };
      return (
        props.connection_id === connectionId &&
        (props.summary ?? "").includes(
          "its queue job had already been reclaimed",
        )
      );
    });
  }

  it("does not record a successful sync when the job was reclaimed", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);

    // The handler reports success, exactly as one whose job was taken away
    // does: it has no idea anything happened to the job underneath it.
    const aborted = new AbortController();
    const registration = buildRegistration(() => {
      aborted.abort();
      return Promise.resolve({ ok: true, done: true } satisfies SweepResult);
    });

    const result = await runtimeFor(registration).dispatchForTest(
      scheduleEnvelope(connectionId),
      0,
      aborted.signal,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.retry).toBe(false);
    expect(result.reason).toContain("reclaimed before the handler returned");

    const timings = await readTimings(connectionId);
    expect(timings.last_sync_at ?? null).toBeNull();

    const state = await readConnectionRuntimeState(ctx.storage, connectionId);
    expect(state.recent_errors).toHaveLength(1);
    expect(state.recent_errors[0]?.reason).toContain("was reclaimed");
  });

  it("writes the operator-visible row for a reclaimed job", async () => {
    // The tail entry is per-connection state; this is the row a person sees.
    // Without this assertion the recording can be reduced to a tail write and
    // every other test here stays green.
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);

    const aborted = new AbortController();
    const registration = buildRegistration(() => {
      aborted.abort();
      return Promise.resolve({ ok: true, done: true } satisfies SweepResult);
    });

    await runtimeFor(registration).dispatchForTest(
      scheduleEnvelope(connectionId),
      0,
      aborted.signal,
    );

    const reported = await reclaimedActivity(connectionId);
    expect(reported).toHaveLength(1);
    expect((reported[0]?.properties as { severity?: string }).severity).toBe(
      "warning",
    );
  });

  it("leaves the error stamp alone, because a long sweep converges", async () => {
    // Deliberate: a sweep too large for one dispatch commits its cursor and
    // the next run starts further on, so reddening the connection on every
    // leg would report a fault where there is progress. Stale `last_sync_at`
    // plus the activity row is the honest signal.
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);

    const aborted = new AbortController();
    const registration = buildRegistration(() => {
      aborted.abort();
      return Promise.resolve({ ok: true, done: true } satisfies SweepResult);
    });

    await runtimeFor(registration).dispatchForTest(
      scheduleEnvelope(connectionId),
      0,
      aborted.signal,
    );

    const timings = await readTimings(connectionId);
    expect(timings.last_error_at ?? null).toBeNull();
  });

  it("keeps the handler's own account of a run that also threw", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);

    const aborted = new AbortController();
    const registration: LocalIntegrationRegistration = {
      name: TEMPLATE_MANIFEST.name,
      handlerModulePath: null,
      directDispatch: () => {
        aborted.abort();
        return Promise.resolve({
          result: {
            ok: false,
            retry: false,
            reason: "dispatch_threw: upstream blip",
          },
          cursorUpdates: {},
          cursorDeletes: [],
          threw: true,
          thrownMessage: "upstream blip",
          thrownClassName: "TypeError",
        } satisfies WorkerDispatchResponse);
      },
      scheduleCron: "*/5 * * * *",
      echo: { echo_ttl_seconds: 60, lag_window_seconds: 60 },
      triggerKinds: new Set(["schedule"]),
    };

    await runtimeFor(registration).dispatchForTest(
      scheduleEnvelope(connectionId),
      0,
      aborted.signal,
    );

    const state = await readConnectionRuntimeState(ctx.storage, connectionId);
    expect(state.recent_errors[0]?.reason).toContain("upstream blip");
  });

  it("still records a successful sync when the job was not reclaimed", async () => {
    // The control. Without it every assertion above is satisfied by a
    // supervisor that never stamps a success at all, which would be a worse
    // defect than the one being fixed and would look identical here.
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);

    const live = new AbortController();
    const registration = buildRegistration(() =>
      Promise.resolve({ ok: true, done: true } satisfies SweepResult),
    );

    const result = await runtimeFor(registration).dispatchForTest(
      scheduleEnvelope(connectionId),
      0,
      live.signal,
    );

    expect(result).toEqual({ ok: true, done: true });

    const timings = await readTimings(connectionId);
    expect(timings.last_sync_at ?? null).not.toBeNull();

    const state = await readConnectionRuntimeState(ctx.storage, connectionId);
    expect(state.recent_errors).toHaveLength(0);
    expect(await reclaimedActivity(connectionId)).toHaveLength(0);
  });

  it("passes the queue job's signal into dispatch, which is the whole feature", async () => {
    // The one production line that connects pg-boss to the check is inside
    // the `boss.work` callback. Every other test here hands the signal to
    // `dispatchForTest` by hand, so deleting that line leaves them all green
    // while the feature is gone. This drives the registered callback instead.
    const integrationId = await createIntegrationItem();
    const first = await createActiveConnection(integrationId);
    const second = await createActiveConnection(integrationId);

    let dispatched = 0;
    const registration = buildRegistration(() => {
      dispatched += 1;
      return Promise.resolve({ ok: true, done: true } satisfies SweepResult);
    });

    // Only the surface `start()` touches. `work` captures the dispatch
    // queue's handler so the test can invoke it with a batch of its own.
    let queueHandler:
      | ((
          jobs: {
            data: SchedulerEnvelope;
            retryCount: number;
            signal: AbortSignal;
          }[],
        ) => Promise<void>)
      | null = null;
    const boss = {
      createQueue: () => Promise.resolve(),
      schedule: () => Promise.resolve(),
      unschedule: () => Promise.resolve(),
      getSchedules: () => Promise.resolve([]),
      send: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      work: (name: string, _opts: unknown, handler: unknown) => {
        if (name === QUEUE_NAME) {
          queueHandler = handler as typeof queueHandler;
        }
        return Promise.resolve();
      },
    };

    const runtime = createSupervisor(ctx.storage, {
      apiUrl: "http://test.local",
      apiKeySalt: TEST_API_KEY_SALT,
      authMode: "keys" as const,
      registrations: [registration],
      executor: {
        dispatch: (reg, request) => reg.directDispatch!(request),
        terminate: () => Promise.resolve(),
      },
      boss: boss as unknown as PgBoss,
    });
    await runtime.start();
    expect(queueHandler).not.toBeNull();

    // One batch, two jobs, one shared controller already aborted — the shape
    // pg-boss produces when a batch's expiry timer has fired.
    const batch = new AbortController();
    batch.abort();
    await queueHandler!([
      { data: scheduleEnvelope(first), retryCount: 0, signal: batch.signal },
      { data: scheduleEnvelope(second), retryCount: 0, signal: batch.signal },
    ]);

    // pg-boss has already redelivered both, so neither should have run here
    // and neither should be recorded as having synced.
    expect(dispatched).toBe(0);
    expect((await readTimings(first)).last_sync_at ?? null).toBeNull();
    expect((await readTimings(second)).last_sync_at ?? null).toBeNull();
  });

  it("still reports a permanent failure as one when the job was also reclaimed", async () => {
    // A handler that fails permanently is describing the connection, not the
    // queue job. Demoting it to a reclaim warning would hide a real fault on
    // exactly the connections that reach this branch on every run.
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);

    const aborted = new AbortController();
    const registration = buildRegistration(() => {
      aborted.abort();
      return Promise.resolve({
        ok: false,
        retry: false,
        reason: "config invalid",
      } satisfies HandlerResult);
    });

    const result = await runtimeFor(registration).dispatchForTest(
      scheduleEnvelope(connectionId),
      0,
      aborted.signal,
    );

    expect(result).toEqual({
      ok: false,
      retry: false,
      reason: "config invalid",
    });

    const state = await readConnectionRuntimeState(ctx.storage, connectionId);
    expect(state.recent_errors[0]?.reason).toBe("config invalid");
    expect(await reclaimedActivity(connectionId)).toHaveLength(0);
  });

  it("commits the cursor writes a run made before its job was reclaimed", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);

    const aborted = new AbortController();
    const registration = buildRegistration(async (handlerCtx) => {
      await handlerCtx.cursor.write("main", { page: 7 });
      aborted.abort();
      return { ok: true, done: true };
    });

    await runtimeFor(registration).dispatchForTest(
      scheduleEnvelope(connectionId),
      0,
      aborted.signal,
    );

    const state = await readConnectionRuntimeState(ctx.storage, connectionId);
    expect(state.cursors["cursor:main"]).toEqual({ page: 7 });
  });
  /**
   * The supervisor's half of the resumption contract.
   *
   * The SDK can say "not finished"; these cover what this process does about
   * it. Every fixture here is a SCHEDULE dispatch deliberately: an
   * item-event never stamps `last_sync_at` in the first place, so a park
   * test built on one would pass with the guard deleted and prove nothing.
   */
  describe("continuation chains", () => {
    interface SentJob {
      name: string;
      envelope: {
        integration_name: string;
        message: {
          kind: string;
          continuation?: { resume: unknown; slice: number };
        };
      };
      options?: { priority?: number };
    }

    function bossRecording(sent: SentJob[]) {
      return {
        createQueue: () => Promise.resolve(),
        schedule: () => Promise.resolve(),
        unschedule: () => Promise.resolve(),
        getSchedules: () => Promise.resolve([]),
        send: (name: string, envelope: unknown, options?: unknown) => {
          sent.push({
            name,
            envelope: envelope as SentJob["envelope"],
            options: options as SentJob["options"],
          });
          return Promise.resolve();
        },
        stop: () => Promise.resolve(),
        work: () => Promise.resolve(),
      } as unknown as PgBoss;
    }

    function runtimeWithBoss(
      registration: LocalIntegrationRegistration,
      boss: PgBoss,
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

    it("enqueues the next slice, carrying the resume payload", async () => {
      const integrationId = await createIntegrationItem();
      const connectionId = await createActiveConnection(integrationId);
      const sent: SentJob[] = [];
      const registration = buildRegistration(() =>
        Promise.resolve({
          ok: true,
          done: false,
          continuation: {
            resume: { page: 4 },
            progress: { processed: 10, watermark: "w4" },
          },
        } satisfies SweepResult),
      );

      const result = await runtimeWithBoss(
        registration,
        bossRecording(sent),
      ).dispatchForTest(scheduleEnvelope(connectionId));

      expect(result).toEqual({
        ok: true,
        done: false,
        continuation: {
          resume: { page: 4 },
          progress: { processed: 10, watermark: "w4" },
        },
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.name).toBe(QUEUE_NAME);
      const envelope = sent[0]!.envelope;
      expect(envelope.message.kind).toBe("schedule");
      expect(envelope.message.continuation?.resume).toEqual({ page: 4 });
      expect(envelope.message.continuation?.slice).toBe(1);
      // Below the default, so a chain never overtakes a fresh webhook.
      expect(sent[0]?.options?.priority).toBe(-1);
    });

    it("does not stamp a sync success for a slice that did not finish", async () => {
      // The fixture is a schedule dispatch that RETURNS ok. Without the
      // `done` check in postProcess this stamps `last_sync_at` and the
      // connection reports a healthy sync it never completed — the exact
      // defect the reclaim work removed, reintroduced through a new shape.
      const integrationId = await createIntegrationItem();
      const connectionId = await createActiveConnection(integrationId);
      const registration = buildRegistration(() =>
        Promise.resolve({
          ok: true,
          done: false,
          continuation: { resume: null, progress: { processed: 1 } },
        } satisfies SweepResult),
      );

      await runtimeWithBoss(registration, bossRecording([])).dispatchForTest(
        scheduleEnvelope(connectionId),
      );

      const timings = await readTimings(connectionId);
      expect(timings.last_sync_at ?? null).toBeNull();
    });

    it("stamps a sync success for the slice that does finish", async () => {
      // The control for the test above. Without it, a postProcess that
      // never stamped anything would pass that one too.
      const integrationId = await createIntegrationItem();
      const connectionId = await createActiveConnection(integrationId);
      const registration = buildRegistration(() =>
        Promise.resolve({ ok: true, done: true } satisfies SweepResult),
      );

      await runtimeWithBoss(registration, bossRecording([])).dispatchForTest(
        scheduleEnvelope(connectionId),
      );

      const timings = await readTimings(connectionId);
      expect(timings.last_sync_at ?? null).not.toBeNull();
    });

    it("abandons a chain that has run too many slices, and says so", async () => {
      const integrationId = await createIntegrationItem();
      const connectionId = await createActiveConnection(integrationId);
      const sent: SentJob[] = [];
      const registration = buildRegistration(() =>
        Promise.resolve({
          ok: true,
          done: false,
          continuation: { resume: null, progress: { processed: 0 } },
        } satisfies SweepResult),
      );

      const envelope = scheduleEnvelope(connectionId);
      const result = await runtimeWithBoss(
        registration,
        bossRecording(sent),
      ).dispatchForTest({
        ...envelope,
        message: {
          ...envelope.message,
          continuation: {
            resume: null,
            chain_id: "chain_x",
            slice: 500,
            started_at_ms: Date.now(),
          },
        },
      });

      expect(result.ok).toBe(false);
      // The title claims it says so, so the reason is asserted rather
      // than left to the two sibling tests to cover.
      expect(!result.ok && result.reason).toContain("500 continuations");
      // Nothing enqueued: the chain stops rather than continuing forever.
      expect(sent).toHaveLength(0);
      // And it is visible, because a chain that keeps parking looks like
      // health on every other surface.
      const timings = await readTimings(connectionId);
      expect(timings.last_error_at ?? null).not.toBeNull();
    });

    it("abandons a chain that has run too long in wall clock", async () => {
      const integrationId = await createIntegrationItem();
      const connectionId = await createActiveConnection(integrationId);
      const sent: SentJob[] = [];
      const registration = buildRegistration(() =>
        Promise.resolve({
          ok: true,
          done: false,
          continuation: { resume: null, progress: { processed: 0 } },
        } satisfies SweepResult),
      );

      const envelope = scheduleEnvelope(connectionId);
      const result = await runtimeWithBoss(
        registration,
        bossRecording(sent),
      ).dispatchForTest({
        ...envelope,
        message: {
          ...envelope.message,
          continuation: {
            resume: null,
            chain_id: "chain_y",
            // One slice in, but started a day ago: only the wall-clock
            // ceiling can catch this one, so it fails if the two guards
            // were collapsed into a single slice count.
            slice: 1,
            started_at_ms: Date.now() - 24 * 60 * 60 * 1000,
          },
        },
      });

      expect(result.ok).toBe(false);
      expect(sent).toHaveLength(0);
    });

    it("rebases an echo marker onto the commit clock", async () => {
      // The worker's writes are invisible until the dispatch returns, so
      // a marker stamped from the handler's own clock arrives expired.
      // The handler here writes with a clock an hour in the past, which
      // is the same shape as a long run and gives the assertion a gap it
      // can actually see — milliseconds apart would prove nothing.
      const integrationId = await createIntegrationItem();
      const connectionId = await createActiveConnection(integrationId);
      const anHourAgo = Date.now() - 60 * 60_000;

      const registration: LocalIntegrationRegistration = {
        name: TEMPLATE_MANIFEST.name,
        handlerModulePath: null,
        directDispatch: async (request: WorkerDispatchRequest) => {
          const { cursorAdapter, updates, deletes } = inMemoryCursor(
            request.cursorSnapshot,
          );
          const echo = createEchoSuppression(
            cursorAdapter,
            request.echo,
            () => anHourAgo,
          );
          await echo.trackOutboundWrite("ext_1", "hash_a");
          return Promise.resolve({
            result: { ok: true, done: true },
            cursorUpdates: updates,
            cursorDeletes: Array.from(deletes),
            threw: false,
          });
        },
        echo: { echo_ttl_seconds: 60 },
        triggerKinds: new Set(["schedule" as const]),
        manifest: TEMPLATE_MANIFEST,
      } as unknown as LocalIntegrationRegistration;

      await runtimeFor(registration).dispatchForTest(
        scheduleEnvelope(connectionId),
      );

      const state = await readConnectionRuntimeState(ctx.storage, connectionId);
      const marker = state.cursors[`${ECHO_MARKER_PREFIX}ext_1`] as {
        expires_at_ms: number;
      };
      // Written an hour ago with a 60s TTL, so without the rebase this is
      // ~59 minutes in the past. Rebased, it is a minute in the future.
      expect(marker.expires_at_ms).toBeGreaterThan(Date.now());
    });

    it("sweeps an expired marker nothing will ever read again", async () => {
      // Both read paths delete a marker they find expired, so anything an
      // integration keeps asking about is already bounded. This covers
      // what it STOPS asking about: an external id written once and never
      // seen again leaves a record no read path will ever reach, and
      // therefore never deletes. Seeded directly, because the only way to
      // produce one honestly is to wait out a TTL.
      const integrationId = await createIntegrationItem();
      const connectionId = await createActiveConnection(integrationId);
      await applyCursorDelta(
        ctx.storage,
        connectionId,
        {
          [`${ECHO_MARKER_PREFIX}forgotten`]: {
            content_hash: "h",
            ttl_ms: 60_000,
            expires_at_ms: Date.now() - 60 * 60_000,
          },
          [`${ECHO_MARKER_PREFIX}still_live`]: {
            content_hash: "h",
            ttl_ms: 60_000,
            expires_at_ms: Date.now() + 60 * 60_000,
          },
        },
        [],
      );

      const registration = buildRegistration(() =>
        Promise.resolve({ ok: true, done: true } satisfies SweepResult),
      );
      await runtimeFor(registration).dispatchForTest(
        scheduleEnvelope(connectionId),
      );

      const state = await readConnectionRuntimeState(ctx.storage, connectionId);
      expect(state.cursors[`${ECHO_MARKER_PREFIX}forgotten`]).toBeUndefined();
      // The live one stays. Without this, a sweep that deleted every
      // marker would pass.
      expect(state.cursors[`${ECHO_MARKER_PREFIX}still_live`]).toBeDefined();
    });

    it("abandons a chain whose slices report the same position twice", async () => {
      const integrationId = await createIntegrationItem();
      const connectionId = await createActiveConnection(integrationId);
      const sent: SentJob[] = [];
      const registration = buildRegistration(() =>
        Promise.resolve({
          ok: true,
          done: false,
          continuation: {
            resume: null,
            progress: { processed: 3, watermark: "w7" },
          },
        } satisfies SweepResult),
      );

      const envelope = scheduleEnvelope(connectionId);
      const result = await runtimeWithBoss(
        registration,
        bossRecording(sent),
      ).dispatchForTest({
        ...envelope,
        message: {
          ...envelope.message,
          continuation: {
            resume: null,
            chain_id: "chain_stall",
            // Well inside both ceilings, so only the progress check can
            // refuse this — the ceilings would let it straight through.
            slice: 2,
            started_at_ms: Date.now() - 30_000,
            // Derived rather than written out, because the fingerprint's
            // shape is the runtime's business and a fixture that spells it
            // by hand stops testing the check the moment the shape widens.
            progress_fingerprint: progressFingerprint({
              resume: null,
              progress: { processed: 3, watermark: "w7" },
            }),
            seen_fingerprints: [
              progressFingerprint({
                resume: null,
                progress: { processed: 3, watermark: "w7" },
              }),
            ],
          },
        },
      });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toContain("stopped making progress");
      expect(sent).toHaveLength(0);
      const timings = await readTimings(connectionId);
      expect(timings.last_error_at ?? null).not.toBeNull();
    });

    it("abandons a chain that returns to a position it had already left", async () => {
      // The alternating loop. No two neighbouring slices match, so the
      // consecutive check never fires; only the seen-set catches it.
      const integrationId = await createIntegrationItem();
      const connectionId = await createActiveConnection(integrationId);
      const sent: SentJob[] = [];
      const registration = buildRegistration(() =>
        Promise.resolve({
          ok: true,
          done: false,
          continuation: {
            resume: null,
            progress: { processed: 1, watermark: "A" },
          },
        } satisfies SweepResult),
      );

      const envelope = scheduleEnvelope(connectionId);
      const result = await runtimeWithBoss(
        registration,
        bossRecording(sent),
      ).dispatchForTest({
        ...envelope,
        message: {
          ...envelope.message,
          continuation: {
            resume: null,
            chain_id: "chain_flip",
            slice: 4,
            started_at_ms: Date.now() - 30_000,
            // Immediately previous slice was B, so the consecutive check
            // passes. A is in the history, so the loop is caught anyway.
            progress_fingerprint: progressFingerprint({
              resume: null,
              progress: { processed: 1, watermark: "B" },
            }),
            seen_fingerprints: [
              progressFingerprint({
                resume: null,
                progress: { processed: 1, watermark: "A" },
              }),
              progressFingerprint({
                resume: null,
                progress: { processed: 1, watermark: "B" },
              }),
            ],
          },
        },
      });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toContain("looping");
      expect(sent).toHaveLength(0);
    });

    it("lets a chain that is advancing carry on", async () => {
      // The control. Without it, a check that refused every continuation
      // would pass both tests above.
      const integrationId = await createIntegrationItem();
      const connectionId = await createActiveConnection(integrationId);
      const sent: SentJob[] = [];
      const registration = buildRegistration(() =>
        Promise.resolve({
          ok: true,
          done: false,
          continuation: {
            resume: null,
            progress: { processed: 9, watermark: "w9" },
          },
        } satisfies SweepResult),
      );

      const envelope = scheduleEnvelope(connectionId);
      const result = await runtimeWithBoss(
        registration,
        bossRecording(sent),
      ).dispatchForTest({
        ...envelope,
        message: {
          ...envelope.message,
          continuation: {
            resume: null,
            chain_id: "chain_ok",
            slice: 2,
            started_at_ms: Date.now() - 30_000,
            progress_fingerprint: "3@w7",
            seen_fingerprints: ["1@w1", "3@w7"],
          },
        },
      });

      expect(result.ok).toBe(true);
      expect(sent).toHaveLength(1);
    });

    it("keeps a marker the same dispatch just rewrote, while sweeping its neighbour", async () => {
      // The sweep reads the PRE-dispatch snapshot, and `applyCursorDelta`
      // applies updates before deletes — so a key in both is deleted. A
      // handler rewriting an external id whose previous marker had just
      // expired would end the dispatch with no marker at all, and the
      // next echo webhook would re-ingest its own write. The expired
      // neighbour is in the fixture so a fix that simply stopped sweeping
      // would fail this too.
      const integrationId = await createIntegrationItem();
      const connectionId = await createActiveConnection(integrationId);
      const stale = {
        content_hash: "h",
        ttl_ms: 60_000,
        expires_at_ms: Date.now() - 60 * 60_000,
      };
      await applyCursorDelta(
        ctx.storage,
        connectionId,
        {
          [`${ECHO_MARKER_PREFIX}rewritten`]: stale,
          [`${ECHO_MARKER_PREFIX}neighbour`]: stale,
        },
        [],
      );

      const registration: LocalIntegrationRegistration = {
        name: TEMPLATE_MANIFEST.name,
        handlerModulePath: null,
        directDispatch: async (request: WorkerDispatchRequest) => {
          const { cursorAdapter, updates, deletes } = inMemoryCursor(
            request.cursorSnapshot,
          );
          const echo = createEchoSuppression(cursorAdapter, request.echo);
          await echo.trackOutboundWrite("rewritten", "hash_new");
          return Promise.resolve({
            result: { ok: true, done: true },
            cursorUpdates: updates,
            cursorDeletes: Array.from(deletes),
            threw: false,
          });
        },
        echo: { echo_ttl_seconds: 60 },
        triggerKinds: new Set(["schedule" as const]),
        manifest: TEMPLATE_MANIFEST,
      } as unknown as LocalIntegrationRegistration;

      await runtimeFor(registration).dispatchForTest(
        scheduleEnvelope(connectionId),
      );

      const state = await readConnectionRuntimeState(ctx.storage, connectionId);
      expect(state.cursors[`${ECHO_MARKER_PREFIX}rewritten`]).toBeDefined();
      expect(state.cursors[`${ECHO_MARKER_PREFIX}neighbour`]).toBeUndefined();
    });

    it("does not enqueue a successor for a slice whose job was reclaimed", async () => {
      // A reclaimed job has already been redelivered, so the redelivery
      // will re-run this slice and produce its own successor. Enqueuing
      // one here as well forks the chain, and both forks carry the same
      // id, so neither looks stale to the straggler check.
      const integrationId = await createIntegrationItem();
      const connectionId = await createActiveConnection(integrationId);
      const sent: SentJob[] = [];
      const aborted = new AbortController();
      const registration = buildRegistration(() => {
        aborted.abort();
        return Promise.resolve({
          ok: true,
          done: false,
          continuation: { resume: null, progress: { processed: 1 } },
        } satisfies SweepResult);
      });

      const result = await runtimeWithBoss(
        registration,
        bossRecording(sent),
      ).dispatchForTest(scheduleEnvelope(connectionId), 0, aborted.signal);

      expect(sent).toHaveLength(0);
      expect(result.ok).toBe(false);
    });

    it("retries the slice rather than losing the chain when the enqueue fails", async () => {
      const integrationId = await createIntegrationItem();
      const connectionId = await createActiveConnection(integrationId);
      const registration = buildRegistration(() =>
        Promise.resolve({
          ok: true,
          done: false,
          continuation: { resume: null, progress: { processed: 1 } },
        } satisfies SweepResult),
      );
      const failingBoss = {
        createQueue: () => Promise.resolve(),
        schedule: () => Promise.resolve(),
        unschedule: () => Promise.resolve(),
        getSchedules: () => Promise.resolve([]),
        send: () => Promise.reject(new Error("queue unreachable")),
        stop: () => Promise.resolve(),
        work: () => Promise.resolve(),
      } as unknown as PgBoss;

      const result = await runtimeWithBoss(
        registration,
        failingBoss,
      ).dispatchForTest(scheduleEnvelope(connectionId));

      // Retryable, so pg-boss redelivers and the slice repeats. Repeating
      // a slice is the right trade against losing the rest of the sweep.
      expect(result.ok).toBe(false);
      expect(!result.ok && result.retry).toBe(true);
    });

    it("refuses a scheduled result that does not say whether it finished", async () => {
      // A handler built against the previous contract, which is what the
      // deployed integrations are until their pin moves. Treating this as
      // finished is exactly what the required discriminant exists to
      // prevent, so it fails loudly instead.
      const integrationId = await createIntegrationItem();
      const connectionId = await createActiveConnection(integrationId);
      const registration: LocalIntegrationRegistration = {
        name: TEMPLATE_MANIFEST.name,
        handlerModulePath: null,
        directDispatch: () =>
          Promise.resolve({
            result: { ok: true },
            cursorUpdates: {},
            cursorDeletes: [],
            threw: false,
          }),
        echo: { echo_ttl_seconds: 60 },
        triggerKinds: new Set(["schedule" as const]),
        manifest: TEMPLATE_MANIFEST,
      } as unknown as LocalIntegrationRegistration;

      const result = await runtimeFor(registration).dispatchForTest(
        scheduleEnvelope(connectionId),
      );

      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toContain("did not say whether");
      // And it must not have stamped a sync success on its way past.
      const timings = await readTimings(connectionId);
      expect(timings.last_sync_at ?? null).toBeNull();
    });

    it("refuses to schedule a continuation when the runtime has no queue", async () => {
      // `runtime.enqueue`'s no-boss fallback dispatches synchronously, so a
      // chain there would recurse into itself. Refusing is the behaviour;
      // this pins it rather than leaving a hang to be discovered.
      const integrationId = await createIntegrationItem();
      const connectionId = await createActiveConnection(integrationId);
      const registration = buildRegistration(() =>
        Promise.resolve({
          ok: true,
          done: false,
          continuation: { resume: null, progress: { processed: 1 } },
        } satisfies SweepResult),
      );

      const result = await runtimeFor(registration).dispatchForTest(
        scheduleEnvelope(connectionId),
      );

      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toContain("no queue");
    });
  });
});
