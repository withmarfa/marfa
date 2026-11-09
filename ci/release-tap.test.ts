/**
 * The Homebrew formula for the `marfa` command line and `marfa-server` is written from the
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
  if?: string;
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

const MAC = "a".repeat(64);
const INTEL = "c".repeat(64);
const ARM = "d".repeat(64);
const SUMS = [
  `${MAC}  marfa-0.0.23-darwin-arm64.tar.gz`,
  `${INTEL}  marfa-0.0.23-linux-x86_64.tar.gz`,
  `${ARM}  marfa-0.0.23-linux-aarch64.tar.gz`,
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
  it("names each archive with its own hash, for Apple silicon and both Linux architectures", () => {
    const { status, out } = formula("0.0.23", SUMS);
    expect(status).toBe(0);
    const base = "https://github.com/withmarfa/marfa/releases/download/v0.0.23";
    expect(out).toMatch(
      new RegExp(
        `on_macos do\\n\\s+depends_on arch: :arm64\\n\\n\\s+on_arm do\\n\\s+url "${base}/marfa-0.0.23-darwin-arm64.tar.gz"\\n\\s+sha256 "${MAC}"`,
      ),
    );
    expect(out).toMatch(
      new RegExp(
        `on_arm do\\n\\s+url "${base}/marfa-0.0.23-linux-aarch64.tar.gz"\\n\\s+sha256 "${ARM}"`,
      ),
    );
    expect(out).toMatch(
      new RegExp(
        `on_intel do\\n\\s+url "${base}/marfa-0.0.23-linux-x86_64.tar.gz"\\n\\s+sha256 "${INTEL}"`,
      ),
    );
  });

  it("offers no Intel Mac archive and does not tie the formula to a macOS release", () => {
    const { out } = formula("0.0.23", SUMS);
    expect(out).not.toContain("darwin-x86_64");
    expect(out).not.toContain("depends_on :macos");
    expect(out).toContain("depends_on arch: :arm64");
  });

  it("installs both programs and checks both versions", () => {
    const { out } = formula("0.0.23", SUMS);
    expect(out).toContain('bin.install "marfa", "marfa-server"');
    expect(out).toContain('doc.install "NOTICES.txt"');
    expect(out).toContain("marfa server install");
    expect(out).toContain('"marfa #{version}"');
    expect(out).toContain('"marfa-server #{version}"');
  });

  it("refuses what it cannot vouch for", () => {
    const lines = SUMS.split("\n");
    const without = (what: string) =>
      lines.filter((line) => !line.includes(what)).join("\n");
    const cases: [string, string, string][] = [
      ["0.0", SUMS, "not a release version"],
      ["latest", SUMS, "not a release version"],
      [
        "0.0.23",
        without("darwin-arm64"),
        "no line for marfa-0.0.23-darwin-arm64",
      ],
      [
        "0.0.23",
        without("linux-x86_64"),
        "no line for marfa-0.0.23-linux-x86_64",
      ],
      [
        "0.0.23",
        without("linux-aarch64"),
        "no line for marfa-0.0.23-linux-aarch64",
      ],
      ["0.0.23", [SUMS, ...lines.slice(0, 1)].join("\n"), "more than once"],
      ["0.0.23", SUMS.replace(MAC, "A".repeat(64)), "64 lowercase hexadecimal"],
      ["0.0.23", SUMS.replace(MAC, "a".repeat(63)), "64 lowercase hexadecimal"],
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
  const tap = jobs.tap;

  it("waits for the publish job and runs only for a tag", () => {
    expect([tap?.needs ?? []].flat()).toContain("publish");
    expect(tap?.if).toBe("github.event_name == 'push'");
  });

  it("writes and shows the formula for every tag, and pushes it only when HOMEBREW_TAP is publish", () => {
    const steps = tap?.steps ?? [];
    const gate = steps.find((s) => s.name?.startsWith("Say whether"));
    expect(gate?.env?.HOMEBREW_TAP).toBe("${{ vars.HOMEBREW_TAP }}");
    expect(gate?.run).toContain('"$HOMEBREW_TAP" = publish');
    expect(gate?.run).toContain("is not 'publish'");
    const write = steps.find((s) => s.run?.includes("write-formula.sh"));
    expect(write).toBeDefined();
    expect(write?.if).toBeUndefined();
    expect(write?.run).toContain("cat ");
    const gated = steps.filter(
      (s) => s.if === "steps.gate.outputs.push == 'true'",
    );
    expect(gated.map((s) => s.name ?? s.uses)).toEqual([
      "Require the tap token",
      "actions/checkout@v7",
      "Commit and push the formula",
    ]);
    for (const step of steps) {
      if (gated.includes(step)) continue;
      expect(JSON.stringify(step), step.name).not.toContain(
        "HOMEBREW_TAP_TOKEN",
      );
    }
  });

  it("stops with the secret's name when it is not set, before anything is fetched from the tap", () => {
    const steps = tap?.steps ?? [];
    const guard = steps.findIndex((s) => s.name === "Require the tap token");
    const checkout = steps.findIndex(
      (s) => s.with?.repository === "withmarfa/homebrew-tap",
    );
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(checkout);
    expect(steps[guard]?.run).toContain("HOMEBREW_TAP_TOKEN");
    expect(steps[guard]?.env?.HOMEBREW_TAP_TOKEN).toBe(
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
      (s) => s.with?.repository === "withmarfa/homebrew-tap",
    );
    expect(checkout?.with?.token).toBe("${{ secrets.HOMEBREW_TAP_TOKEN }}");
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
