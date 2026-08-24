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
 * Four checks, in order:
 *
 *   1. The installed set is the declared set, in the declared shape.
 *      installed-integrations.txt says what this image installs; the
 *      integrations root must hold exactly those, no more and no fewer. A
 *      plain name must carry dist/local.js, a dispatchable entry. A name
 *      marked manifest-only must carry dist/manifest.js and must not carry
 *      a handler entry, which is the shape of an integration whose code
 *      runs somewhere else and whose manifest the catalog still needs.
 *
 *      A declared set rather than a count: a count passes a build that
 *      quietly gained an integration and needs raising by hand every time
 *      the set grows. The marker is what keeps a count's one real catch —
 *      an integration losing its handler, which shrinks the dispatchable
 *      set without changing how many directories there are.
 *
 *   2. Main-process import. The server's loader imports each entry on
 *      boot to read its manifest; this repeats that read and fails on a
 *      missing or shapeless manifest export.
 *
 *   3. The client manifests resolve from the image. A client's code runs
 *      on the user's machine, so nothing about it is installed into the
 *      integrations root and checks 1 and 2 cannot see it: its manifest is
 *      a workspace dependency of the server, kept by the deploy prune and
 *      resolved from /app/node_modules. Nothing else in the estate proves
 *      that. The prune is the one step that could drop it, and neither
 *      smoke:boot nor the suite runs against a pruned tree, so a
 *      dependency demoted to devDependencies would pass everything and
 *      fail on the first container.
 *
 *      The failure it guards is the better of the two available. Because
 *      the import is static, a missing client manifest crashes the process
 *      at startup rather than booting a catalog quietly short an entry,
 *      which is what the discovered half does. Loud is not a reason to
 *      leave it to production: this fails the build instead.
 *
 *      The set is read from dist/client-manifests.js, the same constant
 *      boot hands to the reconcile, so it cannot drift from what ships.
 *      Membership is the server suite's business; what is proved here is
 *      that whatever the build claims to ship still resolves and parses
 *      once the image has been pruned to production dependencies.
 *
 *   4. Worker-thread dispatch. Spawns dist/worker-entry.js with the
 *      dispatch fixture's local.js and runs one schedule dispatch against
 *      a stub HTTP server. This is the module-singleton proof: if
 *      @withmarfa/runtime-sdk resolves to a second copy inside the image,
 *      the handler registers into one registry and dispatch reads
 *      another, and the result comes back not-ok. The request shape
 *      mirrors scripts/smoke-worker-entry.ts; the two must move together.
 *
 *      The fixture is the server's own, built by the image the way a real
 *      integration is built and staged the way one is staged, which is
 *      what makes the result say anything about a real integration. It is
 *      not an installed integration, so it lives outside the integrations
 *      root and the image drops it as soon as this passes. An image
 *      installing nothing dispatchable has nothing to prove and skips
 *      this; anything else needs the fixture and fails without it.
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
const CLIENT_MANIFESTS_ENTRY =
  process.env.MARFA_VERIFY_CLIENT_MANIFESTS ??
  resolve(HERE, "dist", "client-manifests.js");
// Outside the integrations root deliberately: what is in that root is what
// the deployment installed, and the dispatch fixture is not that.
const FIXTURE_ROOT =
  process.env.MARFA_VERIFY_FIXTURE_ROOT ?? resolve(HERE, "verify-fixtures");
// Overridable only so the suite can drive the timeout paths without waiting
// out the real budgets. An image never sets these.
//
// A bad value is refused rather than coerced. `Number("")` is 0 and
// `Number("soon")` is NaN, and setTimeout treats both as fire-immediately,
// so the permissive reading turns a typo into a timeout that always
// expires: a check that fails for a reason unrelated to what it tests.
function budget(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`${name} must be a positive number of milliseconds, not "${raw}"`);
  }
  return parsed;
}

function fail(msg) {
  console.error(`[verify-image-integrations] FAIL: ${msg}`);
  process.exit(1);
}

function info(msg) {
  console.log(`[verify-image-integrations] ${msg}`);
}

const READY_TIMEOUT_MS = budget("MARFA_VERIFY_READY_TIMEOUT_MS", 10_000);
const DISPATCH_TIMEOUT_MS = budget("MARFA_VERIFY_DISPATCH_TIMEOUT_MS", 15_000);

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

// Two levels, because an integration directory is `<namespace>/<name>` and
// that is the name the declaration carries.
//
// Everything found is reported, with none of the dot-and-underscore
// skipping the runtime's own discovery does. The two answer different
// questions: discovery decides what to load out of a directory an operator
// can write to, and this decides whether the build staged what it said it
// would into a directory only the build writes to. Skipping anything here
// would put a blind spot in the one check whose whole point is not having
// one — a wrongly staged `_foo/bar` would pass and then be invisible to the
// runtime as well.
//
// A flat leftover surfaces through the same walk rather than needing its
// own rule: a directory staged at one level has `dist` as its only
// subdirectory, so it reports as `<name>/dist` and fails as undeclared.
function installedNames(root) {
  if (!existsSync(root)) return [];
  const names = [];
  for (const handle of readdirSync(root, { withFileTypes: true })) {
    if (!handle.isDirectory()) continue;
    const inner = readdirSync(resolve(root, handle.name), {
      withFileTypes: true,
    });
    for (const leaf of inner) {
      if (leaf.isDirectory()) names.push(`${handle.name}/${leaf.name}`);
    }
  }
  return names.sort();
}

