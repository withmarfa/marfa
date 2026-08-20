/**
 * Supervisor end-to-end (without spawning worker_threads) — exercises
 * the lock + cursor merge + activity emit path against a real
 * Postgres-backed test context using a `directDispatch` registration.
 *
 * The worker_thread boundary is covered separately — `executor.test.ts`
 * for the pool's spawn/error handling, `in-tree-smoke.test.ts` for
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
import { createTestContext, TEST_API_KEY_SALT } from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";
import {
  registerScheduleHandler,
  _resetHandlers,
  SDK_DEFAULT_HOP_BUDGET,
  type ConnectionContext,
  type HandlerResult,
  type ScheduleMessage,
  familyOnlyMappingResolver,
} from "@withmarfa/runtime-sdk";
import { createSupervisor } from "./supervisor.js";
import type {
  LocalIntegrationRegistration,
  WorkerDispatchRequest,
  WorkerDispatchResponse,
} from "./types.js";
import {
  CONNECTION_RUNTIME_NAMESPACE,
  readConnectionRuntimeState,
} from "./pg-cursor-store.js";
import { dispatchMessage } from "@withmarfa/runtime-sdk";
import {
  ConnectionClient,
  createActivitySink,
  createCursorStore,
  createEchoSuppression,
  type CursorStorageAdapter,
} from "@withmarfa/runtime-sdk";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const TEMPLATE_MANIFEST = {
  name: "test.local-runtime",
  version: "0.0.1",
  publisher: "test",
  description: "Test integration for the local runtime",
  manifest_schema_version: "1.0.0",
  direction: "read" as const,
  runtime_compatibility: ["local"] as const,
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
    edge: {},
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
    undefined,
  );
  return item.id;
}

function buildRegistration(
  handler: (
    ctxCtx: ConnectionContext,
    message: ScheduleMessage,
  ) => Promise<HandlerResult>,
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
      return { ok: true };
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

  it("rejects dispatch for a revoked Connection at the credential mint", async () => {
    const integrationId = await createIntegrationItem();
    const connectionId = await createActiveConnection(integrationId);

    // Revoke the Connection so the credential mint refuses; a revoked
    // Connection cannot mint a runtime credential and therefore cannot run.
    await ctx.storage.items.transition(connectionId, "revoked", undefined);

    const registration = buildRegistration(() => Promise.resolve({ ok: true }));

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

    // The dispatch raises inside `withJobLock`; the supervisor surfaces
    // it back through the promise. We assert by catching directly.
    let threw: unknown = null;
    try {
      await runtime.dispatchForTest({
        integration_name: TEMPLATE_MANIFEST.name,
        message: {
          kind: "schedule",
          integration_name: TEMPLATE_MANIFEST.name,
          connection_id: connectionId,
          scheduled_for_ms: Date.now(),
        },
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).not.toBeNull();
    expect(String(threw)).toMatch(/revoked|cannot mint/i);
  });

  it("acks a queued message for a paused Connection without dispatching", async () => {
    // Whatever enqueued the message — a pre-pause tick, an in-flight
    // webhook, a dead-letter replay — a paused connection dispatches
    // nothing, and the skip is a clean ack rather than an error so
    // resume does not inherit a backlog of burned retries.
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
      return Promise.resolve({ ok: true });
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
      integration_name: "missing.integration",
      message: {
        kind: "schedule",
        integration_name: "missing.integration",
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
