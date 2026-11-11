/**
 * The native build image is installed from a snapshot of the Ubuntu archive,
 * which is out of reach at times. It is built once, from `main`, kept in
 * GitHub's cache and loaded everywhere else, and `make_build_image` uses an
 * image that is already loaded with the recipe's hash, so a run with a cache
 * hit never contacts the archive.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const NATIVE = join(ROOT, "core", "marfa-enrichment", "native");
const ACTION = "./.github/actions/native-build-image";

interface Step {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  id?: string;
  with?: Record<string, string>;
}
interface Job {
  steps: Step[];
}

const load = (file: string): unknown =>
  parse(readFileSync(join(ROOT, ".github", file), "utf8"));
const action = load("actions/native-build-image/action.yml") as {
  runs: { steps: Step[] };
};
const ci = load("workflows/ci.yml") as { jobs: Record<string, Job> };
const release = load("workflows/release.yml") as { jobs: Record<string, Job> };

describe("the build image's cache", () => {
  const steps = action.runs.steps;
  const restore = steps.find((s) =>
    s.uses?.startsWith("actions/cache/restore@"),
  );
  const save = steps.find((s) => s.uses?.startsWith("actions/cache/save@"));
  const key = steps.find((s) => s.id === "key");

  it("is keyed on the recipe's hash, which `image.sh key` prints", () => {
    expect(key?.run).toContain("native/image.sh");
    expect(key?.run).toContain(" key");
    expect(restore?.with?.key).toBe("${{ steps.key.outputs.key }}");
    expect(save?.with?.key).toBe("${{ steps.key.outputs.key }}");
    expect(restore?.with?.path).toBe(save?.with?.path);
  });

  it("restores on every run and saves only from main, and only after a miss", () => {
    expect(restore?.if).toBeUndefined();
    expect(save?.if).toContain("github.ref == 'refs/heads/main'");
    expect(save?.if).toContain("cache-hit != 'true'");
    const write = steps.find((s) => s.run?.includes('image.sh" save'));
    expect(write?.if).toBe(save?.if);
  });

  it("loads a hit before it makes the image, and saves after", () => {
    const names = steps.map((s) => s.name ?? "");
    const at = (prefix: string) => names.findIndex((n) => n.startsWith(prefix));
    expect(at("Restore")).toBeLessThan(at("Load"));
    expect(at("Load")).toBeLessThan(at("Make"));
    expect(at("Make")).toBeLessThan(at("Write"));
    expect(at("Write")).toBeLessThan(at("Save"));
    expect(steps[at("Load")]?.if).toContain("cache-hit == 'true'");
  });
});

describe("the jobs that build in the image", () => {
  const cases: [string, Record<string, Job>, string, string][] = [
    ["core-native", ci.jobs, "Build and check the programs", "ci.yml"],
    ["rust-contract", ci.jobs, "Build the Rust server", "ci.yml"],
    ["image", ci.jobs, "Build and check the programs", "ci.yml"],
    ["programs-linux", release.jobs, "Build the programs", "release.yml"],
  ];
  it.each(cases)(
    "%s gets the image from the cache before its first build",
    (name, jobs, build) => {
      const steps = jobs[name]?.steps ?? [];
      const use = steps.findIndex((s) => s.uses === ACTION);
      expect(use).toBeGreaterThan(-1);
      expect(steps.filter((s) => s.uses === ACTION)).toHaveLength(1);
      expect(use).toBeLessThan(steps.findIndex((s) => s.name === build));
    },
  );
});

describe("make_build_image", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const directory of cleanup.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  /** A `docker` that holds one image, labelled as the test says, and logs what it is asked. */
  function run(script: string, held: { present: boolean; label: string }) {
    const directory = mkdtempSync(join(tmpdir(), "marfa-build-image-"));
    cleanup.push(directory);
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const log = join(directory, "docker.log");
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/bash
echo "$*" >> "${log}"
case "$1 $2" in
  "image inspect")
    [ "${String(held.present)}" = true ] || exit 1
    echo "${held.label}"
    ;;
esac
`,
    );
    chmodSync(join(bin, "docker"), 0o755);
    const result = spawnSync(
      "bash",
      ["-c", `source "${NATIVE}/lib.sh"; ${script}`],
      {
        encoding: "utf8",
        env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: directory },
      },
    );
    let calls: string[] = [];
    try {
      calls = readFileSync(log, "utf8").trim().split("\n");
    } catch {
      // docker was never called
    }
    return { ...result, calls };
  }

  const recipe = () =>
    spawnSync("bash", [join(NATIVE, "image.sh"), "key"], {
      encoding: "utf8",
    }).stdout.trim();

  it("prints a recipe hash", () => {
    expect(recipe()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("builds nothing when the image is loaded with this recipe", () => {
    const { status, calls } = run("make_build_image some-image", {
      present: true,
      label: recipe(),
    });
    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^image inspect .* some-image$/);
  });

  it("builds, and labels the image with the recipe, when the loaded image has another", () => {
    const { status, calls } = run("make_build_image some-image", {
      present: true,
      label: "0000000000000000",
    });
    expect(status).toBe(0);
    const build = calls.find((call) => call.startsWith("build "));
    expect(build).toContain(`--label so.marfa.native.recipe=${recipe()}`);
    expect(build).toContain("-t some-image");
  });

  it("builds when no image is loaded", () => {
    const { status, calls } = run("make_build_image some-image", {
      present: false,
      label: "",
    });
    expect(status).toBe(0);
    expect(calls.some((call) => call.startsWith("build "))).toBe(true);
  });

  it("names the image as the release scripts do", () => {
    expect(
      run("build_image_name", { present: false, label: "" }).stdout.trim(),
    ).toBe("marfa-release-build");
  });
});
