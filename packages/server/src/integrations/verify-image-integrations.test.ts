/**
 * The in-image verification, exercised outside an image.
 *
 * The script runs as a RUN step in the Dockerfile, where the only way to
 * learn it had stopped objecting to anything would be to ship an image it
 * should have refused. Its checks are the last thing between a bad staging
 * step and a substrate that boots empty in production, so they are driven
 * from here too, against a scratch tree.
 *
 * Every path it takes is drivable from outside: the integrations root, the
 * declaration, the worker entry and the dispatch fixture are all
 * env-addressable.
 *
 * **What the dispatch cases here do and do not prove.** They stand in a
 * fake worker entry that loads the fixture and answers, so they pin the
 * script's half of the protocol: that it waits for the worker to come up,
 * hands it the fixture rather than an installed integration, and treats a
 * not-ok result as a failure. They do not prove module resolution inside a
 * real image, because a real worker entry and a real built integration are
 * the two things an image has and a unit test does not. That proof stays
 * the image build's, and it is the reason the check exists at all; what is
 * pinned here is that the script would notice.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../scripts/verify-image-integrations.mjs",
);

let scratchRoot: string | undefined;

afterEach(() => {
  if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
  scratchRoot = undefined;
});

/**
 * The smallest export the verification accepts as a manifest: the three
 * fields the server's catalog loader requires, plus one trigger. Writing
 * less than this would make every fixture fail for the wrong reason.
 *
 * The trigger is not decoration. A server-run manifest declaring none is
 * incoherent and the real loader refuses it, so a fixture without one is
 * not a smaller version of a staged manifest — it is a manifest that would
 * never have been staged, and it would fail the authoring check while
 * standing in for one that could not. A client-run fixture gets none, for
 * the same reason in reverse: nothing on this side fires a trigger for code
 * that runs somewhere else.
 *
 * A dispatchable entry also carries the bare kit import a real bundle
 * carries, because a real one always does: registering a handler is the
 * only thing a `dist/local.js` is for, and the only way to register one is
 * through the kit. An entry written without it is the inlined-bundle case
 * rather than a smaller version of the same thing.
 */
function manifestSource(
  name: string,
  options: {
    kit?: "bare" | "none" | "partial";
    /** Stage a manifest that says its code runs on the user's machine. */
    runsOn?: "server" | "client";
    /** Extra manifest fields, for the cases about what a manifest says. */
    extra?: Record<string, unknown>;
  } = {},
): string {
  const manifest = `export const manifest = ${JSON.stringify({
    manifest_schema_version: "2.0.0",
    name,
    version: "1.0.0",
    ...(options.runsOn ? { runs_on: options.runsOn } : {}),
    ...(options.runsOn === "client"
      ? {}
      : { triggers: [{ type: "schedule", config: { cron: "*/5 * * * *" } }] }),
    ...options.extra,
  })};\n`;
  switch (options.kit ?? "none") {
    case "bare":
      // Resolves upward to the scratch root's node_modules, which is the
      // arrangement the image has and the whole reason the specifier must
      // stay bare.
      return `import { registerScheduleHandler } from "@withmarfa/runtime-sdk";\nregisterScheduleHandler(() => ({ ok: true }));\n${manifest}`;
    case "partial":
      // The name survives somewhere the import statement did not, which is
      // what a half-inlined bundle looks like from outside.
      return `// bundled from node_modules/@withmarfa/runtime-sdk/dist/index.js\nconst registerScheduleHandler = () => {};\nregisterScheduleHandler();\n${manifest}`;
    default:
      return manifest;
  }
}

/**
 * The kit packages, written into the scratch root so a staged entry's bare
 * specifier resolves upward the way it does from `/app/integrations` to
 * `/app/node_modules`. Staging a copy beside an entry instead is the
 * failure that arrangement exists to prevent, so the fixture has to have
 * the arrangement for the entries to mean anything.
 */
function writeKitPackages(root: string): void {
  for (const pkg of ["runtime-sdk", "shared"]) {
    const dir = join(root, "node_modules", "@withmarfa", pkg);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      `{"name":"@withmarfa/${pkg}","type":"module","main":"index.js"}\n`,
    );
    writeFileSync(
      join(dir, "index.js"),
      "export const registerScheduleHandler = () => {};\n",
    );
  }
}

