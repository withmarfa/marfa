/**
 * One compiler version builds the release and runs every check. The release
 * installs the one `native/manifest.txt` names, and CI installs the one
 * `core/rust-toolchain.toml` names, so a new stable release cannot fail an
 * unchanged pull request and a check cannot pass on a compiler the release
 * does not build with.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");

const toolchain = parseToml(
  readFileSync(join(ROOT, "core", "rust-toolchain.toml"), "utf8"),
) as {
  toolchain: {
    channel: string;
    profile?: string;
    components?: string[];
    targets?: string[];
  };
};

describe("core/rust-toolchain.toml", () => {
  it("names the compiler the release builds with", () => {
    const manifest = readFileSync(
      join(ROOT, "core", "marfa-enrichment", "native", "manifest.txt"),
      "utf8",
    );
    const lines = manifest
      .split("\n")
      .filter((line) => /^toolchain\s+rust\s/.test(line));
    expect(lines).toHaveLength(1);
    expect(toolchain.toolchain.channel).toBe(lines[0]!.split(/\s+/)[2]);
  });

  it("is an exact version, never a channel that moves", () => {
    expect(toolchain.toolchain.channel).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("holds what the checks run: rustfmt, clippy and the Apple targets", () => {
    expect(toolchain.toolchain.components).toEqual(
      expect.arrayContaining(["rustfmt", "clippy"]),
    );
    expect(toolchain.toolchain.targets).toEqual(
      expect.arrayContaining([
        "aarch64-apple-darwin",
        "aarch64-apple-ios",
        "aarch64-apple-ios-sim",
      ]),
    );
  });
});

describe("the workflows", () => {
  const texts = readdirSync(WORKFLOWS)
    .filter((name) => /\.ya?ml$/.test(name))
    .map(
      (name) => [name, readFileSync(join(WORKFLOWS, name), "utf8")] as const,
    );

  it("install no Rust toolchain that floats", () => {
    for (const [name, text] of texts) {
      expect(text, name).not.toMatch(/dtolnay\/rust-toolchain/);
      expect(text, name).not.toMatch(
        /rustup (toolchain install|default) stable/,
      );
    }
  });

  it("install the pinned compiler in every job that builds with cargo on the runner", () => {
    for (const [name, text] of texts) {
      const document = parse(text) as {
        jobs: Record<string, { steps?: { uses?: string; run?: string }[] }>;
      };
      for (const [job, { steps = [] }] of Object.entries(document.jobs)) {
        const runsCargo = steps.some((step) =>
          /\bcargo (fmt|clippy|build|check|nextest|fetch)\b/.test(
            step.run ?? "",
          ),
        );
        const installs = steps.some(
          (step) =>
            step.uses === "./.github/actions/rust-toolchain" ||
            (step.run ?? "").includes("rustup toolchain install"),
        );
        if (runsCargo) {
          expect(installs, `${name}: ${job} installs no pinned toolchain`).toBe(
            true,
          );
        }
      }
    }
  });
});

describe(".github/actions/rust-toolchain", () => {
  const action = readFileSync(
    join(ROOT, ".github", "actions", "rust-toolchain", "action.yml"),
    "utf8",
  );

  it("installs from the file and makes the version the default outside core/", () => {
    expect(action).toContain("rustup toolchain install");
    expect(action).toContain("working-directory: core");
    expect(action).toContain("rustup default");
  });
});
