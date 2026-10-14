/**
 * A browser marks the archive it downloads, and macOS refuses to run a marked
 * binary that Apple has not notarized. The release signs and notarizes the
 * `marfa` binary before it packs it, so the archive on the release page runs
 * however it was downloaded.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIGN = join(ROOT, "scripts", "release", "sign-binary.sh");

const SECRETS = [
  "APPLE_DEVELOPER_ID_P12",
  "APPLE_DEVELOPER_ID_P12_PASSWORD",
  "APPLE_NOTARY_KEY",
  "APPLE_NOTARY_KEY_ID",
  "APPLE_NOTARY_ISSUER_ID",
  "APPLE_TEAM_ID",
];

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  "continue-on-error"?: boolean | string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface Job {
  needs?: string | string[];
  if?: string;
  steps: Step[];
}

function jobs(): Record<string, Job> {
  const workflow = parse(
    readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8"),
  ) as { jobs: Record<string, Job> };
  return workflow.jobs;
}

function runSign(env: Record<string, string>, binary: string) {
  return spawnSync("bash", [SIGN, binary], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });
}

describe("the release signs the binary in a job of its own", () => {
  const { build, sign, publish } = jobs();
  const index = (steps: Step[], pattern: RegExp) =>
    steps.findIndex((step) => pattern.test(step.run ?? ""));

  it("hands the unsigned binary from the build to the sign job, which publishing waits for", () => {
    expect(
      index(build.steps, /cargo build --release -p marfa-cli/),
    ).toBeGreaterThanOrEqual(0);
    const upload = build.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact"),
    );
    const download = sign.steps.find((step) =>
      step.uses?.startsWith("actions/download-artifact"),
    );
    expect(upload?.with?.name).toBe(
      "build-${{ steps.version.outputs.version }}",
    );
    expect(download?.with?.name).toBe(
      "build-${{ needs.build.outputs.version }}",
    );
    expect(sign.needs).toBe("build");
    expect(publish.needs).toContain("sign");
  });

  it("installs and builds nothing where the signing identity is", () => {
    for (const step of sign.steps) {
      expect(step.uses ?? "").not.toMatch(
        /setup-node|rust-toolchain|pnpm|cache/,
      );
      expect(step.run ?? "").not.toMatch(
        /\b(pnpm|npm|npx|cargo|yarn|swift build)\b/,
      );
    }
    for (const step of build.steps) {
      expect(JSON.stringify(step)).not.toContain("secrets.");
    }
  });

  it("signs before it packs, and no condition can skip the signing", () => {
    const signing = index(
      sign.steps,
      /sign-binary\.sh "\$RUNNER_TEMP\/artifacts\/marfa"/,
    );
    const pack = index(
      sign.steps,
      /tar -czf "marfa-\$VERSION-darwin-arm64\.tar\.gz" marfa/,
    );
    expect(signing).toBeGreaterThanOrEqual(0);
    expect(pack).toBeGreaterThan(signing);
    expect(sign.if).toBeUndefined();
    expect(sign.steps[signing].if).toBeUndefined();
    expect(sign.steps[signing]["continue-on-error"]).toBeUndefined();
  });

  it("gives the signing step every secret it reads, from the repository's secrets", () => {
    const step = sign.steps.find((candidate) =>
      (candidate.run ?? "").includes("sign-binary.sh"),
    );
    expect(Object.keys(step?.env ?? {}).sort()).toEqual([...SECRETS].sort());
    for (const name of SECRETS) {
      expect(step?.env?.[name]).toBe(`\${{ secrets.${name} }}`);
    }
  });
});

describe("the build hands on exactly the binary and the two packages", () => {
  const hold = jobs().build.steps.find((step) =>
    (step.run ?? "").includes("hold-artifacts.sh"),
  )?.run;

  function holdBuild(names: string[]) {
    const directory = mkdtempSync(join(tmpdir(), "marfa-build-artifacts-"));
    try {
      for (const name of names)
        writeFileSync(join(directory, name), "artifact");
      return spawnSync("bash", ["-e", "-c", hold ?? "exit 1"], {
        cwd: directory,
        env: { ...process.env, VERSION: "0.0.9", GITHUB_WORKSPACE: ROOT },
        encoding: "utf8",
      }).status;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  const build = [
    "marfa",
    "withmarfa-client-0.0.9.tgz",
    "withmarfa-core-0.0.9.tgz",
  ];

  it("accepts the unsigned binary beside the two packages", () => {
    expect(holdBuild(build)).toBe(0);
  });

  it("refuses a build missing the binary, or carrying an archive already", () => {
    expect(holdBuild(build.slice(1))).not.toBe(0);
    expect(holdBuild([...build, "marfa-0.0.9-darwin-arm64.tar.gz"])).not.toBe(
      0,
    );
  });
});

describe("sign-binary.sh refuses before it touches a keychain", () => {
  const all = Object.fromEntries(SECRETS.map((name) => [name, "x"]));

  it.each(SECRETS)("names %s when it is not set", (name) => {
    const env = Object.fromEntries(
      Object.entries(all).filter(([key]) => key !== name),
    );
    const result = runSign(env, SIGN);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(name);
    expect(result.stdout).not.toContain("is not a file");
  });

  it("refuses a binary that is not there", () => {
    const result = runSign(all, join(ROOT, "no-such-binary"));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("no-such-binary is not a file");
  });
});