/** How the stand-in worker answers a dispatch. */
type WorkerBehavior = "ok" | "not-ok" | "silent";

interface Image {
  integrationsRoot: string;
  declaration: string;
  fixtureRoot: string;
  workerEntry: string;
  clientManifests: string;
  registry: string;
  loadManifests: string;
}

/** A registry entry, as `registry.json` in the integrations repository
 *  carries it. `shippedByMarfa` is the field the declaration is held to. */
interface RegistryEntry {
  name: string;
  shippedByMarfa: boolean;
}

/**
 * The names a declaration line list actually declares, which is what the
 * default registry mirrors. Written the way the parser reads it rather than
 * assumed, so a case passing a marker or a comment still gets a registry
 * that agrees with it.
 */
function declaredNames(lines: string[]): string[] {
  return lines
    .map((line) => line.replace(/#.*$/, "").trim().split(/\s+/)[0] ?? "")
    .filter((name) => name.length > 0 && name !== "none");
}

/**
 * A stand-in for the built `dist/client-manifests.js`. Names are manifest
 * names; one suffixed `!unusable` resolves but is not a manifest.
 */
function clientManifestsSource(clients: string[]): string {
  const entries = clients.map((raw) => {
    const [name, shape] = raw.split("!");
    return {
      name: name ?? raw,
      manifest:
        shape === "unusable"
          ? { note: "not a manifest" }
          : {
              manifest_schema_version: "2.0.0",
              name: name ?? raw,
              version: "1.0.0",
            },
    };
  });
  return `export const CLIENT_MANIFESTS = ${JSON.stringify(entries)};\n`;
}

/**
 * A scratch image layout. `installed` are `<namespace>/<name>` directories
 * under the integrations root; a name suffixed `!manifest` gets a
 * manifest-only
 * entry, `!empty` gets a directory with nothing built in it, `!bare` gets a
 * handler entry that exports no manifest, `!bare-manifest` gets a
 * manifest-only entry that exports none, and `!dishonest` gets one
 * declaring a field it has no honest value for.
 *
 * `declared` lines are written verbatim, so a caller can pass a marker or a
 * malformed line as easily as a name.
 */
function image(options: {
  declared: string[];
  installed: string[];
  fixture?: boolean;
  worker?: WorkerBehavior;
  /** Client manifests the build claims to ship. Defaults to one usable. */
  clients?: string[];
  /**
   * The entry imports a package that is not installed, which is what the
   * deploy prune dropping a client manifest package looks like from inside
   * the image. Not a per-client shape, so it gets its own flag.
   */
  clientsUnresolvable?: boolean;
  /** The entry loads but exports no CLIENT_MANIFESTS. */
  clientsBare?: boolean;
  /**
   * The registry the integrations were staged from. Defaults to one entry
   * per declared name, all `shippedByMarfa`, so a case that says nothing
   * about the registry still runs the check rather than skipping it.
   * `null` writes no registry at all, which is what a build with no
   * integrations checkout leaves behind.
   */
  registry?: RegistryEntry[] | null;
  /** Written verbatim in place of the registry, for the malformed cases. */
  registryText?: string;
  /** Manifest names the stand-in loader refuses, as the real one refuses a
   *  manifest that fails validation. */
  invalidManifests?: string[];
  /** The loader entry imports a package that is not installed. */
  loaderUnresolvable?: boolean;
  /** The loader entry loads and exports nothing callable. */
  loaderBare?: boolean;
}): Image {
  scratchRoot = mkdtempSync(join(tmpdir(), "marfa-verify-image-"));
  // The staged entries are ESM `.js`, which in a real image resolves
  // through the deployed server's own package.json. Mirror that rather
  // than renaming the fixtures, so the import path under test is the one
  // the image takes.
  writeFileSync(join(scratchRoot, "package.json"), '{"type":"module"}\n');
  writeKitPackages(scratchRoot);

  const integrationsRoot = join(scratchRoot, "integrations");
  mkdirSync(integrationsRoot, { recursive: true });
  for (const raw of options.installed) {
    const [name, shape] = raw.split("!");
    const dir = join(integrationsRoot, name ?? raw);
    mkdirSync(dir, { recursive: true });
    if (shape === "empty") continue;
    const dist = join(dir, "dist");
    mkdirSync(dist, { recursive: true });
    const manifestOnly =
      shape === "manifest" ||
      shape === "bare-manifest" ||
      shape === "manifest-partial";
    const bare = shape === "bare" || shape === "bare-manifest";
    // A manifest-only entry imports nothing: its source is a manifest and
    // a type-only import, and the type is erased before the bundler runs.
    const kit =
      shape === "manifest-partial"
        ? "partial"
        : manifestOnly || shape === "inlined"
          ? "none"
          : "bare";
    // The misfiled shape stages an entry whose manifest names an
    // integration other than the directory holding it.
    const declaresName = shape === "misfiled" ? `other/${name ?? raw}` : name;
    if (shape === "split") {
      // What esbuild emits once a package has more than one entry: the
      // imports move into a chunk and the entry becomes a re-export.
      writeFileSync(
        join(dist, "chunk-ABCDEFGH.js"),
        manifestSource(name ?? raw, { kit: "bare" }),
      );
      writeFileSync(
        join(dist, "local.js"),
        'export { manifest } from "./chunk-ABCDEFGH.js";\n',
      );
      continue;
    }
    if (shape === "dishonest") {
      // A manifest declaring a webhook verification method with no webhook
      // trigger: the shape twelve of sixteen manifests carried while the
      // schema demanded a value from every one of them. It validates, it is
      // coherent, and it tells a reader this integration verifies
      // deliveries it can never receive.
      writeFileSync(
        join(dist, "local.js"),
        manifestSource(name ?? raw, {
          kit: "bare",
          extra: { webhook_verification: { method: "hmac-sha256" } },
        }),
      );
      continue;
    }
    if (shape === "client-run") {
      // A client staged into the integrations root, which the Dockerfile's
      // staging step says in a comment must never happen. The comment is not
      // enforcement; this is.
      writeFileSync(
        join(dist, "local.js"),
        manifestSource(name ?? raw, { kit: "bare", runsOn: "client" }),
      );
      continue;
    }
    writeFileSync(
      join(dist, manifestOnly ? "manifest.js" : "local.js"),
      bare
        ? `${
            manifestOnly
              ? ""
              : 'import { registerScheduleHandler } from "@withmarfa/runtime-sdk";\nregisterScheduleHandler(() => ({ ok: true }));\n'
          }export const somethingElse = 1;\n`
        : manifestSource(declaresName ?? raw, { kit }),
    );
  }

  const declaration = join(scratchRoot, "installed-integrations.txt");
  writeFileSync(
    declaration,
    `# a comment, and a blank line follow\n\n${options.declared.join("\n")}\n`,
  );

  const fixtureRoot = join(scratchRoot, "verify-fixtures");
  if (options.fixture === true) {
    const dist = join(fixtureRoot, "dispatch-integration", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      join(dist, "local.js"),
      manifestSource("acme/dispatch-fixture", { kit: "bare" }),
    );
  }

  // A stand-in for dist/worker-entry.js. It imports whatever handler path
  // it was given, so a run that hands it the wrong fixture fails here
  // rather than passing on a path nobody checked.
  const workerEntry = join(scratchRoot, "worker-entry.js");
  const behavior: WorkerBehavior = options.worker ?? "ok";
  writeFileSync(
    workerEntry,
    behavior === "silent"
      ? "// never reports ready\n"
      : `import { parentPort, workerData } from "node:worker_threads";
const mod = await import(workerData.handlerModulePath);
const loaded = typeof mod.manifest === "object";
parentPort.postMessage({ kind: "ready" });
parentPort.on("message", () => {
  // The real WorkerDispatchResponse carries no discriminant. Posting one
  // with a \`kind\` would let a later tightening of the script's message
  // filter stay green here and fail in every image.
  parentPort.postMessage({
    result: ${behavior === "ok" ? "{ ok: loaded }" : '{ ok: false, reason: "no_schedule_handler_registered" }'},
    cursorUpdates: {},
    cursorDeletes: [],
  });
});
`,
  );

  // The built client-manifest entry. Every case gets a usable one by
  // default, so a test that says nothing about clients still runs the
  // check rather than skipping it.
  const clientManifests = join(scratchRoot, "client-manifests.js");
  writeFileSync(
    clientManifests,
    options.clientsUnresolvable === true
      ? 'export { CLIENT_MANIFESTS } from "@withmarfa/not-installed";\n'
      : options.clientsBare === true
        ? "export const somethingElse = 1;\n"
        : clientManifestsSource(options.clients ?? ["marfa/sync"]),
  );

  // The registry the build staged from, which in an image is copied out of
  // the integrations checkout. Absent when the build had no checkout.
  const registry = join(scratchRoot, "registry.json");
  if (options.registryText !== undefined) {
    writeFileSync(registry, options.registryText);
  } else if (options.registry !== null) {
    const entries =
      options.registry ??
      declaredNames(options.declared).map((name) => ({
        name,
        shippedByMarfa: true,
      }));
    writeFileSync(registry, `${JSON.stringify({ integrations: entries })}\n`);
  }

  // A stand-in for the built dist/load-manifests.js, mirroring the real
  // loader's shape: the same entry candidates, the same duck-typed export
  // search, the same skip-with-a-reason rather than a throw. What it does
  // not do is validate, which is the one thing a scratch tree cannot
  // exercise cheaply; `invalidManifests` stands in for a validation
  // refusal, and load-manifests.test.ts covers the real one.
  const loadManifests = join(scratchRoot, "load-manifests.js");
  const invalid = JSON.stringify(options.invalidManifests ?? []);
  writeFileSync(
    loadManifests,
    options.loaderUnresolvable === true
      ? 'export { loadInTreeManifests } from "@withmarfa/not-installed";\n'
      : options.loaderBare === true
        ? "export const somethingElse = 1;\n"
        : `import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const INVALID = new Set(${invalid});
const looksLikeManifest = (v) =>
  typeof v === "object" && v !== null &&
  "manifest_schema_version" in v && "name" in v && "version" in v;
export async function loadInTreeManifests({ integrationsRoot, integrationDirs }) {
  const manifests = [];
  const skipped = [];
  for (const dirName of integrationDirs) {
    let entryPath;
    for (const candidate of ["local.js", "manifest.js"]) {
      const p = resolve(integrationsRoot, dirName, "dist", candidate);
      if (existsSync(p)) { entryPath = p; break; }
    }
    if (!entryPath) {
      skipped.push({ dirName, reason: "no built manifest entry" });
      continue;
    }
    let mod;
    try {
      mod = await import(pathToFileURL(entryPath).href);
    } catch (err) {
      skipped.push({ dirName, reason: \`import failed: \${String(err)}\` });
      continue;
    }
    const raw = looksLikeManifest(mod.manifest)
      ? mod.manifest
      : Object.values(mod).find(looksLikeManifest);
    if (raw === undefined) {
      skipped.push({ dirName, reason: "no manifest export found" });
      continue;
    }
    if (INVALID.has(raw.name)) {
      skipped.push({ dirName, reason: "manifest failed validation: publisher: Required" });
      continue;
    }
    manifests.push({ name: raw.name, dirName, manifest: raw });
  }
  return { manifests, skipped };
}
`,
  );

  return {
    integrationsRoot,
    declaration,
    fixtureRoot,
    workerEntry,
    clientManifests,
    registry,
    loadManifests,
  };
}

interface Run {
  code: number;
  output: string;
}

function verify(img: Image, overrides: Record<string, string> = {}): Run {
  try {
    const output = execFileSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        MARFA_INTEGRATIONS_ROOT: img.integrationsRoot,
        MARFA_INSTALLED_INTEGRATIONS: img.declaration,
        MARFA_VERIFY_FIXTURE_ROOT: img.fixtureRoot,
        MARFA_VERIFY_WORKER_ENTRY: img.workerEntry,
        MARFA_VERIFY_CLIENT_MANIFESTS: img.clientManifests,
        MARFA_VERIFY_INTEGRATIONS_REGISTRY: img.registry,
        MARFA_VERIFY_LOAD_MANIFESTS: img.loadManifests,
        ...overrides,
      },
    });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      code: e.status ?? 1,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

describe("the in-image integration verification", () => {
  it("passes an image that installs exactly what it declares", () => {
    const run = verify(
      image({
        declared: ["acme/alpha", "acme/beta manifest-only"],
        installed: ["acme/alpha", "acme/beta!manifest"],
        fixture: true,
      }),
    );
    expect(run.output).toContain("2 declared integrations all installed");
    expect(run.output).toContain("1 dispatchable");
    expect(run.output).toContain("all 2 declared integrations are listed");
    expect(run.output).toContain("runtime kit is external to all 2");
    expect(run.output).toContain("all 2 staged manifests load and validate");
    // The other half of the authoring check below: a green run here is what
    // says it refuses a dishonest manifest rather than every manifest.
    expect(run.output).toContain("declare only what is true of them");
    expect(run.output).toContain("PASSED");
    expect(run.code).toBe(0);
  });

  it("refuses an image whose client manifest no longer resolves", () => {
    // The one thing the deploy prune can break that nothing else sees. A
    // client's manifest is not installed into the integrations root, so
    // checks 1 and 2 walk straight past it; it rides in as a production
    // dependency, and demoting it to devDependencies passes the suite,
    // passes smoke:boot against the monorepo, and crashes the container.
    const run = verify(
      image({ declared: ["none"], installed: [], clientsUnresolvable: true }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("client manifests could not be loaded");
    expect(run.output).toContain("crash at startup");
  });

  it("refuses a client manifest that resolves but is not a manifest", () => {
    const run = verify(
      image({
        declared: ["none"],
        installed: [],
        clients: ["marfa/sync!unusable"],
      }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("is not a usable manifest");
    expect(run.output).toContain("marfa/sync");
  });

  it("refuses an entry that says nothing about what the build ships", () => {
    const run = verify(
      image({ declared: ["none"], installed: [], clientsBare: true }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("exports no CLIENT_MANIFESTS array");
  });

  it("checks the client manifests even when the image installs nothing", () => {
    // The dispatch check exits early on an empty image, which is why the
    // client check runs before it: a deployment that installs no
    // integrations still ships every client the build knows about.
    const run = verify(image({ declared: ["none"], installed: [] }));
    expect(run.output).toContain("1 client manifest resolves");
    expect(run.output).toContain("marfa/sync");
    expect(run.code).toBe(0);
  });

  it("accepts a build that ships no client manifests", () => {
    const run = verify(
      image({ declared: ["none"], installed: [], clients: [] }),
    );
    expect(run.output).toContain("no client manifests to resolve");
    expect(run.code).toBe(0);
  });

  it("fails, by name, on a declared integration that is not installed", () => {
    const run = verify(
      image({
        declared: ["acme/alpha", "acme/beta"],
        installed: ["acme/alpha"],
      }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("declared but not installed");
    expect(run.output).toContain("acme/beta");
  });

  it("fails, by name, on an installed integration nobody declared", () => {
    // The shape that once shipped the scaffold: present in the image, named
    // in nothing, and invisible to a check that only counted.
    //
    // The dispatch fixture is the live instance of that risk now, and it is
    // flat, so it is also the flat-leftover case. Walking two levels reports
    // it as `dispatch-integration/dist`, because `dist` is the only
    // subdirectory a wrongly staged one-level tree has — which is how a
    // staging step that put the fixture in the integrations root instead of
    // beside it fails here rather than shipping.
    const run = verify(
      image({
        declared: ["acme/alpha"],
        installed: ["acme/alpha", "dispatch-integration"],
      }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("installed but not declared");
    expect(run.output).toContain("dispatch-integration/dist");
  });

  it("fails on a declared integration that built nothing", () => {
    const run = verify(
      image({ declared: ["acme/alpha"], installed: ["acme/alpha!empty"] }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("staged no dist/local.js");
  });

  it("fails when a dispatchable integration built only a manifest", () => {
    // The shrink a bare name list cannot see: the directory is still
    // there, so the set looks unchanged, but one fewer integration can be
    // dispatched to.
    const run = verify(
      image({ declared: ["acme/alpha"], installed: ["acme/alpha!manifest"] }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("mark it manifest-only");
  });

  it("fails when a manifest-only integration built a handler", () => {
    const run = verify(
      image({
        declared: ["acme/beta manifest-only"],
        installed: ["acme/beta"],
      }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("declared manifest-only");
    expect(run.output).toContain("drop the marker");
  });

  it("fails when a manifest-only entry exports no manifest", () => {
    // The catalog reconcile imports these at boot exactly as the runtime
    // loader imports a handler entry, so an unreadable one is a boot
    // failure and this is the last place to refuse it.
    const run = verify(
      image({
        declared: ["acme/beta manifest-only"],
        installed: ["acme/beta!bare-manifest"],
      }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("the catalog loader refused 1 of 1");
    expect(run.output).toContain("acme/beta (no manifest export found)");
  });

  it("fails when a staged entry exports no manifest", () => {
    const run = verify(
      image({
        declared: ["acme/alpha"],
        installed: ["acme/alpha!bare"],
        fixture: true,
      }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("acme/alpha (no manifest export found)");
  });

  it("passes an image that declares it installs nothing", () => {
    // The shape a deployment installing its own integrations starts from.
    // An empty COPY leaves no directory behind, so a missing root has to
    // read as an empty set rather than as a fault, the way the runtime's
    // own discovery already reads it.
    const img = image({ declared: ["none"], installed: [] });
    const run = verify(img, {
      MARFA_INTEGRATIONS_ROOT: join(img.integrationsRoot, "absent"),
    });
    expect(run.output).toContain("0 declared integrations all installed");
    expect(run.code).toBe(0);
  });

  it("refuses a declaration that names nothing and does not say so", () => {
    // An empty file is what a bad merge leaves behind. Only the word makes
    // it an intention.
    const run = verify(image({ declared: [], installed: [] }));
    expect(run.code).toBe(1);
    expect(run.output).toContain("lost its body");
  });

  it("still fails on a missing root when something was declared", () => {
    const img = image({ declared: ["acme/alpha"], installed: [] });
    const run = verify(img, {
      MARFA_INTEGRATIONS_ROOT: join(img.integrationsRoot, "absent"),
    });
    expect(run.code).toBe(1);
    expect(run.output).toContain("declared but not installed");
    expect(run.output).toContain("acme/alpha");
  });

  it("refuses to skip the dispatch proof when something dispatches", () => {
    const run = verify(
      image({ declared: ["acme/alpha"], installed: ["acme/alpha"] }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("dispatch fixture is missing");
  });

  it("fails when the worker never comes up", () => {
    const run = verify(
      image({
        declared: ["acme/alpha"],
        installed: ["acme/alpha"],
        fixture: true,
        worker: "silent",
      }),
      // Only this case waits out a budget, so only this case shortens one.
      // Every other case spawns a worker that answers, and the real ten
      // second budget is the margin those need on a machine that also runs
      // the CI pool: a shortened one there would be a timing test nobody
      // asked for.
      { MARFA_VERIFY_READY_TIMEOUT_MS: "1500" },
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("worker not ready");
  });

  it("fails when the dispatch comes back not-ok", () => {
    // The module-resolution failure this check exists for reports exactly
    // this way: the handler registers into one registry and the dispatch
    // reads another.
    const run = verify(
      image({
        declared: ["acme/alpha"],
        installed: ["acme/alpha"],
        fixture: true,
        worker: "not-ok",
      }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("dispatch returned not-ok");
    expect(run.output).toContain("duplicate copy");
  });

  // Check 2: the declaration and the registry, which live in different
  // repositories and until now agreed only by attention.
  it("passes an image that installs a subset of what the registry ships", () => {
    // Installing a subset is a supported shape and the declaration's own
    // header says so, so a build of this Dockerfile that is not ours must
    // not fail on names in a repository its operator did not write. The
    // reverse direction, that our own declaration is complete, is asserted
    // in the image-build workflow where only our builds run.
    const run = verify(
      image({
        declared: ["acme/alpha"],
        installed: ["acme/alpha"],
        fixture: true,
        registry: [
          { name: "acme/alpha", shippedByMarfa: true },
          { name: "acme/beta", shippedByMarfa: true },
        ],
      }),
    );
    expect(run.output).toContain("out of 2 the registry marks");
    expect(run.code).toBe(0);
  });

  it("fails when a registry lists one identifier twice", () => {
    // Two entries for one identifier disagree about everything else in the
    // object, and a membership test cannot see which one it answered from.
    const run = verify(
      image({
        declared: ["acme/alpha"],
        installed: ["acme/alpha"],
        fixture: true,
        registry: [
          { name: "acme/alpha", shippedByMarfa: true },
          { name: "acme/alpha", shippedByMarfa: false },
        ],
      }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain('lists "acme/alpha" more than once');
  });

  it("fails when the declaration installs something the registry does not stand behind", () => {
    const run = verify(
      image({
        declared: ["acme/alpha"],
        installed: ["acme/alpha"],
        fixture: true,
        registry: [{ name: "acme/alpha", shippedByMarfa: false }],
      }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("does not mark them shippedByMarfa");
    expect(run.output).toContain("acme/alpha");
  });

  it("passes a registry entry that is listed and not shipped", () => {
    // Listed and nothing more is an ordinary thing for an integration to
    // be, so it belongs in neither set and is not a finding.
    const run = verify(
      image({
        declared: ["acme/alpha"],
        installed: ["acme/alpha"],
        fixture: true,
        registry: [
          { name: "acme/alpha", shippedByMarfa: true },
          { name: "acme/community-thing", shippedByMarfa: false },
        ],
      }),
    );
    expect(run.output).toContain("all 1 declared integrations are listed");
    expect(run.code).toBe(0);
  });

  it("accepts no registry when the deployment installs nothing", () => {
    // A declaration reading `none` needs no integrations checkout, so
    // there is no registry to have copied.
    const run = verify(
      image({ declared: ["none"], installed: [], registry: null }),
    );
    expect(run.output).toContain(
      "no integrations checkout and nothing declared",
    );
    expect(run.code).toBe(0);
  });

  it("fails on a missing registry when something was declared", () => {
    const run = verify(
      image({
        declared: ["acme/alpha"],
        installed: ["acme/alpha"],
        fixture: true,
        registry: null,
      }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("no registry at");
    expect(run.output).toContain("carried no registry");
  });

  it("fails on a registry it cannot read as a listing", () => {
    const run = verify(
      image({
        declared: ["none"],
        installed: [],
        registryText: '{"entries":[]}\n',
      }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain('has no "integrations" array');
  });

  it("fails on a registry entry that does not say whether Marfa ships it", () => {
    const run = verify(
      image({
        declared: ["acme/alpha"],
        installed: ["acme/alpha"],
        fixture: true,
        registryText: '{"integrations":[{"name":"acme/alpha"}]}\n',
      }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain('no boolean "shippedByMarfa"');
    expect(run.output).toContain("acme/alpha");
  });

  // Check 3: the runtime kit stayed external. Both kit packages hold
  // module-singleton state, so an inlined copy registers handlers into a
  // table nothing dispatches from, silently and for one integration only.
  it("fails when a dispatchable bundle inlined the runtime kit", () => {
    const run = verify(
      image({
        declared: ["acme/alpha"],
        installed: ["acme/alpha!inlined"],
        fixture: true,
      }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain('no bare "@withmarfa/runtime-sdk" import');
    expect(run.output).toContain("acme/alpha");
  });

  it("fails when a bundle names the kit somewhere other than an import", () => {
    // The half-inlined case, and the only shape the weaker of the two
    // rules has to catch on its own: a dispatchable entry missing the
    // specifier is already refused by the rule above, so this reaches a
    // manifest-only entry, which is not required to import anything and so
    // is judged only on what it does mention. A cleanly inlined package
    // leaves nothing behind at all, which neither rule can see.
    const run = verify(
      image({
        declared: ["acme/beta manifest-only"],
        installed: ["acme/beta!manifest-partial"],
      }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("other than a bare import specifier");
    expect(run.output).toContain("acme/beta");
  });

  it("accepts an entry whose kit import moved into a chunk", () => {
    // esbuild splits an ESM build the moment a package grows a second
    // entry, and the entry file then carries no specifier at all. Judging
    // the entry alone would refuse a correctly built integration and send
    // its author looking for an inlined kit that is not there.
    const run = verify(
      image({
        declared: ["acme/alpha"],
        installed: ["acme/alpha!split"],
        fixture: true,
      }),
    );
    expect(run.output).toContain("runtime kit is external to all 1");
    expect(run.code).toBe(0);
  });

  it("does not ask a manifest-only entry to import the kit", () => {
    // Its source is a manifest and a type-only import, and the type is
    // erased before the bundler runs, so a real one imports nothing.
    const run = verify(
      image({
        declared: ["acme/beta manifest-only"],
        installed: ["acme/beta!manifest"],
      }),
    );
    expect(run.output).toContain("runtime kit is external to all 1");
    expect(run.code).toBe(0);
  });

  // Check 4: the catalog loader, which at boot skips what it cannot read
  // and here is not allowed to skip anything.
  it("fails on a manifest the catalog loader would refuse", () => {
    // At boot this is one warn line and an integration missing from the
    // catalog. In an image we build it is the defect.
    const run = verify(
      image({
        declared: ["acme/alpha"],
        installed: ["acme/alpha"],
        fixture: true,
        invalidManifests: ["acme/alpha"],
      }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("the catalog loader refused 1 of 1");
    expect(run.output).toContain("manifest failed validation");
    expect(run.output).toContain("a warn line and an integration missing");
  });

  it("fails when a manifest names an integration other than its directory", () => {
    const run = verify(
      image({
        declared: ["acme/alpha"],
        installed: ["acme/alpha!misfiled"],
        fixture: true,
      }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("not the manifest's own name");
    expect(run.output).toContain('acme/alpha declares "other/acme/alpha"');
  });

  it("fails when a client-run manifest was staged into the integrations root", () => {
    // The Dockerfile's staging step says in a comment that nothing a client
    // needs is staged here. A comment is not enforcement: a client staged by
    // mistake would register in the catalog as installable and dispatch
    // nothing, which is the shape of failure this whole script exists to
    // refuse — an image that looks complete and quietly is not.
    const run = verify(
      image({
        declared: ["acme/alpha"],
        installed: ["acme/alpha!client-run"],
        fixture: true,
      }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain('declaring runs_on "client"');
    expect(run.output).toContain("acme/alpha");
  });

  it("fails a manifest declaring a field it has no honest value for", () => {
    // The authoring rules join the image build with the pin that satisfies
    // them, and not before: on the previous pin every staged manifest
    // declared something it had nothing to say about, so holding the build
    // to the rule would have failed it on manifests the deployment was
    // still meant to ship.
    //
    // Its other half is the whole-image pass at the top of this file, which
    // asserts the same check reporting green. Without that, a check refusing
    // everything reads exactly like this one working.
    const run = verify(
      image({ declared: ["acme/alpha"], installed: ["acme/alpha!dishonest"] }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("declaring what it has no honest value for");
    expect(run.output).toContain("acme/alpha");
    expect(run.output).toContain(
      "webhook_verification without a webhook trigger",
    );
  });

  it("fails when the catalog loader cannot be loaded at all", () => {
    const run = verify(
      image({
        declared: ["none"],
        installed: [],
        loaderUnresolvable: true,
      }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("catalog manifest loader could not be loaded");
  });

  it("fails when the loader entry exports no loadInTreeManifests", () => {
    const run = verify(
      image({ declared: ["none"], installed: [], loaderBare: true }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("exports no loadInTreeManifests function");
  });

  it("fails when the declaration is not there to read", () => {
    const img = image({ declared: ["acme/alpha"], installed: ["acme/alpha"] });
    const run = verify(img, {
      MARFA_INSTALLED_INTEGRATIONS: join(img.integrationsRoot, "no-such.txt"),
    });
    expect(run.code).toBe(1);
    expect(run.output).toContain("cannot read the integration declaration");
  });
});
