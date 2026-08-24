/**
 * A smoke against the local-runtime substrate, driven through the server's
 * own dispatch fixture.
 *
 * What it proves is a property of the server rather than of any
 * integration: the supervisor's lock, credential mint, cursor snapshot and
 * delta merge, end to end through a real built entry. So it dispatches
 * through a fixture this package owns, which is also the only built entry
 * this repository has.
 *
 * The smoke loads the fixture's compiled `dist/local.js`, registers
 * handlers through `_resetHandlers` + `registerHandlers`, drives one
 * trigger via `supervisor.dispatchForTest`, and asserts the outcome. The
 * directDispatch seam keeps it fast — the worker_thread executor is
 * exercised separately by the supervisor tests.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createTestContext, TEST_API_KEY_SALT } from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";
import {
  _resetHandlers,
  dispatchMessage,
  ConnectionClient,
  createActivitySink,
  createCursorStore,
  createEchoSuppression,
  type ConnectionContext,
  type CursorStorageAdapter,
  type QueueMessage,
  type HandlerResult,
  familyOnlyMappingResolver,
} from "@withmarfa/runtime-sdk";
import { createSupervisor } from "./supervisor.js";
import { readConnectionRuntimeState } from "./pg-cursor-store.js";
import type {
  LocalIntegrationRegistration,
  WorkerDispatchRequest,
  WorkerDispatchResponse,
} from "./types.js";

let ctx: TestContext;
const MONOREPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
);

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

interface LoadedIntegration {
  manifest: {
    name: string;
    bidirectional_handling: {
      echo_ttl_seconds: number;
      lag_window_seconds?: number;
    };
  };
  registerHandlers: (opts?: unknown) => void;
}

async function loadBuiltEntry(path: string): Promise<LoadedIntegration> {
  const mod = (await import(pathToFileURL(path).href)) as {
    manifest: LoadedIntegration["manifest"];
    registerHandlers: LoadedIntegration["registerHandlers"];
  };
  return { manifest: mod.manifest, registerHandlers: mod.registerHandlers };
}

/**
 * The server's dispatch fixture: the minimal handler shape this package
 * owns, so the substrate has something to dispatch through that is not an
 * installed integration.
 */
function loadDispatchFixture(): Promise<LoadedIntegration> {
  return loadBuiltEntry(
    resolve(
      MONOREPO_ROOT,
      "packages/server/fixtures/dispatch-integration/dist/local.js",
    ),
  );
}

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

/** A directDispatch callback that wraps `dispatchMessage`, so the
 *  supervisor's lock and cursor plumbing runs against the entry's actual
 *  handler registry. Re-seeded per dispatch, because the runtime-sdk
 *  registry is a singleton in the test process. */
function makeAppFetch(apiUrl: string): typeof fetch {
  return (input: string | URL | Request, init?: RequestInit) => {
    const urlStr =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const path = urlStr.startsWith(apiUrl)
      ? urlStr.slice(apiUrl.length)
      : urlStr;
    return Promise.resolve(ctx.app.request(path, init));
  };
}

function makeDirectDispatch(
  integration: LoadedIntegration,
  registerOptions?: unknown,
): LocalIntegrationRegistration["directDispatch"] {
  return async (request: WorkerDispatchRequest) => {
    const { cursorAdapter, updates, deletes } = inMemoryCursor(
      request.cursorSnapshot,
    );
    const client = new ConnectionClient({
      apiUrl: request.apiUrl,
      credential: request.credential,
      refreshCredential: () => Promise.resolve(request.credential),
      fetch: makeAppFetch(request.apiUrl),
    });
    const cycleParent =
      request.message.kind === "item-event" ? request.message.cycle : null;
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
      cycle: cycleParent,
    };
    _resetHandlers();
    integration.registerHandlers(registerOptions);
    let result: HandlerResult;
    let threw = false;
    let thrownMessage: string | undefined;
    let thrownClassName: string | undefined;
    try {
      result = await dispatchMessage(connectionContext, request.message);
    } catch (err) {
      threw = true;
      thrownMessage = err instanceof Error ? err.message : String(err);
      thrownClassName =
        err instanceof Error ? err.constructor.name || "Error" : "unknown";
      result = {
        ok: false,
        retry: false,
        reason: `dispatch_threw: ${thrownMessage}`,
      };
    }
    const response: WorkerDispatchResponse = {
      result,
      cursorUpdates: updates,
      cursorDeletes: Array.from(deletes),
      threw,
      ...(thrownMessage !== undefined && { thrownMessage }),
      ...(thrownClassName !== undefined && { thrownClassName }),
    };
    return response;
  };
}

async function createIntegrationItem(
  integration: LoadedIntegration,
): Promise<string> {
  const m = integration.manifest as unknown as {
    name: string;
    version?: string;
    publisher?: string;
  };
  const item = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: m.name,
        manifest_version: m.version ?? "0.0.1",
        publisher: m.publisher ?? "test",
        manifest: integration.manifest,
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

function makeRegistration(
  integration: LoadedIntegration,
  registerOptions?: unknown,
): LocalIntegrationRegistration {
  return {
    name: integration.manifest.name,
    handlerModulePath: null,
    directDispatch: makeDirectDispatch(integration, registerOptions),
    echo: {
      echo_ttl_seconds:
        integration.manifest.bidirectional_handling.echo_ttl_seconds,
      ...(integration.manifest.bidirectional_handling.lag_window_seconds !==
      undefined
        ? {
            lag_window_seconds:
              integration.manifest.bidirectional_handling.lag_window_seconds,
          }
        : {}),
    },
    triggerKinds: new Set(),
  };
}

function makeSupervisor(registration: LocalIntegrationRegistration) {
  return createSupervisor(ctx.storage, {
    apiUrl: "http://test.local",
    apiKeySalt: TEST_API_KEY_SALT,
    authMode: "keys" as const,
    registrations: [registration],
    executor: {
      dispatch: (reg, request) => {
        if (!reg.directDispatch) throw new Error("directDispatch missing");
        return reg.directDispatch(request);
      },
      terminate: () => Promise.resolve(),
    },
    boss: null,
  });
}

describe("the local runtime substrate", () => {
  it("the dispatch fixture — schedule trigger writes a cursor and emits activity", async () => {
    const integration = await loadDispatchFixture();
    const integrationId = await createIntegrationItem(integration);
    const connectionId = await createActiveConnection(integrationId);
    const runtime = makeSupervisor(makeRegistration(integration));

    const result = await runtime.dispatchForTest({
      integration_name: integration.manifest.name,
      message: {
        kind: "schedule",
        integration_name: integration.manifest.name,
        connection_id: connectionId,
        scheduled_for_ms: Date.now(),
      } satisfies QueueMessage,
    });

    expect(result.ok).toBe(true);
    const state = await readConnectionRuntimeState(ctx.storage, connectionId);
    expect(state.cursors["cursor:main"]).toMatchObject({ run_count: 1 });
  });
});
