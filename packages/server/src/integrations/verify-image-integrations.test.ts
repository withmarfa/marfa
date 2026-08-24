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
}

/**
 * A scratch image layout. `installed` are directories under the
 * integrations root; a name suffixed `!manifest` gets a manifest-only
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
      bare
        ? "export const somethingElse = 1;\n"
        : manifestSource(`acme/${name ?? raw}`),
    );
  }

  const declaration = join(scratchRoot, "installed-integrations.txt");
  writeFileSync(
    declaration,
    `# a comment, and a blank line follow\n\n${options.declared.join("\n")}\n`,
  );

  const fixtureRoot = join(scratchRoot, "verify-fixtures");
  if (options.fixture === true) {
    const dist = join(fixtureRoot, "_template", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "local.js"), manifestSource("acme/template"));
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

  return { integrationsRoot, declaration, fixtureRoot, workerEntry };
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
        declared: ["alpha", "sync manifest-only"],
        installed: ["alpha", "sync!manifest"],
        fixture: true,
      }),
    );
    expect(run.output).toContain("2 declared integrations all installed");
    expect(run.output).toContain("1 dispatchable");
    expect(run.output).toContain("all entries import and export manifests");
    expect(run.output).toContain("PASSED");
    expect(run.code).toBe(0);
  });

  it("fails, by name, on a declared integration that is not installed", () => {
    const run = verify(
      image({ declared: ["alpha", "beta"], installed: ["alpha"] }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("declared but not installed");
    expect(run.output).toContain("beta");
  });

  it("fails, by name, on an installed integration nobody declared", () => {
    // The shape that shipped the scaffold: present in the image, named in
    // nothing, and invisible to a check that only counted.
    const run = verify(
      image({ declared: ["alpha"], installed: ["alpha", "_template"] }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("installed but not declared");
    expect(run.output).toContain("_template");
  });

  it("fails on a declared integration that built nothing", () => {
    const run = verify(
      image({ declared: ["alpha"], installed: ["alpha!empty"] }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("staged no dist/local.js");
  });

  it("fails when a dispatchable integration built only a manifest", () => {
    // The one shrink the old count did catch and a bare name list would
    // not: the directory is still there, so the set looks unchanged, but
    // one fewer integration can be dispatched to.
    const run = verify(
      image({ declared: ["alpha"], installed: ["alpha!manifest"] }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("mark it manifest-only");
  });

  it("fails when a manifest-only integration built a handler", () => {
    const run = verify(
      image({ declared: ["sync manifest-only"], installed: ["sync"] }),
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
        declared: ["sync manifest-only"],
        installed: ["sync!bare-manifest"],
      }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("exports no usable manifest");
  });

  it("fails when a staged entry exports no manifest", () => {
    const run = verify(
      image({
        declared: ["alpha"],
        installed: ["alpha!bare"],
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
    const img = image({ declared: ["alpha"], installed: [] });
    const run = verify(img, {
      MARFA_INTEGRATIONS_ROOT: join(img.integrationsRoot, "absent"),
    });
    expect(run.code).toBe(1);
    expect(run.output).toContain("declared but not installed");
    expect(run.output).toContain("alpha");
  });

  it("refuses to skip the dispatch proof when something dispatches", () => {
    const run = verify(image({ declared: ["alpha"], installed: ["alpha"] }));
    expect(run.code).toBe(1);
    expect(run.output).toContain("dispatch fixture is missing");
  });

  it("fails when the worker never comes up", () => {
    const run = verify(
      image({
        declared: ["alpha"],
        installed: ["alpha"],
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
        declared: ["alpha"],
        installed: ["alpha"],
        fixture: true,
        worker: "not-ok",
      }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("dispatch returned not-ok");
    expect(run.output).toContain("duplicate copy");
  });

  it("fails when the declaration is not there to read", () => {
    const img = image({ declared: ["alpha"], installed: ["alpha"] });
    const run = verify(img, {
      MARFA_INSTALLED_INTEGRATIONS: join(img.integrationsRoot, "no-such.txt"),
    });
    expect(run.code).toBe(1);
    expect(run.output).toContain("cannot read the integration declaration");
  });
});
