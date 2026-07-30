/**
 * Post-build regression smoke for the local-runtime worker spawn path.
 *
 * Exists because the bundling bugs that broke the substrate end-to-end
 * live in `dist/` — vitest never exercised them because every existing
 * test goes through the executor's `directDispatch` test seam.
 *
 * The two failure modes this catches:
 *
 *   1. `dist/worker-entry.js` missing — the Worker constructor throws
 *      `MODULE_NOT_FOUND`. Fixed by listing `worker-entry` as a named
 *      tsup entry in `packages/server/tsup.config.ts`.
 *
 *   2. `@withmarfa/runtime-sdk` (and `@withmarfa/shared`) duplicated across
 *      the server bundle vs the integration's externalized bundle —
 *      the integration's `registerScheduleHandler` writes to one copy
 *      of the module-singleton `REGISTRY`; the worker-entry's
 *      `dispatchMessage` reads from a different copy; dispatch returns
 *      `no_schedule_handler_registered`. Fixed by adding both packages
 *      to the `external` clause in the server's tsup config (mirroring
 *      every integration's own tsup config).
 *
 * This script spawns the built `dist/worker-entry.js` directly via
 * Node's worker_threads — no dependency on importing `createExecutor`
 * from the bundle (which isn't a public export). The worker loads the
 * integration's built `dist/local.js`, registers handlers, dispatches
 * one schedule message, and posts the response back. We assert
 * `result.ok === true` AND `cursorUpdates["cursor:main"]` present.
 *
 * Wired into `pnpm test:full` after `pnpm build` so dist is fresh.
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const WORKER_ENTRY = resolve(REPO_ROOT, "packages/server/dist/worker-entry.js");
const TEMPLATE_LOCAL = resolve(
  REPO_ROOT,
  "integrations/_template/dist/local.js",
);

function fail(msg: string): never {
  console.error(`[smoke-worker-entry] FAIL: ${msg}`);
  process.exit(1);
}

function info(msg: string): void {
  console.log(`[smoke-worker-entry] ${msg}`);
}

// Assertion 1 — catches §3 in isolation. The Worker constructor doesn't
// probe the path, but Node's worker_thread init throws MODULE_NOT_FOUND
// once the thread starts. Pre-flighting the existence here gives a
// clearer error message than waiting for the worker `error` event.
if (!existsSync(WORKER_ENTRY)) {
  fail(
    `dist/worker-entry.js does not exist. tsup must emit it as a named entry — see packages/server/tsup.config.ts.`,
  );
}
info(`dist/worker-entry.js exists`);

if (!existsSync(TEMPLATE_LOCAL)) {
  fail(
    `integrations/_template/dist/local.js does not exist. Run \`pnpm build\` first.`,
  );
}
info(`integrations/_template/dist/local.js exists`);

// Stub HTTP server for the template handler's activity emit. The
// handler does `ctx.activity.emit(...)` which posts /items via
// ConnectionClient.createItem; without a 2xx response back the
// handler throws and the dispatch result comes back as dispatch_threw,
// masking the §4 assertion. Returns a minimal `{ item: {...} }` shape
// matching what ConnectionClient.createItem unwraps.
const stub = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const parsed = ((): { properties?: Record<string, unknown> } => {
      try {
        return JSON.parse(body) as { properties?: Record<string, unknown> };
      } catch {
        return {};
      }
    })();
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        item: {
          id: "01976f00-0000-7000-8000-000000000000",
          type: "system.activity",
          state: "active",
          tier: "library",
          space_id: null,
          properties: parsed.properties ?? {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          version: 1,
          source: "smoke",
          schema_version: 1,
        },
      }),
    );
  });
});

// Port 0 lets the OS assign a free one. A fixed port made this script
// unrunnable twice at once on a machine, which is exactly what a runner
// pool does: two jobs picked up together both bound the same port and the
// second died with EADDRINUSE, reported as a failure of whatever change
// happened to be under test.
await new Promise<void>((res) => {
  stub.listen(0, "127.0.0.1", res);
});
const address = stub.address();
if (address === null || typeof address === "string") {
  fail("stub HTTP server did not report a numeric address after listen");
}
const STUB_PORT = String(address.port);
info(`stub HTTP server listening on 127.0.0.1:${STUB_PORT}`);

// Spawn the built worker-entry directly. The protocol mirrors what
// `executor.ts` does:
//   - workerData carries handlerModulePath (worker-entry imports it on
//     boot, which calls registerHandlers() in the integration's local.js)
//   - worker posts `{ kind: "ready" }` once handlers are registered
//   - parent posts a WorkerDispatchRequest
//   - worker posts a WorkerDispatchResponse back
const worker = new Worker(WORKER_ENTRY, {
  workerData: { handlerModulePath: TEMPLATE_LOCAL },
});

const ready = new Promise<void>((res, rej) => {
  const onMessage = (msg: unknown): void => {
    if (
      typeof msg === "object" &&
      msg !== null &&
      (msg as { kind?: unknown }).kind === "ready"
    ) {
      worker.off("message", onMessage);
      res();
    }
  };
  worker.on("message", onMessage);
  worker.once("error", rej);
  worker.once("exit", (code: number) => {
    if (code !== 0) rej(new Error(`worker exited with code ${String(code)}`));
  });
});

let exitCode = 0;
try {
  await Promise.race([
    ready,
    new Promise<never>((_, rej) => {
      setTimeout(() => {
        rej(new Error("worker did not signal ready within 5s"));
      }, 5_000);
    }),
  ]);
  info(`worker signaled ready (handler module loaded)`);

  // Construct a WorkerDispatchRequest by shape (no import — keeps this
  // script source-of-truth-free against runtime-sdk internals).
  const request = {
    apiUrl: `http://127.0.0.1:${STUB_PORT}`,
    credential: {
      api_key: "marfa_k1_smoke",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      connection_id: "smoke-connection-id",
    },
    message: {
      kind: "schedule",
      integration_name: "marfa.template",
      connection_id: "smoke-connection-id",
      scheduled_for_ms: Date.now(),
    },
    integrationName: "marfa.template",
    echo: { echo_ttl_seconds: 60, lag_window_seconds: 60 },
    hopBudget: 5,
    cursorSnapshot: {},
  };

  const responsePromise = new Promise<{
    result: { ok: boolean; reason?: string };
    cursorUpdates: Record<string, unknown>;
  }>((res, rej) => {
    const onMessage = (msg: unknown): void => {
      worker.off("message", onMessage);
      res(
        msg as {
          result: { ok: boolean; reason?: string };
          cursorUpdates: Record<string, unknown>;
        },
      );
    };
    worker.on("message", onMessage);
    setTimeout(() => {
      rej(new Error("dispatch response timed out after 10s"));
    }, 10_000);
  });

  info(`dispatching one schedule message...`);
  worker.postMessage(request);
  const response = await responsePromise;

  // Assertion 2 — catches §4 (registry duplication). If runtime-sdk is
  // a single module instance across the worker-entry bundle and the
  // integration's external bundle, dispatchMessage finds the handler
  // and the response is ok. If duplicated, the response is
  // `{ ok: false, reason: "no_schedule_handler_registered" }`.
  if (!response.result.ok) {
    fail(
      `worker dispatch returned not-ok: ${JSON.stringify(response.result)}. ` +
        `If reason is "no_schedule_handler_registered", @withmarfa/runtime-sdk is ` +
        `duplicated across the server bundle and the integration bundle — check ` +
        `the "external" clause in packages/server/tsup.config.ts.`,
    );
  }
  info(`dispatch result ok`);

  // Assertion 3 — the template handler writes a cursor under the
  // "cursor:main" key (runtime-sdk's createCursorStore prefixes user
  // keys with "cursor:"). Presence proves the in-thread cursor adapter
  // journalled and the delta round-tripped back through the
  // WorkerDispatchResponse envelope.
  const cursor = response.cursorUpdates["cursor:main"];
  if (cursor === undefined || cursor === null) {
    fail(
      `expected cursorUpdates["cursor:main"] in response; got ${JSON.stringify(
        response.cursorUpdates,
      )}`,
    );
  }
  info(`cursorUpdates["cursor:main"] present: ${JSON.stringify(cursor)}`);
  info(`SMOKE PASSED`);
} catch (err) {
  console.error(`[smoke-worker-entry] dispatch threw:`, err);
  exitCode = 1;
} finally {
  await worker.terminate();
  await new Promise<void>((res) => {
    stub.close(() => {
      res();
    });
  });
}

process.exit(exitCode);
