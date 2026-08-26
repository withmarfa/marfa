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
 * Plain Node and ESM, running inside the runtime image where there is no
 * tsx and no monorepo, so everything it needs must resolve from the
 * image's own filesystem. Beyond node: builtins that means one sibling
 * module, `@withmarfa/shared` through it, and two of the server's own
 * built entries, `dist/load-manifests.js` and `dist/client-manifests.js`.
 * All of them are there because the deploy prune keeps the server's
 * production dependencies and the build emits those entries by name.
 *
 * Six checks, in order:
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
 *   2. Everything installed is listed, and marked as something Marfa
 *      stands behind. The image build has withmarfa/integrations checked
 *      out, so it holds both halves of a coupling that otherwise agrees
 *      only by attention, and it makes `shippedByMarfa` a checked claim
 *      rather than an assertion about a repository the registry cannot
 *      see.
 *
 *      One direction, deliberately. Installing a subset is a supported
 *      shape, so an entry marked shipped that this image does not install
 *      is not a fault here. That the set is complete is a property of the
 *      Marfa repository rather than of the image, and `image-build.yml`
 *      checks it where only our own builds run.
 *
 *   3. The runtime kit stayed external to every staged bundle. Each entry
 *      must resolve `@withmarfa/runtime-sdk` and `@withmarfa/shared` upward
 *      to the server's own copies, because both hold module-singleton
 *      state: a bundle carrying its own copy registers its handlers into a
 *      table nothing dispatches from, with no error anywhere. Check 6
 *      proves the image resolves a single copy, and proves it through one
 *      fixture; this is what says the same of each real integration, and
 *      it costs a file read apiece rather than fifteen worker spawns and
 *      fifteen calls to somebody's API with a synthetic credential.
 *
 *   4. Every staged entry loads and its manifest validates, through the
 *      server's own catalog loader rather than a duck-type standing in for
 *      it. That loader is what runs at boot, and a manifest it refuses is
 *      *skipped*: pushed onto a list that produces one warn line and
 *      nothing else, leaving the catalog quietly short. Nothing about that
 *      is wrong at runtime, where a deployment may install whatever it
 *      likes and one bad integration must not take the server down. It is
 *      wrong in an image we build, so here the skip is fatal.
 *
 *      Running the real loader rather than restating it is the point. A
 *      reimplementation is a second opinion about validity, and the
 *      failure it cannot catch is the one where the two opinions differ,
 *      which is exactly the case that reaches production.
 *
 *   5. The client manifests resolve from the image. A client's code runs
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
 *   6. Worker-thread dispatch. Spawns dist/worker-entry.js with the
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
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
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
const LOAD_MANIFESTS_ENTRY =
  process.env.MARFA_VERIFY_LOAD_MANIFESTS ??
  resolve(HERE, "dist", "load-manifests.js");
const CLIENT_MANIFESTS_ENTRY =
  process.env.MARFA_VERIFY_CLIENT_MANIFESTS ??
  resolve(HERE, "dist", "client-manifests.js");
