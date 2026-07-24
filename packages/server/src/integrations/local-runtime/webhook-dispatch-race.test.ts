/**
 * Regression guard for the lost-update race between an inbound webhook
 * receipt and an in-flight dispatch on the same Connection.
 *
 * The receipt path runs on the HTTP thread with no per-Connection lock;
 * the dispatch path runs under `connection-dispatch:<connection_id>`.
 * When both persist per-Connection state through a read / mutate / write
 * cycle over one shared record, whichever commits second overwrites the
 * other's field: either the cursor advance is reverted (the next poll
 * re-ingests) or the idempotency record vanishes (a retried delivery
 * re-processes).
 *
 * The interleaving is forced rather than raced: metadata writes on one
 * side park on a barrier until the other side has committed, so the test
 * is deterministic on every run. Hooking by method name keeps the harness
 * independent of which write primitive the state helpers reach for.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConnectionClient,
  createActivitySink,
  createCursorStore,
  createEchoSuppression,
  dispatchMessage,
  registerScheduleHandler,
  _resetHandlers,
  type ConnectionContext,
  type CursorStorageAdapter,
  type HandlerResult,
  type ScheduleMessage,
} from "@withmarfa/runtime-sdk";
import { createTestContext, TEST_API_KEY_SALT } from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";
import type { Storage } from "../../storage/interface.js";
import { createSupervisor } from "./supervisor.js";
import {
  checkAndRecordIdempotency,
  readConnectionRuntimeState,
  recordRuntimeError,
} from "./pg-cursor-store.js";
import type {
  LocalIntegrationRegistration,
  LocalRuntime,
  WorkerDispatchRequest,
  WorkerDispatchResponse,
} from "./types.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const IDEMPOTENCY_TTL_MS = 3600 * 1000;
const DELIVERY_KEY = "sub_race:delivery_race";

const TEMPLATE_MANIFEST = {
  name: "test.local-runtime-race",
  version: "0.0.1",
  publisher: "test",
  description: "Test integration for the local runtime race guard",
  manifest_schema_version: "1.0.0",
  direction: "bidirectional" as const,
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

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Metadata write primitives the per-Connection state helpers may use. */
const WRITE_METHODS = new Set(["setExtension", "mutateExtension"]);

/**
 * Wrap a `Storage` so the first metadata write signals `arrived` and then
 * parks until `gate` opens. Reads pass straight through, which is what
 * puts the caller's snapshot on the wrong side of the other party's
 * commit.
 */
function parkFirstMetadataWrite(
  storage: Storage,
  gate: Deferred,
  arrived: Deferred,
): Storage {
  let parked = false;
  const metadata = new Proxy(storage.metadata, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      const bound = (value as (...args: unknown[]) => unknown).bind(target);
      if (!WRITE_METHODS.has(String(prop))) return bound;
      return async (...args: unknown[]): Promise<unknown> => {
        if (!parked) {
          parked = true;
          arrived.resolve();
          await gate.promise;
        }
        return bound(...args);
      };
    },
  });
  return { ...storage, metadata };
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

/** A registration whose handler advances `cursor:main` to `{ page }`. */
function buildCursorRegistration(page: number): LocalIntegrationRegistration {
  return {
    name: TEMPLATE_MANIFEST.name,
    handlerModulePath: null,
    directDispatch: async (request: WorkerDispatchRequest) => {
      const live = new Map<string, unknown>(
        Object.entries(request.cursorSnapshot),
      );
      const updates: Record<string, unknown> = {};
      const adapter: CursorStorageAdapter = {
        get(key) {
          return Promise.resolve(live.get(key) ?? null);
        },
        put(key, value) {
          live.set(key, value);
          updates[key] = value;
          return Promise.resolve();
        },
        delete(key) {
          const had = live.has(key);
          live.delete(key);
          return Promise.resolve(had);
        },
      };
      const client = new ConnectionClient({
        apiUrl: request.apiUrl,
        credential: request.credential,
        refreshCredential: () => Promise.resolve(request.credential),
      });
      const connectionContext: ConnectionContext = {
        connection_id: request.message.connection_id,
        integration_name: request.message.integration_name,
        marfa: client,
        cursor: createCursorStore(adapter),
        activity: createActivitySink(client, request.message.connection_id),
        echo: createEchoSuppression(adapter, request.echo),
        cycle: null,
      };
      _resetHandlers();
      registerScheduleHandler(async (c: ConnectionContext) => {
        await c.cursor.write("main", { page });
        const ok: HandlerResult = { ok: true };
        return ok;
      });
      const result = await dispatchMessage(connectionContext, request.message);
      const response: WorkerDispatchResponse = {
        result,
        cursorUpdates: updates,
        cursorDeletes: [],
        threw: false,
      };
      return response;
    },
    scheduleCron: "*/5 * * * *",
    echo: { echo_ttl_seconds: 60, lag_window_seconds: 60 },
    triggerKinds: new Set(["schedule"]),
  };
}

