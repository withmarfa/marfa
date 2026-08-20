/**
 * Worker-thread entry script for the local runtime executor.
 *
 * The supervisor (main thread) spawns one `Worker` per integration in a
 * small pool, then dispatches `WorkerDispatchRequest` payloads over
 * `parentPort` for each queue message. Each thread:
 *
 *   1. On startup, reads `workerData.handlerModulePath` and imports it.
 *      The integration's `local.ts` calls `registerHandlers()` on import,
 *      seeding `@withmarfa/runtime-sdk`'s in-thread handler registry.
 *   2. Listens on `parentPort` for dispatch messages, builds a
 *      `ConnectionContext` from the supplied credential + cursor
 *      snapshot, runs `dispatchMessage`, and posts the
 *      `WorkerDispatchResponse` back.
 *
 * Per-Connection state writes journal into an in-memory map that's
 * shipped back as the dispatch response; the supervisor applies the
 * delta under the same advisory lock that gated the dispatch.
 */
import { parentPort, workerData } from "node:worker_threads";
import {
  ConnectionClient,
  createActivitySink,
  createCursorStore,
  createEchoSuppression,
  createMappingResolver,
  dispatchMessage,
  type ConnectionContext,
  type CursorStorageAdapter,
  type HandlerResult,
} from "@withmarfa/runtime-sdk";
import type { WorkerDispatchRequest, WorkerDispatchResponse } from "./types.js";

interface BootData {
  handlerModulePath: string;
}

function isBootData(value: unknown): value is BootData {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { handlerModulePath?: unknown }).handlerModulePath ===
      "string"
  );
}

/**
 * In-memory cursor adapter scoped to a single dispatch. Backed by a Map
 * seeded with the supervisor's snapshot; every write/delete is also
 * captured in the `updates`/`deletes` accumulators which the response
 * ships back to the supervisor.
 *
 * Echo-suppression markers live in the same Map (the SDK's
 * `createEchoSuppression` writes via the storage adapter), so they
 * round-trip through the dispatch envelope alongside cursors. The
 * supervisor merges them back into the connection state under the same
 * lock.
 */
function createInThreadCursorAdapter(snapshot: Record<string, unknown>): {
  adapter: CursorStorageAdapter;
  updates: Record<string, unknown>;
  deletes: Set<string>;
} {
  const live = new Map<string, unknown>(Object.entries(snapshot));
  const updates: Record<string, unknown> = {};
  const deletes = new Set<string>();
  const adapter: CursorStorageAdapter = {
    get(key: string): Promise<unknown> {
      return Promise.resolve(live.get(key) ?? null);
    },
    put(key: string, value: unknown): Promise<void> {
      live.set(key, value);
      updates[key] = value;
      deletes.delete(key);
      return Promise.resolve();
    },
    delete(key: string): Promise<unknown> {
      const had = live.has(key);
      live.delete(key);
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- cursor key strings are integration-supplied on a value-typed Record
      delete updates[key];
      deletes.add(key);
      return Promise.resolve(had);
    },
  };
  return { adapter, updates, deletes };
}

function buildContext(
  request: WorkerDispatchRequest,
  adapter: CursorStorageAdapter,
): ConnectionContext {
  const { message, credential, apiUrl, echo } = request;
  const cycleParent = message.kind === "item-event" ? message.cycle : null;
  const client = new ConnectionClient({
    apiUrl,
    credential,
    refreshCredential: () => Promise.resolve(credential),
    cycleParent,
  });
  return {
    connection_id: message.connection_id,
    integration_name: message.integration_name,
    ...(message.space_id !== undefined && { space_id: message.space_id }),
    marfa: client,
    cursor: createCursorStore(adapter),
    activity: createActivitySink(client, message.connection_id),
    echo: createEchoSuppression(adapter, echo),
    mapping: createMappingResolver(client, message.connection_id),
    cycle: cycleParent,
  };
}

async function handleDispatch(
  request: WorkerDispatchRequest,
): Promise<WorkerDispatchResponse> {
  const { adapter, updates, deletes } = createInThreadCursorAdapter(
    request.cursorSnapshot,
  );
  let result: HandlerResult;
  let threw = false;
  let thrownMessage: string | undefined;
  let thrownClassName: string | undefined;
  try {
    const ctx = buildContext(request, adapter);
    result = await dispatchMessage(ctx, request.message);
    // Deliberate mapping skips surface as one summary row per run, and
    // this is the per-run boundary on this substrate. Best-effort: a
    // summary that cannot land must not fail the dispatch it describes.
    try {
      await ctx.mapping.flushSkipSummary(ctx.activity);
    } catch {
      // The skip count resets either way; the run's own result stands.
    }
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
  return {
    result,
    cursorUpdates: updates,
    cursorDeletes: Array.from(deletes),
    threw,
    ...(thrownMessage !== undefined && { thrownMessage }),
    ...(thrownClassName !== undefined && { thrownClassName }),
  };
}

async function main(): Promise<void> {
  if (!parentPort) {
    throw new Error("worker-entry must run inside a worker_thread");
  }
  if (!isBootData(workerData)) {
    throw new Error("workerData missing handlerModulePath");
  }
  // local.ts calls registerHandlers() on import. A throw surfaces via the
  // worker `error` event so the pool can replace the bad thread.
  await import(workerData.handlerModulePath);
  parentPort.on("message", (raw: unknown) => {
    void (async () => {
      const request = raw as WorkerDispatchRequest;
      try {
        const response = await handleDispatch(request);
        parentPort?.postMessage(response);
      } catch (err) {
        parentPort?.postMessage({
          result: {
            ok: false,
            retry: false,
            reason: `worker_postmessage_failure: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
          cursorUpdates: {},
          cursorDeletes: [],
          threw: true,
          thrownMessage: err instanceof Error ? err.message : String(err),
          thrownClassName:
            err instanceof Error ? err.constructor.name || "Error" : "unknown",
        } satisfies WorkerDispatchResponse);
      }
    })();
  });
  parentPort.postMessage({ kind: "ready" });
}

void main();