// The registry the staged integrations came from, carried into the image
// alongside the declaration and the pin. A directory rather than a bare
// file because a deployment declaring `none` has no integrations checkout
// and so no registry, and a COPY of an absent file fails a build where a
// COPY of an empty directory does not.
const REGISTRY =
  process.env.MARFA_VERIFY_INTEGRATIONS_REGISTRY ??
  resolve(HERE, "integrations-meta", "registry.json");
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
  for (const namespace of readdirSync(root, { withFileTypes: true })) {
    if (!namespace.isDirectory()) continue;
    const inner = readdirSync(resolve(root, namespace.name), {
      withFileTypes: true,
    });
    for (const leaf of inner) {
      if (leaf.isDirectory()) names.push(`${namespace.name}/${leaf.name}`);
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

// Check 2: everything this image installs is listed, and marked as
// something Marfa stands behind.
//
// The registry lists everything installable and marks the shorter set
// hosted Marfa stands behind. This image stages the declaration's set. The
// two are maintained in different repositories and agree today by
// attention, which is the arrangement this replaces.
//
// One direction only, and the direction is the whole design. Every declared
// name has to be listed and marked shipped, because an image installing
// something the listing does not stand behind is wrong whoever built it.
//
// The other direction, that every entry marked shipped is declared, is
// **not** checked here and must not be. Installing a subset is a supported
// shape: the declaration's own header tells an operator that removing a
// line is how they do it, and a self-hosted build of this Dockerfile would
// then fail on thirteen names in a repository they did not write, with
// advice they cannot act on. That direction is Marfa's own set being
// complete, which is a property of this repository rather than of the
// image, so `image-build.yml` checks it where only our builds run.
//
// An entry marked `shippedByMarfa: false` is an ordinary thing to be:
// listed and nothing more. It is not something this image may install.
function readRegistry(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(
      `the integrations registry at ${path} could not be read: ${String(err)}`,
    );
  }
  const listed = parsed?.integrations;
  if (!Array.isArray(listed)) {
    fail(
      `${path} has no "integrations" array, so the verification cannot tell ` +
        `what the registry lists.`,
    );
  }
  const shipped = new Set();
  const seen = new Set();
  for (const entry of listed) {
    if (typeof entry?.name !== "string") {
      fail(`${path} holds an entry with no string "name"`);
    }
    if (typeof entry.shippedByMarfa !== "boolean") {
      fail(
        `${path}: "${entry.name}" has no boolean "shippedByMarfa", so ` +
          `whether this image should install it is unanswerable.`,
      );
    }
    // A duplicate is refused rather than deduplicated. Two entries for one
    // identifier disagree about everything else in the object, and a
    // membership test cannot see which one it answered from.
    if (seen.has(entry.name)) {
      fail(`${path} lists "${entry.name}" more than once`);
    }
    seen.add(entry.name);
    if (entry.shippedByMarfa) shipped.add(entry.name);
  }
  return shipped;
}

if (!existsSync(REGISTRY)) {
  // No registry means the build had no integrations checkout, which is
  // coherent only for a deployment that installs nothing. Anything else
  // would already have failed in the staging loop; saying so here names
  // the reason rather than leaving a later check to fail obscurely.
  if (declared.length > 0) {
    fail(
      `no registry at ${REGISTRY}, yet the declaration names ` +
        `${String(declared.length)} integrations. The build staged them from ` +
        `a checkout that carried no registry.`,
    );
  }
  info(`no integrations checkout and nothing declared; no registry to hold`);
} else {
  const shipped = readRegistry(REGISTRY);
  const unlisted = declared.filter((name) => !shipped.has(name));
  if (unlisted.length > 0) {
    fail(
      `${DECLARATION} declares these and the registry does not mark them ` +
        `shippedByMarfa: ${unlisted.join(", ")}. This image would install ` +
        `something the listing says Marfa does not stand behind. Add the ` +
        `registry entry, or stop declaring it.`,
    );
  }
  info(
    `all ${String(declared.length)} declared integrations are listed and ` +
      `marked shipped, out of ${String(shipped.size)} the registry marks`,
  );
}

// Check 3: the runtime kit stayed external to every staged bundle.
//
// Both kit packages hold module-singleton state, so a bundle that inlined
// one registers its handlers into a table the dispatcher never reads. There
// is no error: the dispatch comes back reporting no handler, and only for
// that one integration.
//
// Read from the emitted bytes, because the emitted bytes are all the image
// has. A bundler config would say this more directly and neither
// `tsup.config.ts` nor `package.json` is staged, so there is nothing here
// to read but the output. That turns out to be the better place anyway:
// tsup externalizes `dependencies` and `peerDependencies` before it reads
// an `external` list at all, so the config states the rule in two places
// and the output states the result once.
//
// The specifier is what survives. `@withmarfa/runtime-sdk` can appear in
// emitted JavaScript only as an import or export specifier, so inlining
// does not mangle it, it removes it. Both spellings count, because a
// dynamic import resolves upward exactly as a static one does.
const RUNTIME_KIT = "@withmarfa/runtime-sdk";
const SHARED_KIT = "@withmarfa/shared";
const bareSpecifier = (pkg) => {
  const quoted = `["']${pkg.replaceAll("/", "\\/")}["']`;
  return new RegExp(`(?:from\\s*${quoted}|import\\s*\\(\\s*${quoted})`);
};

// Every emitted file, not the entry alone. tsup leaves a single-entry
// package as one file today, and esbuild splits an ESM build the moment a
// package grows a second entry: the imports move into a chunk and the entry
// becomes a re-export carrying no specifier at all. Judging the entry alone
// would then refuse a correctly built integration and send its author
// looking for an inlined kit that is not there.
function emittedFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(resolve(entry.parentPath, entry.name));
    }
  }
  return files;
}

