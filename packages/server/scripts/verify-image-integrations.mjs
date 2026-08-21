/**
 * In-image verification that the packaged server can actually run its
 * integrations. Executed as a RUN step in packages/server/Dockerfile, so
 * an image that would boot the local substrate with a broken or empty
 * integration set fails to build instead of failing in production.
 *
 * Plain Node, ESM, node: builtins only. It runs inside the runtime image,
 * where there is no tsx and no monorepo; everything it needs must resolve
 * from the image's own filesystem.
 *
 * Three checks, in order:
 *
 *   1. Presence and count. Every directory under the integrations root
 *      must carry dist/local.js, and there must be at least MIN_ENTRIES
 *      of them. The count is a tripwire: removing an integration should
 *      be a visible decision here, not a silent shrink of the image.
 *
 *   2. Main-process import. The server's loader imports each entry on
 *      boot to read its manifest; this repeats that read and fails on a
 *      missing or shapeless manifest export.
 *
 *   3. Worker-thread dispatch. Spawns dist/worker-entry.js with the
 *      template integration's local.js and runs one schedule dispatch
 *      against a stub HTTP server. This is the module-singleton proof:
 *      if @withmarfa/runtime-sdk resolves to a second copy inside the
 *      image, the handler registers into one registry and dispatch reads
 *      another, and the result comes back not-ok. The request shape
 *      mirrors scripts/smoke-worker-entry.ts; the two must move together.
 */
import { readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { Worker } from "node:worker_threads";

const HERE = dirname(fileURLToPath(import.meta.url));
const INTEGRATIONS_ROOT =
  process.env.MARFA_INTEGRATIONS_ROOT ?? resolve(HERE, "integrations");
const WORKER_ENTRY =
  process.env.MARFA_VERIFY_WORKER_ENTRY ??
  resolve(HERE, "dist", "worker-entry.js");
// 14 shipping integrations with a local entry plus the template. The sync
// integration has no local.js by design: its agent lives outside the
// server process. Update this number deliberately when the set changes.
const MIN_ENTRIES = 15;

function fail(msg) {
  console.error(`[verify-image-integrations] FAIL: ${msg}`);
  process.exit(1);
}

function info(msg) {
  console.log(`[verify-image-integrations] ${msg}`);
}

// Check 1: presence and count.
if (!existsSync(INTEGRATIONS_ROOT)) {
  fail(`integrations root does not exist: ${INTEGRATIONS_ROOT}`);
}
const dirs = readdirSync(INTEGRATIONS_ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
const entries = dirs
  .map((name) => ({
    name,
    localJs: resolve(INTEGRATIONS_ROOT, name, "dist", "local.js"),
  }))
  .filter((e) => {
    if (!existsSync(e.localJs)) {
      fail(`${e.name} is staged without dist/local.js`);
    }
    return true;
  });
if (entries.length < MIN_ENTRIES) {
  fail(
    `expected at least ${String(MIN_ENTRIES)} integration entries, found ${String(entries.length)}: ${dirs.join(", ")}`,
  );
}
info(`${String(entries.length)} integration entries staged`);

// Check 2: each entry imports and exports a manifest. Importing also runs
// each entry's registerHandlers() against this process's registry; that
// registry is throwaway here, so the overwrites are harmless.
for (const entry of entries) {
  let mod;
  try {
    mod = await import(pathToFileURL(entry.localJs).href);
  } catch (err) {
    fail(`${entry.name}/dist/local.js failed to import: ${String(err)}`);
  }
  const manifest = mod.manifest ?? mod.default?.manifest;
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    typeof manifest.name !== "string"
  ) {
    fail(`${entry.name}/dist/local.js exports no usable manifest`);
  }
}
info(`all entries import and export manifests`);

// Check 3: worker-thread dispatch through the template integration.
if (!existsSync(WORKER_ENTRY)) {
  fail(`worker entry does not exist: ${WORKER_ENTRY}`);
}
const templateLocal = resolve(
  INTEGRATIONS_ROOT,
  "_template",
  "dist",
  "local.js",
);
if (!existsSync(templateLocal)) {
  fail(`_template/dist/local.js missing; the dispatch check needs it`);
}

// Stub for the template handler's activity emit; shape matches what
// ConnectionClient.createItem unwraps.
const stub = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let properties = {};
    try {
      properties =
        JSON.parse(Buffer.concat(chunks).toString("utf8")).properties ?? {};
    } catch {
      // non-JSON bodies get an empty properties echo
    }
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        item: {
          id: "01976f00-0000-7000-8000-000000000000",
          type: "system.activity",
          state: "active",
          tier: "library",
          space_id: null,
          properties,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          version: 1,
          source: "verify-image",
          schema_version: 1,
        },
      }),
    );
  });
});
await new Promise((res) => stub.listen(0, "127.0.0.1", res));
const port = stub.address().port;

const worker = new Worker(WORKER_ENTRY, {
  workerData: { handlerModulePath: templateLocal },
});

let exitCode = 0;
try {
  await Promise.race([
    new Promise((res, rej) => {
      worker.on("message", (msg) => {
        if (msg !== null && typeof msg === "object" && msg.kind === "ready")
          res();
      });
      worker.once("error", rej);
      worker.once("exit", (code) => {
        if (code !== 0)
          rej(new Error(`worker exited with code ${String(code)}`));
      });
    }),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("worker not ready within 10s")), 10_000),
    ),
  ]);
  info(`worker thread loaded the template entry`);

  const response = await new Promise((res, rej) => {
    worker.on("message", (msg) => {
      if (msg !== null && typeof msg === "object" && msg.kind !== "ready")
        res(msg);
    });
    setTimeout(() => rej(new Error("dispatch timed out after 15s")), 15_000);
    worker.postMessage({
      apiUrl: `http://127.0.0.1:${String(port)}`,
      credential: {
        api_key: "marfa_k1_verify_image",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        connection_id: "verify-image-connection",
      },
      message: {
        kind: "schedule",
        integration_name: "acme/template",
        connection_id: "verify-image-connection",
        scheduled_for_ms: Date.now(),
      },
      integrationName: "acme/template",
      echo: { echo_ttl_seconds: 60, lag_window_seconds: 60 },
      hopBudget: 5,
      cursorSnapshot: {},
    });
  });

  if (response.result?.ok !== true) {
    fail(
      `dispatch returned not-ok: ${JSON.stringify(response.result)}. ` +
        `A "no_schedule_handler_registered" reason means @withmarfa/runtime-sdk ` +
        `resolved to a duplicate copy inside the image.`,
    );
  }
  info(`worker dispatch ok; module resolution is single-instance`);
  info(`PASSED`);
} catch (err) {
  console.error(`[verify-image-integrations] dispatch threw:`, err);
  exitCode = 1;
} finally {
  await worker.terminate();
  await new Promise((res) => stub.close(() => res()));
}
process.exit(exitCode);
