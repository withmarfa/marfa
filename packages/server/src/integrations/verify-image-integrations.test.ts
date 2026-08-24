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
 * Every path it takes is drivable from outside: the root, the declaration,
 * the worker entry and the dispatch fixture are all env-addressable. These
 * drive the first check, which is the one that replaced the hardcoded count
 * and therefore the one carrying the judgement. The dispatch proof needs a
 * built worker entry and a built integration, so it stays the image
 * build's own assertion; what is pinned here is that it refuses to be
 * skipped when there is something to prove.
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

interface Image {
  /** MARFA_INTEGRATIONS_ROOT for the run. */
  integrationsRoot: string;
  /** The declaration file for the run. */
  declaration: string;
  /** Where a dispatch fixture would live, present only when asked for. */
  fixtureRoot: string;
  /** A file standing in for the built worker entry, so the fixture check
   *  is what a run reaches rather than the worker-entry check above it. */
  workerEntry: string;
}

/**
 * A scratch image layout. `installed` are directories under the
 * integrations root; a name suffixed `!manifest` gets a manifest-only
 * entry, and a name suffixed `!empty` gets a directory with nothing built
 * in it at all.
 */
function image(options: {
  declared: string[];
  installed: string[];
  fixture?: boolean;
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
    writeFileSync(
      join(dist, shape === "manifest" ? "manifest.js" : "local.js"),
      `export const manifest = { name: "acme/${name ?? raw}" };\n`,
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
    writeFileSync(join(dist, "local.js"), "export const manifest = {};\n");
  }

  const workerEntry = join(scratchRoot, "worker-entry.js");
  writeFileSync(workerEntry, "// never spawned by these cases\n");

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
  it("passes when the installed set is exactly the declared set", () => {
    const run = verify(
      image({
        declared: ["alpha", "sync"],
        installed: ["alpha!manifest", "sync!manifest"],
      }),
    );
    expect(run.output).toContain("2 declared integrations all installed");
    expect(run.code).toBe(0);
  });

  it("fails, by name, on a declared integration that is not installed", () => {
    const run = verify(
      image({ declared: ["alpha", "beta"], installed: ["alpha!manifest"] }),
    );
    expect(run.code).toBe(1);
    expect(run.output).toContain("declared but not installed");
    expect(run.output).toContain("beta");
  });

  it("fails, by name, on an installed integration nobody declared", () => {
    // The shape that shipped the scaffold: present in the image, named in
    // nothing, and invisible to a check that only counted.
    const run = verify(
      image({
        declared: ["alpha"],
        installed: ["alpha!manifest", "_template!manifest"],
      }),
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
    expect(run.output).toContain("staged without dist/local.js");
  });

  it("passes an image that installs nothing at all", () => {
    // The shape a deployment installing its own integrations starts from.
    // An empty COPY leaves no directory behind, so a missing root has to
    // read as an empty set rather than as a fault, the way the runtime's
    // own discovery already reads it.
    const img = image({ declared: [], installed: [] });
    const run = verify(img, {
      MARFA_INTEGRATIONS_ROOT: join(img.integrationsRoot, "absent"),
    });
    expect(run.output).toContain("0 declared integrations all installed");
    expect(run.code).toBe(0);
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

  it("fails when the declaration is not there to read", () => {
    const img = image({ declared: [], installed: [] });
    const run = verify(img, {
      MARFA_INSTALLED_INTEGRATIONS: join(img.integrationsRoot, "no-such.txt"),
    });
    expect(run.code).toBe(1);
    expect(run.output).toContain("cannot read the integration declaration");
  });
});
