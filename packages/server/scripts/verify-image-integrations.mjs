/**
 * In-image verification that the packaged server can actually run the
 * integrations it says it installed. Executed as a RUN step in
 * packages/server/Dockerfile, so an image that would boot the local
 * substrate with the wrong integration set fails to build instead of
 * failing in production.
 *
 * An image that installs nothing is a legitimate deployment and passes
 * here. What stops that being an accident is the declaration itself, which
 * refuses to read as empty unless it says `none` in so many words.
 *
 * Plain Node, ESM, node: builtins only, and one sibling module. It runs
 * inside the runtime image, where there is no tsx and no monorepo;
 * everything it needs must resolve from the image's own filesystem.
 *
 * Three checks, in order:
 *
 *   1. The installed set is the declared set, in the declared shape.
 *      installed-integrations.txt says what this image installs; the
 *      integrations root must hold exactly those, no more and no fewer. A
 *      plain name must carry dist/local.js, a dispatchable entry. A name
 *      marked manifest-only must carry dist/manifest.js and must not carry
 *      a handler entry, which is the shape of an integration whose code
 *      runs somewhere else and whose manifest the catalog still needs.
 *
 *      This replaced a hardcoded minimum count. The count existed because
 *      nothing else could say whether the image was complete, and it had
 *      the two faults of every such number: it passed a build that had
 *      quietly gained an integration, and it needed raising by hand every
 *      time the set grew. What the count did catch, and a bare name list
 *      would not, is an integration losing its handler and shrinking the
 *      dispatchable set without changing the count of directories. The
 *      marker is what keeps that caught.
 *
 *   2. Main-process import. The server's loader imports each entry on
 *      boot to read its manifest; this repeats that read and fails on a
 *      missing or shapeless manifest export.
 *
 *   3. Worker-thread dispatch. Spawns dist/worker-entry.js with the
 *      scaffold's local.js and runs one schedule dispatch against a stub
 *      HTTP server. This is the module-singleton proof: if
 *      @withmarfa/runtime-sdk resolves to a second copy inside the image,
 *      the handler registers into one registry and dispatch reads
 *      another, and the result comes back not-ok. The request shape
 *      mirrors scripts/smoke-worker-entry.ts; the two must move together.
 *
 *      The scaffold is a build fixture rather than an installed
 *      integration, so it lives outside the integrations root and the
 *      image drops it as soon as this passes. An image installing nothing
 *      dispatchable has nothing to prove and skips this; anything else
 *      needs the fixture and fails without it.
 */
import { readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { Worker } from "node:worker_threads";
import { readInstalledIntegrations } from "./read-installed-integrations.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const INTEGRATIONS_ROOT =
  process.env.MARFA_INTEGRATIONS_ROOT ?? resolve(HERE, "integrations");
const WORKER_ENTRY =
  process.env.MARFA_VERIFY_WORKER_ENTRY ??
  resolve(HERE, "dist", "worker-entry.js");
const DECLARATION =
  process.env.MARFA_INSTALLED_INTEGRATIONS ??
  resolve(HERE, "installed-integrations.txt");
// Outside the integrations root deliberately: what is in that root is what
// the deployment installed, and the dispatch fixture is not that.
const FIXTURE_ROOT =
  process.env.MARFA_VERIFY_FIXTURE_ROOT ?? resolve(HERE, "verify-fixtures");

function fail(msg) {
  console.error(`[verify-image-integrations] FAIL: ${msg}`);
  process.exit(1);
}

function info(msg) {
  console.log(`[verify-image-integrations] ${msg}`);
}

// Check 1: the installed set is the declared set.
//
// A missing root is an empty installed set rather than an error, matching
// what the runtime's own discovery does with it. An image that declares
// nothing and installs nothing is coherent; an image that declares
// something and has no root is caught below, by name.
let declaration;
try {
  declaration = readInstalledIntegrations(DECLARATION);
} catch (err) {
  fail(String(err.message ?? err));
}
const declared = declaration.map((entry) => entry.name);
const manifestOnlyByName = new Map(
  declaration.map((entry) => [entry.name, entry.manifestOnly]),
);

const installed = existsSync(INTEGRATIONS_ROOT)
  ? readdirSync(INTEGRATIONS_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  : [];

const missing = declared.filter((name) => !installed.includes(name));
if (missing.length > 0) {
  fail(
    `declared but not installed under ${INTEGRATIONS_ROOT}: ${missing.join(", ")}`,
  );
}
const undeclared = installed.filter((name) => !declared.includes(name));
if (undeclared.length > 0) {
  fail(
    `installed but not declared in ${DECLARATION}: ${undeclared.join(", ")}. ` +
      `Declare it or stop staging it. An image quietly carrying something ` +
      `nobody named is the failure this check exists for.`,
  );
}

const entries = [];
const manifestOnly = [];
for (const name of declared) {
  const localJs = resolve(INTEGRATIONS_ROOT, name, "dist", "local.js");
  const manifestJs = resolve(INTEGRATIONS_ROOT, name, "dist", "manifest.js");
  const wantsManifestOnly = manifestOnlyByName.get(name) === true;

  if (wantsManifestOnly) {
    // Manifest-only is a deliberate shape, not a broken build: the catalog
    // reconcile reads it and the runtime loader skips it. Declaring it is
    // what makes the runtime's skip an intention rather than an accident,
    // so an entry that turns up dispatchable is as wrong as one that does
    // not turn up at all.
    if (existsSync(localJs)) {
      fail(
        `${name} is declared manifest-only but staged a dispatchable ` +
          `dist/local.js. Either it grew a handler, in which case drop the ` +
          `marker, or the wrong tree was staged.`,
      );
    }
    if (!existsSync(manifestJs)) {
      fail(`${name} is declared manifest-only but staged no dist/manifest.js`);
    }
    manifestOnly.push(name);
    continue;
  }

  if (!existsSync(localJs)) {
    fail(
      `${name} is declared dispatchable but staged no dist/local.js` +
        (existsSync(manifestJs)
          ? `. It built a manifest and no handler, which is the shape that ` +
            `used to shrink the image silently; mark it manifest-only if ` +
            `that is now what it is.`
          : ""),
    );
  }
  entries.push({ name, localJs });
}
info(
  `${String(declared.length)} declared integrations all installed: ` +
    `${String(entries.length)} dispatchable` +
    (manifestOnly.length > 0
      ? `, ${String(manifestOnly.length)} manifest-only (${manifestOnly.join(", ")})`
      : ""),
);

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

// Check 3: worker-thread dispatch through the scaffold fixture.
if (entries.length === 0) {
  info(
    `nothing dispatchable installed; the dispatch check has nothing to prove`,
  );
  info(`PASSED`);
  process.exit(0);
}
if (!existsSync(WORKER_ENTRY)) {
  fail(`worker entry does not exist: ${WORKER_ENTRY}`);
}
const templateLocal = resolve(FIXTURE_ROOT, "_template", "dist", "local.js");
if (!existsSync(templateLocal)) {
  fail(
    `the dispatch fixture is missing at ${templateLocal}, so the ` +
      `module-resolution proof cannot run against an image that installs ` +
      `${String(entries.length)} dispatchable integrations`,
  );
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
