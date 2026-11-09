/**
 * A browser marks the archive it downloads, and macOS refuses to run a marked
 * binary that Apple has not notarized. The release signs and notarizes the
 * programs before it packs them, so the archive on the release page runs
 * however it was downloaded. The server unpacked from the signed archive
 * must read a text file, a PDF, and a picture, and as its own reading child
 * must report the full sandbox.
 */
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

interface ReleaseJobs {
  "programs-macos": Job;
  sign: Job;
  collect: Job;
  publish: Job;
}

function jobs(): ReleaseJobs {
  const workflow = parse(
    readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8"),
  ) as { jobs: ReleaseJobs };
  return workflow.jobs;
}

function runSign(env: Record<string, string>, binary: string) {
  return spawnSync("bash", [SIGN, binary], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });
}

const PROGRAMS = ["marfa", "marfa-server"];

describe("the release signs the programs in a job of its own", () => {
  const { sign, collect } = jobs();
  const build = jobs()["programs-macos"];
  const index = (steps: Step[], pattern: RegExp) =>
    steps.findIndex((step) => pattern.test(step.run ?? ""));
  const needs = (job: Job) => [job.needs ?? []].flat();

  it("hands the unsigned programs from the build to the sign job, which publishing waits for", () => {
    expect(
      index(build.steps, /build-programs\.sh "\$target"/),
    ).toBeGreaterThanOrEqual(0);
    const upload = build.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact"),
    );
    const download = sign.steps.find((step) =>
      step.uses?.startsWith("actions/download-artifact"),
    );
    expect(upload?.with?.name).toBe(
      "build-${{ needs.version.outputs.version }}",
    );
    expect(download?.with?.name).toBe(
      "build-${{ needs.version.outputs.version }}",
    );
    expect(needs(sign)).toContain("programs-macos");
    expect(needs(collect)).toContain("sign");
  });

  it("installs and builds nothing where the signing identity is", () => {
    for (const step of sign.steps) {
      expect(step.uses ?? "").not.toMatch(
        /setup-node|rust-toolchain|pnpm|cache/,
      );
      expect(step.run ?? "").not.toMatch(
        /\b(pnpm|npm|npx|cargo|yarn|brew|rustup|swift build)\b/,
      );
    }
    for (const step of build.steps) {
      expect(JSON.stringify(step)).not.toContain("secrets.");
    }
  });

  it("signs before it packs, and no condition can skip the signing", () => {
    const signing = index(
      sign.steps,
      /sign-binary\.sh "\$RUNNER_TEMP\/build\/\$program"/,
    );
    const pack = index(sign.steps, /pack-programs\.sh/);
    expect(signing).toBeGreaterThanOrEqual(0);
    expect(pack).toBeGreaterThan(signing);
    expect(sign.if).toBeUndefined();
    const step = sign.steps[signing];
    expect(step?.if).toBeUndefined();
    expect(step?.["continue-on-error"]).toBeUndefined();
  });

  it("signs both programs, packs only them, and builds nothing for Intel Macs", () => {
    const step = sign.steps.find((candidate) =>
      (candidate.run ?? "").includes("sign-binary.sh"),
    );
    expect(step?.run).toContain(`for program in ${PROGRAMS.join(" ")}; do`);
    const packing = sign.steps.find((candidate) =>
      (candidate.run ?? "").includes("pack-programs.sh"),
    );
    expect(packing?.run).toContain("marfa-$VERSION-darwin-arm64.tar.gz");
    expect(packing?.run).not.toContain("marfa-enrichment-read");
    expect(packing?.run).not.toContain("linux");
    expect(JSON.stringify(jobs())).not.toContain("x86_64-apple-darwin");
    expect(JSON.stringify(jobs())).not.toContain("darwin-x86_64");
  });

  it("reads a file with the signed server unpacked from the archive, and signs and carries no separate reader", () => {
    const steps = sign.steps;
    const pack = steps.findIndex((step) =>
      (step.run ?? "").includes("pack-programs.sh"),
    );
    const packing = steps[pack]?.run ?? "";
    expect(packing).toContain("check-archive.sh");
    const reading = packing.indexOf("prove-reading.sh");
    expect(reading).toBeGreaterThan(packing.indexOf("check-archive.sh"));
    expect(packing).toContain(
      'prove-reading.sh "$RUNNER_TEMP/artifacts/marfa-$VERSION-darwin-arm64.tar.gz"',
    );
    expect(packing).toContain("core/marfa-enrichment/fixtures");
    expect(JSON.stringify(jobs())).not.toContain("marfa-enrichment-read");
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

describe("the build hands on exactly the programs and the two packages", () => {
  const hold = jobs()["programs-macos"].steps.find((step) =>
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
    "NOTICES.txt",
    ...PROGRAMS,
    "withmarfa-client-0.0.9.tgz",
    "withmarfa-core-0.0.9.tgz",
  ];

  it("accepts the unsigned programs beside the two packages", () => {
    expect(holdBuild(build)).toBe(0);
  });

  it("refuses a build missing a program, or carrying an archive already", () => {
    expect(holdBuild(build.slice(1))).not.toBe(0);
    expect(holdBuild(build.filter((name) => name !== "marfa-server"))).not.toBe(
      0,
    );
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

describe("prove-reading.sh holds the signed server to the reader's protocol", () => {
  const PROVE = join(ROOT, "scripts", "release", "prove-reading.sh");
  const FIXTURES = join(ROOT, "core", "marfa-enrichment", "fixtures");

  /**
   * A stand-in for `marfa-server` that plays the reading child the way
   * `isolated/parent.rs` starts one, and as a server logs a setup code and a
   * line that must be shown, then exits at once. As a child it ends
   * with status 3 and no frame unless it was started as a parent starts it: an
   * empty environment, `/` as its folder, the picture open for reading as
   * standard input, and the limits and the request as its last three arguments.
   */
  function stand_in(frame: string, status: number, text: string) {
    return `#!/bin/bash
[ "$1" = --marfa-enrichment-child ] || { echo 'Setup code: 4815-1623'; echo 'the server log line'; exit 0; }
[ "$#" = 4 ] || exit 3
[ "$2" = 60000 ] && [ "$3" = 1073741824 ] || exit 3
[ "$(pwd -P)" = / ] || exit 3
env | grep -qE '^(HOME|PATH|TMPDIR|USER|MARFA_[A-Z_]*)=' && exit 3
[ -f /dev/stdin ] || exit 3
len=$(wc -c)
printf '%s' "$4" | jq -e --argjson len "$len" \
  '.mime == "image/png" and .len == $len and (.ocr.languages | type) == "string"' > /dev/null || exit 3
printf '%s\n' '${frame}'
printf '%s' '{"reading":{"text":"${text}","truncated":false,"cut_short":false,"size":[1,1],"text_refused":null}}'
exit ${String(status)}
`;
  }

  function prove(program: string) {
    const directory = mkdtempSync(join(tmpdir(), "marfa-prove-reading-"));
    try {
      const server = join(directory, "marfa-server");
      writeFileSync(server, program);
      chmodSync(server, 0o755);
      const archive = join(directory, "marfa.tar.gz");
      spawnSync("tar", ["-czf", archive, "-C", directory, "marfa-server"]);
      const result = spawnSync("bash", [PROVE, archive, FIXTURES], {
        encoding: "utf8",
      });
      return `${result.stdout}${result.stderr}`.concat(
        result.status === 0 ? "\nEXIT 0" : "",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  const SENTENCE = "Marfa reads this sentence upright.";

  it("goes on to the HTTP proof once the child reports the full sandbox and reads the picture", () => {
    const output = prove(stand_in('{"sandbox":"full"}', 0, SENTENCE));
    expect(output).toContain(
      "sandbox: the reading child reported the full sandbox",
    );
    expect(output).toContain(`the reading child read: ${SENTENCE}`);
    expect(output).toContain("marfa-server ended before it listened");
    expect(output).toContain("the server log line");
    expect(output).not.toContain("4815-1623");
  });

  it.each(["partial", "off"])(
    "refuses a child that reports the %s sandbox",
    (sandbox) => {
      const output = prove(stand_in(`{"sandbox":"${sandbox}"}`, 0, SENTENCE));
      expect(output).toContain("not the full sandbox");
      expect(output).not.toContain("ended before it listened");
    },
  );

  it("refuses a child that starts as a parent would not", () => {
    const output = prove(
      stand_in('{"sandbox":"full"}', 0, SENTENCE).replace(
        '[ "$#" = 4 ]',
        '[ "$#" = 5 ]',
      ),
    );
    expect(output).toContain("not the full sandbox");
  });

  it("refuses a child that fails after its frame", () => {
    const output = prove(stand_in('{"sandbox":"full"}', 1, SENTENCE));
    expect(output).toContain("exited with status 1, not 0");
  });

  it("refuses a child that sends a second frame before its reading", () => {
    const output = prove(
      stand_in('{"sandbox":"full"}\n{"sandbox":"full"}', 0, SENTENCE),
    );
    expect(output).toContain("gave no reading");
    expect(output).not.toContain("ended before it listened");
  });

  it("keeps the child's error output apart from its answer", () => {
    const output = prove(
      stand_in('{"sandbox":"full"}', 0, SENTENCE).replace(
        "exit 0\n",
        "echo 'a warning' >&2\nexit 0\n",
      ),
    );
    expect(output).toContain(`the reading child read: ${SENTENCE}`);
  });

  it("refuses a reading without the sentence", () => {
    const output = prove(stand_in('{"sandbox":"full"}', 0, "something else"));
    expect(output).toContain(`lacks '${SENTENCE}'`);
  });
});
