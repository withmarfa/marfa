/**
 * The Homebrew formula for the `marfa` command line is written from the
 * checksum file of a release, and pushed to the tap only after the release is
 * public. A formula that names a hash the archive does not have, or an archive
 * the release does not carry, fails for every person who installs it.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORMULA = join(ROOT, "scripts", "release", "write-formula.sh");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  steps: Step[];
}
const jobs = (
  parse(
    readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8"),
  ) as { jobs: Record<string, Job> }
).jobs;

const ARM = "a".repeat(64);
const INTEL = "b".repeat(64);
const SUMS = [
  `${ARM}  marfa-0.0.23-darwin-arm64.tar.gz`,
  `${INTEL}  marfa-0.0.23-darwin-x86_64.tar.gz`,
  `${"c".repeat(64)}  marfa-0.0.23-linux-x86_64.tar.gz`,
  `${"d".repeat(64)}  marfa-0.0.23-linux-aarch64.tar.gz`,
].join("\n");

function formula(version: string, sums: string) {
  const directory = mkdtempSync(join(tmpdir(), "marfa-formula-"));
  try {
    writeFileSync(join(directory, "sums.txt"), `${sums}\n`);
    const ran = spawnSync(
      "bash",
      [FORMULA, version, join(directory, "sums.txt")],
      {
        encoding: "utf8",
      },
    );
    return { status: ran.status, out: ran.stdout, err: ran.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("the formula is written from the release's checksum file", () => {
  it("names each macOS archive with its own hash, and no Linux archive", () => {
    const { status, out } = formula("0.0.23", SUMS);
    expect(status).toBe(0);
    const base = "https://github.com/withmarfa/marfa/releases/download/v0.0.23";
    expect(out).toContain(
      `url "${base}/marfa-0.0.23-darwin-arm64.tar.gz"\n      sha256 "${ARM}"`,
    );
    expect(out).toContain(
      `url "${base}/marfa-0.0.23-darwin-x86_64.tar.gz"\n      sha256 "${INTEL}"`,
    );
    expect(out).not.toContain("linux");
    expect(out).toContain("depends_on :macos");
    expect(out).toContain('bin.install "marfa"');
    expect(out).toContain("marfa server install");
  });

  it("refuses what it cannot vouch for", () => {
    const lines = SUMS.split("\n");
    const cases: [string, string, string][] = [
      ["0.0", SUMS, "not a release version"],
      ["latest", SUMS, "not a release version"],
      [
        "0.0.23",
        lines.filter((l) => !l.includes("arm64")).join("\n"),
        "no line for marfa-0.0.23-darwin-arm64",
      ],
      [
        "0.0.23",
        lines
          .filter((l) => !l.includes("x86_64.tar.gz") || l.includes("linux"))
          .join("\n"),
        "no line for marfa-0.0.23-darwin-x86_64",
      ],
      ["0.0.23", `${SUMS}\n${lines[0]}`, "more than once"],
      ["0.0.23", SUMS.replace(ARM, "A".repeat(64)), "64 lowercase hexadecimal"],
      ["0.0.23", SUMS.replace(ARM, "a".repeat(63)), "64 lowercase hexadecimal"],
      ["0.0.24", SUMS, "no line for marfa-0.0.24-darwin-arm64"],
    ];
    for (const [version, sums, said] of cases) {
      const { status, out, err } = formula(version, sums);
      expect(status, `${version}: ${err}`).not.toBe(0);
      expect(err).toContain(said);
      expect(out).toBe("");
    }
  });
});

describe("the workflow pushes the formula only after the release is public", () => {
  const tap = jobs["tap"];

  it("waits for the publish job and runs only for a tag", () => {
    expect([tap?.needs ?? []].flat()).toContain("publish");
    expect(tap?.if).toBe("github.event_name == 'push'");
  });

  it("stops with the secret's name when it is not set, before anything is fetched", () => {
    const steps = tap?.steps ?? [];
    const guard = steps.findIndex((s) => s.name === "Require the tap token");
    const fetch = steps.findIndex(
      (s) => s.name === "Get the release's checksums",
    );
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(fetch);
    expect(steps[guard]?.run).toContain("HOMEBREW_TAP_TOKEN");
    expect(steps[guard]?.env?.["HOMEBREW_TAP_TOKEN"]).toBe(
      "${{ secrets.HOMEBREW_TAP_TOKEN }}",
    );
  });

  it("gives the token to the tap's checkout and to nothing else", () => {
    const text = readFileSync(
      join(ROOT, ".github", "workflows", "release.yml"),
      "utf8",
    );
    const uses = text.match(/secrets\.HOMEBREW_TAP_TOKEN/g) ?? [];
    expect(uses).toHaveLength(2);
    const checkout = (tap?.steps ?? []).find(
      (s) => s.with?.["repository"] === "withmarfa/homebrew-tap",
    );
    expect(checkout?.with?.["token"]).toBe("${{ secrets.HOMEBREW_TAP_TOKEN }}");
    expect(
      tap?.steps.filter((s) => s.run?.includes("write-formula.sh")),
    ).toHaveLength(1);
  });

  it("writes nothing when the tap already has the version", () => {
    const push = (tap?.steps ?? []).find(
      (s) => s.name === "Commit and push the formula",
    );
    expect(push?.run).toContain("git diff --cached --quiet");
    expect(push?.run).toContain("git push origin HEAD:main");
  });
});
