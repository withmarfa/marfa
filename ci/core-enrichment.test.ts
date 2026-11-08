/**
 * The two jobs that prove `marfa-enrichment`: the native build on x86_64 Linux
 * and the fault-injection tests. A reader that is confined by Landlock and
 * seccomp can only be shown confined on the kernel and the CPU it ships for,
 * and a green run that never built the native readers, never counted a read's
 * sandbox or never fuzzed would vouch for nothing.
 *
 * The workflow is parsed, not grepped, so a step that only mentions a command
 * in a comment does not count.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  classify,
  forNightly,
  JOBS,
  NIGHTLY_JOBS,
} from "../scripts/ci-required.js";

const ROOT = resolve(import.meta.dirname, "..");

interface Step {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  id?: string;
  with?: Record<string, string>;
  "working-directory"?: string;
}
interface Job {
  name?: string;
  needs?: string | string[];
  "runs-on"?: string;
  "timeout-minutes"?: number;
  env?: Record<string, string>;
  steps: Step[];
}

const { jobs } = parse(
  readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8"),
) as { jobs: Record<string, Job> };

const native = jobs["core-native"];
const faults = jobs["core-fault-injection"];
const macos = jobs["core-checks"];
const NATIVE_DIR = "core/marfa-enrichment/native";

const runs = (job: Job | undefined): string =>
  (job?.steps ?? []).map((step) => step.run ?? "").join("\n");

describe("the native build", () => {
  it("exists, on a standard x86_64 Ubuntu runner", () => {
    expect(native?.name).toBe("Core native (x86_64 Linux)");
    expect(native?.["runs-on"]).toBe("ubuntu-latest");
  });

  it("builds x86_64 musl from pinned sources, runs the whole matrix, and fuzzes", () => {
    const text = runs(native);
    expect(text).toContain(`${NATIVE_DIR}/release.sh "$TARGET" --full`);
    expect(text).toMatch(/\/fuzz\.sh "\$TARGET" \d+/);
    // The witness: the target is the one a Linux kernel without emulation
    // can hold to `Full`.
    expect(native?.env?.TARGET).toBe("x86_64-unknown-linux-musl");
  });

  it("counts the sandbox of every read, and fails for none counted", () => {
    const step = native?.steps.find((s) => s.name?.includes("sandbox Full"));
    expect(step?.run).toContain("^sandbox: Full$");
    expect(step?.run).toMatch(/-lt \d+/);
    expect(step?.run).toContain("exit 1");
  });

  it("restores a cache keyed on the pins, the patches and the build scripts, and saves only from main", () => {
    const key = native?.steps.find((s) => s.id === "key")?.run ?? "";
    for (const file of [
      "manifest.txt",
      "patches/**",
      "build.sh",
      "pdfium.sh",
      "tesseract.sh",
      "models.sh",
      "lib.sh",
      "linux/**",
    ]) {
      expect(key, file).toContain(`${NATIVE_DIR}/${file}`);
    }
    const restore = native?.steps.find((s) =>
      s.uses?.startsWith("actions/cache/restore"),
    );
    const save = native?.steps.find((s) =>
      s.uses?.startsWith("actions/cache/save"),
    );
    expect(restore?.with?.key).toBe("${{ steps.key.outputs.key }}");
    expect(save?.with?.key).toBe("${{ steps.key.outputs.key }}");
    expect(save?.if).toContain("github.ref == 'refs/heads/main'");
    expect(restore?.if).toBeUndefined();
    // What is cached is what the manifest pins: downloads and PDFium's library.
    for (const step of [restore, save]) {
      expect(step?.with?.path).toContain("marfa-native/downloads");
      expect(step?.with?.path).toContain("marfa-native/archives");
    }
  });

  it("says plainly what failed and keeps the report only after a failure", () => {
    const say = native?.steps.find((s) => s.name === "Say what failed");
    expect(say?.if).toBe("${{ failure() }}");
    expect(say?.run).toContain("GITHUB_STEP_SUMMARY");
    expect(say?.run).toContain("::error::");
    const keep = native?.steps.find((s) =>
      s.uses?.startsWith("actions/upload-artifact"),
    );
    expect(keep?.if).toBe("failure()");
  });

  it("leaves NOTICES.txt as the build makes it, and checks that it exists", () => {
    const text = runs(native);
    expect(text).toContain("NOTICES.txt");
    // The witness: the patterns recognize a step that writes to it.
    const writes =
      /(>>?\s*"?[^\s"]*NOTICES\.txt|\b(sed|tee|rm)\b[^\n]*NOTICES\.txt)/;
    expect('echo x >> "$out/NOTICES.txt"').toMatch(writes);
    expect("sed -i s/a/b/ NOTICES.txt").toMatch(writes);
    // Nothing in the workflow writes to it.
    expect(text).not.toMatch(writes);
  });
});

describe("the fault-injection job", () => {
  it("runs the crate's lints and tests with the feature, on Linux, under nextest", () => {
    expect(faults?.name).toBe("Core fault injection (Linux)");
    expect(faults?.["runs-on"]).toBe("ubuntu-latest");
    const text = runs(faults);
    expect(text).toContain(
      "cargo clippy --locked -p marfa-enrichment --all-targets --features fault-injection",
    );
    expect(text).toContain(
      "cargo nextest run --locked -p marfa-enrichment --features fault-injection",
    );
  });

  it("is run on macOS as well, where the sandbox and the memory watch are other code", () => {
    const text = runs(macos);
    expect(text).toContain(
      "cargo nextest run --locked -p marfa-enrichment --features fault-injection",
    );
    expect(text).toContain(
      "cargo clippy --locked -p marfa-enrichment --all-targets --features fault-injection",
    );
    // The first run's report is read before the second writes over it.
    const first = text.indexOf("cargo nextest run --locked --workspace");
    const report = text.indexOf("scripts/report-flaky.py", first);
    const second = text.indexOf("--features fault-injection", report);
    expect(first).toBeGreaterThan(-1);
    expect(report).toBeGreaterThan(first);
    expect(second).toBeGreaterThan(report);
  });
});

describe("the gate and the nightly", () => {
  it.each(["gate", "report-failure"])("%s waits for both jobs", (name) => {
    const needs = [jobs[name]?.needs ?? []].flat();
    expect(needs).toContain("core-native");
    expect(needs).toContain("core-fault-injection");
  });

  it("runs both for a push to main and a dispatch, which name no path", () => {
    const all = classify([]);
    expect(all["core-native"]).toBe(true);
    expect(all["core-fault-injection"]).toBe(true);
  });

  it("leaves both to the push to main: the nightly runs only what needs a Mac", () => {
    expect(NIGHTLY_JOBS).not.toContain("core-native");
    expect(NIGHTLY_JOBS).not.toContain("core-fault-injection");
    const night = forNightly();
    expect(night["core-native"]).toBe(false);
    expect(night["core-fault-injection"]).toBe(false);
    // The witness: the nightly does run `Core checks`, which holds the
    // fault-injection tests on macOS.
    expect(night["core-checks"]).toBe(true);
  });

  it("has an output in the classifier for each job", () => {
    expect(JOBS).toContain("core-native");
    expect(JOBS).toContain("core-fault-injection");
  });
});