for (const staged of [
  ...entries.map((e) => ({ name: e.name, dispatchable: true })),
  ...manifestOnly.map((e) => ({ name: e.name, dispatchable: false })),
]) {
  const dist = resolve(INTEGRATIONS_ROOT, staged.name, "dist");
  // At least one, because check 1 has already required an entry file by
  // name for whichever shape this is.
  const files = emittedFiles(dist);
  const texts = files.map((file) => ({
    file,
    text: readFileSync(file, "utf8"),
  }));

  // A dispatchable integration registers handlers, and the only way to
  // register one is through the kit, so the specifier missing from every
  // emitted file means the kit was inlined rather than that the package had
  // no use for it. One that genuinely registers nothing is a manifest-only
  // integration that did not say so, which the declaration has a marker for
  // and this refuses in the same breath.
  if (
    staged.dispatchable &&
    !texts.some(({ text }) => bareSpecifier(RUNTIME_KIT).test(text))
  ) {
    fail(
      `${staged.name} staged a dispatchable dist/ with no bare ` +
        `"${RUNTIME_KIT}" import in any of its ${String(files.length)} ` +
        `emitted files. Either its build inlined the kit, in which case its ` +
        `handlers register into a copy nothing dispatches from, or it ` +
        `registers no handlers at all and is manifest-only.`,
    );
  }

  // And whichever of the two a file mentions, it mentions as a specifier.
  // This is the weaker half: a kit package inlined cleanly leaves nothing
  // behind to catch, so what this refuses is the partial case, where the
  // name survives somewhere the import statement did not.
  for (const { file, text } of texts) {
    for (const pkg of [RUNTIME_KIT, SHARED_KIT]) {
      if (text.includes(pkg) && !bareSpecifier(pkg).test(text)) {
        fail(
          `${staged.name}'s ${basename(file)} names "${pkg}" in some form ` +
            `other than a bare import specifier, which is what a partially ` +
            `inlined kit looks like from outside.`,
        );
      }
    }
  }
}
info(
  `the runtime kit is external to all ` +
    `${String(entries.length + manifestOnly.length)} staged bundles`,
);

// Check 4: every staged entry loads, and its manifest is one the catalog
// will accept. Both shapes, not only the dispatchable ones: the catalog
// reconcile imports a manifest-only entry at boot exactly as the runtime
// loader imports a handler entry, so a truncated one is a boot failure this
// is the last chance to refuse. Loading also runs each handler entry's
// registerHandlers() against this process's registry; that registry is
// throwaway here, so the overwrites are harmless.
//
// Through the server's own loader, not a duck-type shaped like it. That
// loader is the one that runs at boot, it finds the manifest export the
// same duck-typed way, and it validates what it finds. Restating any of
// that here would be a second opinion about validity whose only
// interesting case is the one where the two disagree.
//
// The declared names are handed in rather than discovered, so a failure
// names the declaration's own name. Check 1 has already proved the two
// agree.
let loadInTreeManifests;
try {
  ({ loadInTreeManifests } = await import(
    pathToFileURL(LOAD_MANIFESTS_ENTRY).href
  ));
} catch (err) {
  fail(
    `the catalog manifest loader could not be loaded from ` +
      `${LOAD_MANIFESTS_ENTRY}: ${String(err)}`,
  );
}
if (typeof loadInTreeManifests !== "function") {
  fail(`${LOAD_MANIFESTS_ENTRY} exports no loadInTreeManifests function`);
}

const loaded = await loadInTreeManifests({
  integrationsRoot: INTEGRATIONS_ROOT,
  integrationDirs: declared,
});

// A skip is fatal here and is not at boot, and the difference is
// deliberate. At runtime a deployment installs what it likes and one
// unreadable integration must not take the server down, so the loader
// records the reason and the catalog comes up short by one. In an image we
// build, coming up short by one is the defect: the reconcile would log a
// line nobody reads and the integration would simply not be installable.
if (loaded.skipped.length > 0) {
  fail(
    `the catalog loader refused ${String(loaded.skipped.length)} of ` +
      `${String(declared.length)} staged integrations: ` +
      loaded.skipped
        .map((skip) => `${skip.dirName} (${skip.reason})`)
        .join("; ") +
      `. At boot each of these is a warn line and an integration missing ` +
      `from the catalog.`,
  );
}

// A manifest naming an integration other than the directory it was staged
// into. The loader tolerates it, because a deployment may install into
// whatever directory it likes; the image may not. Everything that stages,
// declares and installs here keys on the identifier being the path.
const misfiled = loaded.manifests.filter(
  (entry) => entry.name !== entry.dirName,
);
if (misfiled.length > 0) {
  fail(
    `staged under a directory that is not the manifest's own name: ` +
      misfiled
        .map((entry) => `${entry.dirName} declares "${entry.name}"`)
        .join(", ") +
      `. The declaration, the staging path and the catalog all key on the ` +
      `identifier, so these would disagree about which integration this is.`,
  );
}

info(
  `all ${String(loaded.manifests.length)} staged manifests load and validate`,
);

// The three fields the server's own catalog loader requires before it will
// even attempt validation, and all check 5 needs. A client manifest is a
// typed constant in this repository rather than something read off a disk,
// and the boot reconcile hands it straight to registration without
// validating it, so what is in question is whether the prune left it
// resolvable rather than whether it is well formed. The installed set is
// the other way round and runs the real validator; see check 4.
function usableManifest(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    "manifest_schema_version" in value &&
    typeof value.name === "string" &&
    "version" in value
  );
}

// Check 5: the client manifests this build ships resolve from the image.
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

// Check 6: worker-thread dispatch through the dispatch fixture.
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
      // The dispatch clock. Sent because this request is built by shape
      // rather than through `WorkerDispatchRequest`, so nothing here fails
      // to compile when the worker starts needing a new field.
      startedAtMs: Date.now(),
      softLimitMs: 60_000,
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
