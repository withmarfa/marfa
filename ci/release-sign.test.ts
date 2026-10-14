/**
 * A browser marks the archive it downloads, and macOS refuses to run a marked
 * binary that Apple has not notarized. The release signs and notarizes the
 * `marfa` binary before it packs it, so the archive on the release page runs
 * however it was downloaded.
 */
import { readFileSync } from "node:fs";
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
  run?: string;
  env?: Record<string, string>;
}

function buildSteps(): Step[] {
  const workflow = parse(
    readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8"),
  ) as { jobs: { build: { steps: Step[] } } };
  return workflow.jobs.build.steps;
}

function runSign(env: Record<string, string>, binary: string) {
  return spawnSync("bash", [SIGN, binary], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });
}

describe("the release signs the binary before it packs it", () => {
  const steps = buildSteps();
  const index = (pattern: RegExp) =>
    steps.findIndex((step) => pattern.test(step.run ?? ""));

  it("signs the binary the build made, then packs that binary", () => {
    const build = index(/cargo build --release -p marfa-cli/);
    const sign = index(/sign-binary\.sh" target\/release\/marfa/);
    const pack = index(
      /tar -czf "\$RUNNER_TEMP\/artifacts\/marfa-\$VERSION-darwin-arm64\.tar\.gz" -C target\/release marfa/,
    );
    expect(build).toBeGreaterThanOrEqual(0);
    expect(sign).toBeGreaterThan(build);
    expect(pack).toBeGreaterThan(sign);
  });

  it("gives the signing step every secret it reads, from the repository's secrets", () => {
    const sign = steps.find((step) =>
      (step.run ?? "").includes("sign-binary.sh"),
    );
    expect(Object.keys(sign?.env ?? {}).sort()).toEqual([...SECRETS].sort());
    for (const name of SECRETS) {
      expect(sign?.env?.[name]).toBe(`\${{ secrets.${name} }}`);
    }
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