function buildSupervisor(
  storage: Storage,
  registration: LocalIntegrationRegistration,
): LocalRuntime {
  return createSupervisor(storage, {
    apiUrl: "http://test.local",
    apiKeySalt: TEST_API_KEY_SALT,
    registrations: [registration],
    executor: {
      dispatch: (reg, request) => reg.directDispatch!(request),
      terminate: () => Promise.resolve(),
    },
    boss: null,
  });
}

function scheduleEnvelope(connectionId: string): {
  integration_name: string;
  message: ScheduleMessage;
} {
  return {
    integration_name: TEMPLATE_MANIFEST.name,
    message: {
      kind: "schedule",
      integration_name: TEMPLATE_MANIFEST.name,
      connection_id: connectionId,
      scheduled_for_ms: Date.now(),
    },
  };
}

describe("local-runtime receipt / dispatch concurrency", () => {
  it("keeps the cursor advance when a webhook receipt commits after a dispatch", async () => {
    const connectionId = await createActiveConnection(
      await createIntegrationItem(),
    );
    const runtime = buildSupervisor(ctx.storage, buildCursorRegistration(2));

    const gate = deferred();
    const arrived = deferred();
    const receiptStorage = parkFirstMetadataWrite(ctx.storage, gate, arrived);

    // The receipt reads per-Connection state, then parks before committing.
    const receipt = checkAndRecordIdempotency(
      receiptStorage,
      connectionId,
      DELIVERY_KEY,
      IDEMPOTENCY_TTL_MS,
    );
    await arrived.promise;

    // A full dispatch runs to completion inside that window.
    const dispatched = await runtime.dispatchForTest(
      scheduleEnvelope(connectionId),
    );
    expect(dispatched.ok).toBe(true);

    // The receipt commits against state that moved underneath it.
    gate.resolve();
    await receipt;

    const state = await readConnectionRuntimeState(ctx.storage, connectionId);
    expect(state.cursors).toEqual({ "cursor:main": { page: 2 } });

    const replay = await checkAndRecordIdempotency(
      ctx.storage,
      connectionId,
      DELIVERY_KEY,
      IDEMPOTENCY_TTL_MS,
    );
    expect(replay.isDuplicate).toBe(true);
  });

  it("keeps the idempotency record when a dispatch commits after a webhook receipt", async () => {
    const connectionId = await createActiveConnection(
      await createIntegrationItem(),
    );

    const gate = deferred();
    const arrived = deferred();
    const dispatchStorage = parkFirstMetadataWrite(ctx.storage, gate, arrived);
    const runtime = buildSupervisor(
      dispatchStorage,
      buildCursorRegistration(7),
    );

    // The dispatch snapshots cursors, runs the handler, then parks before
    // committing the delta.
    const dispatched = runtime.dispatchForTest(scheduleEnvelope(connectionId));
    await arrived.promise;

    // The receipt lands and commits entirely inside that window.
    const receipt = await checkAndRecordIdempotency(
      ctx.storage,
      connectionId,
      DELIVERY_KEY,
      IDEMPOTENCY_TTL_MS,
    );
    expect(receipt.isDuplicate).toBe(false);

    gate.resolve();
    expect((await dispatched).ok).toBe(true);

    const replay = await checkAndRecordIdempotency(
      ctx.storage,
      connectionId,
      DELIVERY_KEY,
      IDEMPOTENCY_TTL_MS,
    );
    expect(replay.isDuplicate).toBe(true);

    const state = await readConnectionRuntimeState(ctx.storage, connectionId);
    expect(state.cursors).toEqual({ "cursor:main": { page: 7 } });
  });

  it("keeps the cursor advance when a dead-letter error record commits after a dispatch", async () => {
    const connectionId = await createActiveConnection(
      await createIntegrationItem(),
    );
    const runtime = buildSupervisor(ctx.storage, buildCursorRegistration(3));

    const gate = deferred();
    const arrived = deferred();
    const dlqStorage = parkFirstMetadataWrite(ctx.storage, gate, arrived);

    // The dead-letter worker records a terminal failure outside the
    // dispatch lock — same read / mutate / write shape as the receipt.
    const errorRecord = recordRuntimeError(dlqStorage, connectionId, {
      timestamp_ms: 1_700_000_000_000,
      reason: "Exhausted retries (local runtime)",
      message_kind: "schedule",
    });
    await arrived.promise;

    const dispatched = await runtime.dispatchForTest(
      scheduleEnvelope(connectionId),
    );
    expect(dispatched.ok).toBe(true);

    gate.resolve();
    await errorRecord;

    const state = await readConnectionRuntimeState(ctx.storage, connectionId);
    expect(state.cursors).toEqual({ "cursor:main": { page: 3 } });
    expect(state.recent_errors).toHaveLength(1);
    expect(state.recent_errors[0]?.reason).toBe(
      "Exhausted retries (local runtime)",
    );
  });
});
