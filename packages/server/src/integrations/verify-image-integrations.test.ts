/**
 * The in-image verification, exercised outside an image.
 *
 * The script only ever runs as a RUN step in the Dockerfile, so until now
 * the only way to find out that it had stopped objecting to anything was to
 * ship an image it should have refused. Its checks are the last thing
 * between a bad staging step and a substrate that boots empty in
 * production, which makes "it runs somewhere I cannot test" the wrong
 * property for it to have.
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
 * The smallest export the verification accepts as a manifest, which is the
 * same three fields the server's catalog loader requires. Writing less than
 * this would make every fixture fail for the wrong reason.
 */
function manifestSource(name: string): string {
  return `export const manifest = ${JSON.stringify({
    manifest_schema_version: "2.0.0",
    name,
    version: "1.0.0",
  })};\n`;
}

/** How the stand-in worker answers a dispatch. */
type WorkerBehavior = "ok" | "not-ok" | "silent";

interface Image {
  integrationsRoot: string;
  declaration: string;
  fixtureRoot: string;
  workerEntry: string;
  clientManifests: string;
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
 * A scratch image layout. `installed` are `<handle>/<name>` directories
 * under the integrations root; a name suffixed `!manifest` gets a
 * manifest-only
 * entry, `!empty` gets a directory with nothing built in it, `!bare` gets a
 * handler entry that exports no manifest, and `!bare-manifest` gets a
 * manifest-only entry that exports none.
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
}): Image {
  scratchRoot = mkdtempSync(join(tmpdir(), "marfa-verify-image-"));
  // The staged entries are ESM `.js`, which in a real image resolves
  // through the deployed server's own package.json. Mirror that rather
  // than renaming the fixtures, so the import path under test is the one
  // the image takes.
  writeFileSync(join(scratchRoot, "package.json"), '{"type":"module"}\n');

  const integrationsRoot = join(scratchRoot, "integrations");
  mkdirSync(integrationsRoot, { recursive: true });
  for (const raw of options.installed) {
    const [name, shape] = raw.split("!");
    const dir = join(integrationsRoot, name ?? raw);
    mkdirSync(dir, { recursive: true });
    if (shape === "empty") continue;
    const dist = join(dir, "dist");
    mkdirSync(dist, { recursive: true });
    const manifestOnly = shape === "manifest" || shape === "bare-manifest";
    const bare = shape === "bare" || shape === "bare-manifest";
    writeFileSync(
      join(dist, manifestOnly ? "manifest.js" : "local.js"),
      bare ? "export const somethingElse = 1;\n" : manifestSource(name ?? raw),
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
      manifestSource("acme/dispatch-fixture"),
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

  return {
    integrationsRoot,
    declaration,
    fixtureRoot,
    workerEntry,
    clientManifests,
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
    expect(run.output).toContain("all entries import and export manifests");
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
    // The one shrink the old count did catch and a bare name list would
    // not: the directory is still there, so the set looks unchanged, but
    // one fewer integration can be dispatched to.
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
    expect(run.output).toContain("exports no usable manifest");
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
    expect(run.output).toContain("exports no usable manifest");
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

  it("fails when the declaration is not there to read", () => {
    const img = image({ declared: ["acme/alpha"], installed: ["acme/alpha"] });
    const run = verify(img, {
      MARFA_INSTALLED_INTEGRATIONS: join(img.integrationsRoot, "no-such.txt"),
    });
    expect(run.code).toBe(1);
    expect(run.output).toContain("cannot read the integration declaration");
  });
});