const installed = installedNames(INTEGRATIONS_ROOT);

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
    manifestOnly.push({ name, entryJs: manifestJs });
    continue;
  }

  if (!existsSync(localJs)) {
    fail(
      `${name} is declared dispatchable but staged no dist/local.js` +
        (existsSync(manifestJs)
          ? `. It built a manifest and no handler, which shrinks the ` +
            `image silently; mark it manifest-only if that is what it is.`
          : ""),
    );
  }
  entries.push({ name, localJs });
}
info(
  `${String(declared.length)} declared integrations all installed: ` +
    `${String(entries.length)} dispatchable` +
    (manifestOnly.length > 0
      ? `, ${String(manifestOnly.length)} manifest-only (${manifestOnly
          .map((entry) => entry.name)
          .join(", ")})`
      : ""),
);

// Check 2: every staged entry imports and exports a manifest. Both shapes,
// not only the dispatchable ones: the catalog reconcile imports a
// manifest-only entry at boot exactly as the runtime loader imports a
// handler entry, so a truncated one is a boot failure this is the last
// chance to refuse. Importing also runs each handler entry's
// registerHandlers() against this process's registry; that registry is
// throwaway here, so the overwrites are harmless.
//
// Duck-typed on the export rather than keyed to a name, because a handler
// entry exports `manifest` and a manifest-only package exports its own
// constant. The server's own loader does the same and for the same reason.
function manifestFrom(mod) {
  const named = mod.manifest ?? mod.default?.manifest;
  if (usableManifest(named)) return named;
  return Object.values(mod).find(usableManifest);
}

// Deliberately the same three fields the server's own catalog loader
// requires before it will even attempt validation. A weaker test here would
// pass an entry the catalog then skips at boot, which is precisely the
// failure this check exists to refuse, and it would also let the search
// below settle on a different export than the loader would pick.
function usableManifest(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    "manifest_schema_version" in value &&
    typeof value.name === "string" &&
    "version" in value
  );
}

for (const entry of [
  ...entries.map((e) => ({ name: e.name, entryJs: e.localJs })),
  ...manifestOnly,
]) {
  let mod;
  try {
    mod = await import(pathToFileURL(entry.entryJs).href);
  } catch (err) {
    fail(`${entry.name} failed to import ${entry.entryJs}: ${String(err)}`);
  }
  if (!usableManifest(manifestFrom(mod))) {
    fail(`${entry.name} exports no usable manifest from ${entry.entryJs}`);
  }
}
info(`all entries import and export manifests`);

// Check 3: the client manifests this build ships resolve from the image.
//
// Ahead of the dispatch check rather than after it, because that one exits
// early when nothing dispatchable is installed. A deployment that installs
// no integrations still ships every client the build knows about, so a
// client manifest that stopped resolving there is exactly as broken and
// would have been skipped.
let clientManifests;
try {
  const mod = await import(pathToFileURL(CLIENT_MANIFESTS_ENTRY).href);
  clientManifests = mod.CLIENT_MANIFESTS;
} catch (err) {
  fail(
    `the client manifests could not be loaded from ${CLIENT_MANIFESTS_ENTRY}: ` +
      `${String(err)}. A module-not-found here means the deploy prune ` +
      `dropped a manifest package the server imports statically, so the ` +
      `container would crash at startup.`,
  );
}
if (!Array.isArray(clientManifests)) {
  fail(
    `${CLIENT_MANIFESTS_ENTRY} exports no CLIENT_MANIFESTS array; the ` +
      `verification cannot tell what this build claims to ship.`,
  );
}
for (const client of clientManifests) {
  if (!usableManifest(client?.manifest)) {
    fail(
      `the client manifest ${String(client?.name ?? "<unnamed>")} resolved ` +
        `but is not a usable manifest, so the catalog reconcile would ` +
        `refuse it at boot.`,
    );
  }
}
const clientNames = clientManifests.map((client) => client.name).join(", ");
info(
  clientManifests.length === 0
    ? `no client manifests to resolve`
    : clientManifests.length === 1
      ? `1 client manifest resolves and parses from the image (${clientNames})`
      : `${String(clientManifests.length)} client manifests resolve and ` +
        `parse from the image (${clientNames})`,
);

// Check 4: worker-thread dispatch through the dispatch fixture.
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
const fixtureLocal = resolve(
  FIXTURE_ROOT,
  "dispatch-integration",
  "dist",
  "local.js",
);
if (!existsSync(fixtureLocal)) {
  fail(
    `the dispatch fixture is missing at ${fixtureLocal}, so the ` +
      `module-resolution proof cannot run against an image that installs ` +
      `${String(entries.length)} dispatchable integrations`,
  );
}

// Stub for the fixture handler's activity emit; shape matches what
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
  workerData: { handlerModulePath: fixtureLocal },
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
      setTimeout(
        () =>
          rej(
            new Error(`worker not ready within ${String(READY_TIMEOUT_MS)}ms`),
          ),
        READY_TIMEOUT_MS,
      ),
    ),
  ]);
  info(`worker thread loaded the dispatch fixture`);

  const response = await new Promise((res, rej) => {
    worker.on("message", (msg) => {
      if (msg !== null && typeof msg === "object" && msg.kind !== "ready")
        res(msg);
    });
    setTimeout(
      () =>
        rej(
          new Error(
            `dispatch timed out after ${String(DISPATCH_TIMEOUT_MS)}ms`,
          ),
        ),
      DISPATCH_TIMEOUT_MS,
    );
    worker.postMessage({
      apiUrl: `http://127.0.0.1:${String(port)}`,
      credential: {
        api_key: "marfa_k1_verify_image",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        connection_id: "verify-image-connection",
      },
      message: {
        kind: "schedule",
        integration_name: "acme/dispatch-fixture",
        connection_id: "verify-image-connection",
        scheduled_for_ms: Date.now(),
      },
      integrationName: "acme/dispatch-fixture",
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
