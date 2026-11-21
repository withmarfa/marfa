// Exercises the release's archives and the checks on them.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = join(ROOT, "scripts", "release");
const PACK = join(RELEASE, "pack-programs.sh");
const CHECK = join(RELEASE, "check-archive.sh");
const CONTEXT = join(RELEASE, "image-context.sh");
const CHECKSUMS = join(RELEASE, "write-checksums.sh");
const FETCH = join(RELEASE, "fetch-cloudflared.sh");
const PINS = join(RELEASE, "cloudflared.txt");
const LICENCES = join(RELEASE, "cloudflared-licences.txt");
const LICENCES_SCRIPT = join(RELEASE, "cloudflared-licences.sh");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface Job {
  needs?: string | string[];
  if?: string;
  "runs-on"?: string;
  strategy?: {
    "fail-fast"?: boolean;
    matrix?: { include?: Record<string, string>[] };
  };
  steps: Step[];
}

const jobs = (
  parse(
    readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8"),
  ) as { jobs: Record<string, Job> }
).jobs;

const needs = (job: Job | undefined): string[] => [job?.needs ?? []].flat();

/** Runs `script` in a fresh folder holding `files`, and says how it ended. */
function inFolder(
  files: Record<string, string>,
  script: (directory: string) => ReturnType<typeof spawnSync>,
) {
  const directory = mkdtempSync(join(tmpdir(), "marfa-release-archives-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(directory, name), text);
      chmodSync(join(directory, name), 0o755);
    }
    return script(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const reports = (program: string, version: string) =>
  `#!/bin/sh\necho "${program} ${version}"\n`;

describe("the workflow builds the programs for every platform", () => {
  it("builds both Linux targets in a job apiece on a runner that can build them, stopping at the first failure", () => {
    const linux = jobs["programs-linux"];
    expect(linux?.strategy?.["fail-fast"]).toBe(true);
    expect(linux?.["runs-on"]).toBe("ubuntu-latest");
    expect(
      linux?.strategy?.matrix?.include?.map(({ arch, target }) => [
        arch,
        target,
      ]),
    ).toEqual([
      ["x86_64", "x86_64-unknown-linux-musl"],
      ["aarch64", "aarch64-unknown-linux-musl"],
    ]);
  });

  it("stamps the version before it builds, on every platform", () => {
    for (const name of ["programs-macos", "programs-linux"]) {
      const steps = jobs[name]?.steps ?? [];
      const stamp = steps.findIndex((step) =>
        (step.run ?? "").includes("stamp-version.sh"),
      );
      const build = steps.findIndex((step) =>
        (step.run ?? "").includes("build-programs.sh"),
      );
      expect(stamp, name).toBeGreaterThanOrEqual(0);
      expect(build, name).toBeGreaterThan(stamp);
    }
  });

  it("builds the Mac for Apple silicon only", () => {
    const build = jobs["programs-macos"]?.steps.find((step) =>
      (step.run ?? "").includes("build-programs.sh"),
    );
    expect(build?.run).toContain("target=aarch64-apple-darwin");
    expect(JSON.stringify(jobs)).not.toContain("x86_64-apple-darwin");
    expect(JSON.stringify(jobs)).not.toContain("darwin-x86_64");
  });

  it("restores the native downloads and never saves them", () => {
    for (const name of ["programs-macos", "programs-linux"]) {
      const steps = jobs[name]?.steps ?? [];
      const restore = steps.filter((step) =>
        step.uses?.startsWith("actions/cache/restore@"),
      );
      const save = steps.filter((step) =>
        /^actions\/cache(\/save)?@/.test(step.uses ?? ""),
      );
      expect(restore, name).toHaveLength(1);
      expect(save, name).toHaveLength(0);
    }
  });

  it("uses the cache key that ci.yml's native job saves for x86_64 Linux", () => {
    const ci = parse(
      readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8"),
    ) as { jobs: Record<string, Job> };
    const keyStep = (job: Job | undefined) =>
      job?.steps.find((step) => step.name?.startsWith("Key the cache"))?.run ??
      "";
    const files = (run: string) => /hashFiles\(([^)]*)\)/.exec(run)?.[1];
    const ciKey = keyStep(ci.jobs["core-native"]);
    expect(files(ciKey)).toBeDefined();
    expect(files(keyStep(jobs["programs-linux"]))).toBe(files(ciKey));
    expect(files(keyStep(jobs["programs-macos"]))).toBe(files(ciKey));
  });

  it("packs each Linux archive on the build runner and runs it on its own architecture", () => {
    const linux = jobs["programs-linux"];
    expect(
      linux?.steps.filter((step) =>
        (step.run ?? "").includes("pack-programs.sh"),
      ),
    ).toHaveLength(1);
    const run = jobs["run-linux"];
    expect(needs(run)).toContain("programs-linux");
    expect(
      run?.strategy?.matrix?.include?.map(({ arch, runner }) => [arch, runner]),
    ).toEqual([
      ["x86_64", "ubuntu-latest"],
      ["aarch64", "ubuntu-24.04-arm"],
    ]);
    expect(run?.["runs-on"]).toBe("${{ matrix.runner }}");
    const check = run?.steps.find((step) =>
      (step.run ?? "").includes("check-archive.sh"),
    );
    expect(check?.run).toContain("--boot");
  });

  it("packs and runs the Apple silicon archive in the sign job", () => {
    const sign = jobs.sign?.steps ?? [];
    const pack = sign.findIndex((step) =>
      (step.run ?? "").includes("pack-programs.sh"),
    );
    expect(pack).toBeGreaterThanOrEqual(0);
    expect(sign[pack]?.run).toContain("check-archive.sh");
  });

  it("carries cloudflared from the Mac build into the archive, and signs it with the other programs", () => {
    const steps = (name: string) => jobs[name]?.steps ?? [];
    const copy = (name: string, text: string) =>
      steps(name).find(
        (step) =>
          (step.run ?? "").includes("cp ") &&
          (step.run ?? "").includes(text) &&
          (step.run ?? "").includes("cloudflared"),
      );
    expect(copy("programs-macos", "$RUNNER_TEMP/artifacts/")).toBeDefined();
    expect(copy("sign", "$RUNNER_TEMP/pack/")).toBeDefined();
    const signing = steps("sign").filter((step) =>
      /sign-binary\.sh|codesign --force/.exec(step.run ?? ""),
    );
    expect(signing).toHaveLength(2);
    for (const step of signing) {
      expect(step.run).toContain("marfa marfa-server cloudflared");
    }
  });

  it("fetches cloudflared in the program build of every target, after the notices it adds to", () => {
    const script = readFileSync(join(RELEASE, "build-programs.sh"), "utf8");
    const notices = script.indexOf("licenses.sh");
    const fetched = script.indexOf(
      '"$REPO/scripts/release/fetch-cloudflared.sh" "$TARGET" "$OUT"',
    );
    expect(notices).toBeGreaterThanOrEqual(0);
    expect(fetched).toBeGreaterThan(notices);
    // After the Linux build that runs inside the image and exits early, so it runs outside it.
    expect(fetched).toBeGreaterThan(script.indexOf("exit 0"));
  });
});

describe("a release is published only when every archive built", () => {
  it("collects the signed macOS archive and both Linux archives before it publishes", () => {
    expect(needs(jobs.collect).sort()).toEqual([
      "programs-linux",
      "sign",
      "version",
    ]);
    expect(needs(jobs.publish)).toContain("collect");
    expect(needs(jobs.publish)).toContain("run-linux");
    expect(needs(jobs.publish)).toContain("image");
    expect(jobs.collect?.if).toBeUndefined();
  });

  it("publishes what the collect job uploaded, and no other artifact", () => {
    const publish = jobs.publish?.steps.find(
      (step) =>
        step.uses?.startsWith("actions/download-artifact") &&
        step.with?.path === "artifacts",
    );
    expect(publish?.with?.name).toBe(
      "release-${{ needs.version.outputs.version }}",
    );
    const upload = jobs.collect?.steps.find(
      (step) =>
        step.uses?.startsWith("actions/upload-artifact") &&
        step.with?.name === "release-${{ needs.version.outputs.version }}",
    );
    expect(upload).toBeDefined();
    const uploaded = jobs.sign?.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact"),
    );
    expect(uploaded?.with?.name).not.toBe(upload?.with?.name);
  });

  it("reads no secret in the jobs that build the Linux programs, gather the release or run it", () => {
    for (const name of ["programs-linux", "run-linux", "collect"]) {
      expect(JSON.stringify(jobs[name])).not.toContain("secrets.");
    }
  });

  it("checks the archives the release holds against its checksums before anything irreversible", () => {
    const steps = jobs.publish?.steps ?? [];
    const check = steps.findIndex((step) =>
      (step.run ?? "").includes("sha256sum -c"),
    );
    const npm = steps.findIndex((step) =>
      (step.run ?? "").includes('npm publish "./artifacts'),
    );
    const open = steps.findIndex((step) =>
      (step.run ?? "").includes("--draft=false"),
    );
    expect(check).toBeGreaterThanOrEqual(0);
    expect(steps[check]?.run).toContain("gh release download");
    expect(check).toBeLessThan(npm);
    expect(check).toBeLessThan(open);
  });

  it("writes one checksum file for the three archives", () => {
    const step = jobs.collect?.steps.find((candidate) =>
      (candidate.run ?? "").includes("write-checksums.sh"),
    );
    for (const platform of ["darwin-arm64", "linux-aarch64", "linux-x86_64"]) {
      expect(step?.run).toContain(`"marfa-$VERSION-${platform}.tar.gz"`);
    }
    expect(step?.run).not.toContain("darwin-x86_64");
    expect(step?.run).toContain('"marfa-$VERSION-checksums.txt"');
  });

  it("writes the Homebrew formula in the collect job and holds it apart from the release", () => {
    const steps = jobs.collect?.steps ?? [];
    const formula = steps.find((step) =>
      (step.run ?? "").includes("write-formula.sh"),
    );
    expect(formula).toBeDefined();
    const names = steps
      .filter((step) => step.uses?.startsWith("actions/upload-artifact"))
      .map((step) => step.with?.name);
    expect(names).toEqual([
      "release-${{ needs.version.outputs.version }}",
      "formula-${{ needs.version.outputs.version }}",
    ]);
  });
});

/** A program that reports `name version`, in a folder with the other files. */
function archiveOf(
  programs: Record<string, string>,
  extra: Record<string, string> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "marfa-programs-"));
  const folder = join(directory, "folder");
  mkdirSync(folder);
  for (const [name, text] of Object.entries({ ...programs, ...extra })) {
    writeFileSync(join(folder, name), text);
    chmodSync(join(folder, name), 0o755);
  }
  return { directory, folder, archive: join(directory, "out.tar.gz") };
}

/** The release the pin file names. */
const PINNED = /^version (\S+)$/m.exec(readFileSync(PINS, "utf8"))![1]!;

const connector = (version: string = PINNED) =>
  `#!/bin/sh\necho "cloudflared version ${version} (built 2026-11-17-15:04 UTC)"\n`;

const sha256 = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");

const good = (version: string) => ({
  marfa: reports("marfa", version),
  "marfa-server": reports("marfa-server", version),
  cloudflared: connector(),
  "NOTICES.txt": "licenses",
});

describe("pack-programs.sh", () => {
  it("packs the three programs and the notice, flat, and nothing else", () => {
    const { directory, folder, archive } = archiveOf(good("0.0.9"), {
      "marfa-enrichment-read": reports("marfa-enrichment-read", "0.0.9"),
    });
    try {
      const packed = spawnSync("bash", [PACK, folder, archive], {
        encoding: "utf8",
      });
      expect(packed.status).toBe(0);
      const listed = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
      expect(listed.stdout.trim().split("\n").sort()).toEqual([
        "NOTICES.txt",
        "cloudflared",
        "marfa",
        "marfa-server",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["marfa", "marfa-server", "cloudflared", "NOTICES.txt"])(
    "refuses a folder with %s missing or empty",
    (name) => {
      for (const empty of [false, true]) {
        const full = good("0.0.9") as Record<string, string>;
        const files = empty
          ? { ...full, [name]: "" }
          : Object.fromEntries(
              Object.entries(full).filter(([key]) => key !== name),
            );
        const { directory, folder, archive } = archiveOf(files);
        try {
          const packed = spawnSync("bash", [PACK, folder, archive], {
            encoding: "utf8",
          });
          expect(packed.status, `${name} ${empty ? "empty" : "missing"}`).toBe(
            1,
          );
          expect(packed.stdout).toContain(`${name} is not a non-empty file`);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    },
  );
});

/** A pin file naming `version`, which is all `check-archive.sh` reads of it. */
function pinsFile(directory: string, version = PINNED) {
  const file = join(directory, "pins.txt");
  writeFileSync(file, `version ${version}\n`);
  return file;
}

/**
 * A `codesign` stand-in for `check-archive.sh`, as it runs on a Mac. It verifies every program
 * except those named in CODESIGN_UNSIGNED, and says every program is signed by CODESIGN_TEAM
 * under the flags in CODESIGN_FLAGS.
 */
const CODESIGN_STAND_IN = `#!/bin/sh
if [ "$1" = --verify ]; then
  case ",$CODESIGN_UNSIGNED," in *",$(basename "$3"),"*) exit 1 ;; esac
  exit 0
fi
echo "TeamIdentifier=$CODESIGN_TEAM" >&2
echo "flags=$CODESIGN_FLAGS" >&2
`;

describe("check-archive.sh", () => {
  function check(
    programs: Record<string, string>,
    version: string,
    options: string[] = [],
    extra: Record<string, string> = {},
    pinned: { version?: string } = {},
    env: Record<string, string> = {},
    mode?: (folder: string) => void,
  ) {
    const { directory, folder, archive } = archiveOf(programs, extra);
    try {
      mode?.(folder);
      const tarred = spawnSync(
        "tar",
        ["-czf", archive, "-C", folder, ...readdirSync(folder)],
        { encoding: "utf8" },
      );
      expect(tarred.status).toBe(0);
      const bin = join(directory, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "codesign"), CODESIGN_STAND_IN);
      chmodSync(join(bin, "codesign"), 0o755);
      return spawnSync("bash", [CHECK, archive, version, ...options], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          MARFA_CLOUDFLARED_PINS: pinsFile(directory, pinned.version),
          CODESIGN_TEAM: "ABCDE12345",
          CODESIGN_FLAGS: "0x10000(runtime)",
          ...env,
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("accepts an archive whose programs report the version, and says what each reported", () => {
    const result = check(good("0.0.9"), "0.0.9");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("out.tar.gz: marfa 0.0.9");
    expect(result.stdout).toContain("out.tar.gz: marfa-server 0.0.9");
    expect(result.stdout).toContain(
      `out.tar.gz: cloudflared version ${PINNED} (built`,
    );
  });

  it.each(["marfa", "marfa-server"])(
    "refuses an archive whose %s reports another version",
    (program) => {
      const files = good("0.0.9");
      files[program as "marfa"] = reports(program, "0.0.8");
      const result = check(files, "0.0.9");
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        `${program} in out.tar.gz reports '${program} 0.0.8', not '${program} 0.0.9'`,
      );
    },
  );

  it("refuses an archive that holds a file it should not, or lacks one", () => {
    const extra = check(good("0.0.9"), "0.0.9", [], { stray: "x" });
    expect(extra.status).toBe(1);
    expect(extra.stdout).toContain("does not hold exactly");
    const files = good("0.0.9") as Record<string, string>;
    delete files["marfa-server"];
    const lacking = check(files, "0.0.9");
    expect(lacking.status).toBe(1);
    expect(lacking.stdout).toContain("does not hold exactly");
  });

  it("refuses an archive without cloudflared", () => {
    const files = good("0.0.9") as Record<string, string>;
    delete files.cloudflared;
    const result = check(files, "0.0.9");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("does not hold exactly");
    expect(result.stdout).toContain("cloudflared");
  });

  it("refuses a cloudflared that is not executable", () => {
    const result = check(good("0.0.9"), "0.0.9", [], {}, {}, {}, (folder) => {
      chmodSync(join(folder, "cloudflared"), 0o644);
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "cloudflared in out.tar.gz is not an executable file",
    );
  });

  it("refuses a cloudflared of another release than the pinned one", () => {
    const files = { ...good("0.0.9"), cloudflared: connector("2020.1.1") };
    const result = check(files, "0.0.9");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      `cloudflared in out.tar.gz reports 'cloudflared version 2020.1.1 (built 2026-11-17-15:04 UTC)', not version ${PINNED}`,
    );
  });

  it("does not hold the shipped bytes to the download's hash, which the release's signing changes", () => {
    const files = { ...good("0.0.9"), cloudflared: `${connector()}# signed\n` };
    const result = check(files, "0.0.9");
    expect(result.status, result.stdout).toBe(0);
  });

  it("reads the real pin file's version", () => {
    const { directory, folder, archive } = archiveOf(good("0.0.9"));
    try {
      const bin = join(directory, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "codesign"), CODESIGN_STAND_IN);
      chmodSync(join(bin, "codesign"), 0o755);
      spawnSync("tar", ["-czf", archive, "-C", folder, ...readdirSync(folder)]);
      const result = spawnSync("bash", [CHECK, archive, "0.0.9"], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      });
      expect(result.status, result.stdout).toBe(0);
      expect(result.stdout).toContain(`cloudflared version ${PINNED}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  describe("where macOS signs the programs", () => {
    it("accepts an archive whose programs are all signed", () => {
      const result = check(good("0.0.9"), "0.0.9");
      expect(result.status, result.stdout).toBe(0);
      expect(result.stdout).toContain("every program is signed");
    });

    it.each(["marfa", "marfa-server", "cloudflared"])(
      "refuses an archive whose %s has no valid signature, before running it",
      (program) => {
        const result = check(
          good("0.0.9"),
          "0.0.9",
          [],
          {},
          {},
          {
            CODESIGN_UNSIGNED: program,
          },
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toContain(
          `${program} in out.tar.gz has no valid signature`,
        );
        expect(result.stdout).not.toContain("reports");
      },
    );

    it("holds every program to the release's team under the hardened runtime when it is named", () => {
      const named = { MARFA_EXPECT_TEAM: "ABCDE12345" };
      expect(check(good("0.0.9"), "0.0.9", [], {}, {}, named).status).toBe(0);
      const other = check(
        good("0.0.9"),
        "0.0.9",
        [],
        {},
        {},
        {
          ...named,
          CODESIGN_TEAM: "ZZZZZZZZZZ",
        },
      );
      expect(other.status).toBe(1);
      expect(other.stdout).toContain(
        "is not signed by team ABCDE12345 under the hardened runtime",
      );
      const loose = check(
        good("0.0.9"),
        "0.0.9",
        [],
        {},
        {},
        {
          ...named,
          CODESIGN_FLAGS: "0x0(none)",
        },
      );
      expect(loose.status).toBe(1);
      expect(loose.stdout).toContain("under the hardened runtime");
    });

    it("checks no team when none is named, as in a dry run signed ad hoc", () => {
      const result = check(
        good("0.0.9"),
        "0.0.9",
        [],
        {},
        {},
        {
          CODESIGN_TEAM: "not set",
          CODESIGN_FLAGS: "0x2(adhoc)",
        },
      );
      expect(result.status, result.stdout).toBe(0);
    });
  });

  it("refuses an option it does not know, after it has checked the programs", () => {
    const result = check(good("0.0.9"), "0.0.9", ["--unknown"]);
    expect(result.status).toBe(2);
  });

  it("boots the server it unpacked when asked, and fails when it will not listen", () => {
    const files = good("0.0.9");
    files["marfa-server"] =
      '#!/bin/sh\n[ "$1" = --version ] && { echo "marfa-server 0.0.9"; exit 0; }\nexit 3\n';
    const result = check(files, "0.0.9", ["--boot"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("ended before it listened");
  });
});

describe("boot-server.sh", () => {
  const BOOT = join(RELEASE, "boot-server.sh");

  /** A stand-in server: listens by log line only, and answers /health with a status. */
  function boot(script: string) {
    const directory = mkdtempSync(join(tmpdir(), "marfa-boot-"));
    try {
      const server = join(directory, "marfa-server");
      writeFileSync(server, script);
      chmodSync(server, 0o755);
      return spawnSync("bash", [BOOT, server], { encoding: "utf8" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("refuses something that is not an executable file", () => {
    const result = spawnSync("bash", [BOOT, join(ROOT, "no-such-server")], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("is not an executable file");
  });

  const node = (status: number, exitCode: number) => `#!/usr/bin/env node
const http = require("node:http");
const server = http.createServer((_, response) => {
  response.statusCode = ${status.toString()};
  response.end("ok");
});
server.listen(Number(process.env.MARFA_PORT), "127.0.0.1", () => {
  console.log("Marfa server listening on port " + server.address().port);
});
process.on("SIGTERM", () => process.exit(${exitCode.toString()}));
`;

  it("boots a server on a port it picks, asks /health, and stops it cleanly", () => {
    const result = boot(node(200, 0));
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain("/health answered 200");
    expect(result.stdout).toContain("stopped with status 0");
  });

  it("fails when /health answers anything but 200, or the server stops badly", () => {
    const unhealthy = boot(node(503, 0));
    expect(unhealthy.status).toBe(1);
    expect(unhealthy.stdout).toContain("/health answered 503, not 200");
    const badStop = boot(node(200, 5));
    expect(badStop.status).toBe(1);
    expect(badStop.stdout).toContain("stopped with status 5, not 0");
  });

  it("fails with the server's log when it ends before it listens", () => {
    const result = boot('#!/bin/sh\necho "database is locked"\nexit 3\n');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("ended before it listened");
    expect(result.stdout).toContain("database is locked");
  });

  it("fails when /health cannot be reached", () => {
    const result = boot(
      '#!/bin/sh\necho "Marfa server listening on port 1"\nsleep 30\n',
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("/health could not be reached");
  });
});

describe("image-context.sh", () => {
  function context(files: string[]) {
    const directory = mkdtempSync(join(tmpdir(), "marfa-context-"));
    try {
      const archives = join(directory, "archives");
      mkdirSync(archives);
      for (const arch of ["x86_64", "aarch64"]) {
        const name = `marfa-0.0.9-linux-${arch}.tar.gz`;
        const folder = join(directory, arch);
        mkdirSync(folder);
        for (const file of files) writeFileSync(join(folder, file), arch);
        if (arch === "aarch64" && files.length === 0) continue;
        spawnSync("tar", [
          "-czf",
          join(archives, name),
          "-C",
          folder,
          ...files,
        ]);
      }
      const ran = spawnSync(
        "bash",
        [CONTEXT, archives, "0.0.9", join(directory, "context")],
        { encoding: "utf8" },
      );
      return { ran };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("lays the x86_64 archive under amd64 and the aarch64 archive under arm64", () => {
    const names = ["marfa", "marfa-server", "cloudflared", "NOTICES.txt"];
    const directory = mkdtempSync(join(tmpdir(), "marfa-context-"));
    try {
      const archives = join(directory, "archives");
      mkdirSync(archives);
      for (const arch of ["x86_64", "aarch64"]) {
        const folder = join(directory, arch);
        mkdirSync(folder);
        for (const file of names) writeFileSync(join(folder, file), arch);
        spawnSync("tar", [
          "-czf",
          join(archives, `marfa-0.0.9-linux-${arch}.tar.gz`),
          "-C",
          folder,
          ...names,
        ]);
      }
      const ran = spawnSync(
        "bash",
        [CONTEXT, archives, "0.0.9", join(directory, "context")],
        { encoding: "utf8" },
      );
      expect(ran.status).toBe(0);
      for (const file of names) {
        expect(
          readFileSync(join(directory, "context", "amd64", file), "utf8"),
        ).toBe("x86_64");
        expect(
          readFileSync(join(directory, "context", "arm64", file), "utf8"),
        ).toBe("aarch64");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a missing archive, and an archive without a program", () => {
    const missing = context([]);
    expect(missing.ran.status).toBe(1);
    expect(missing.ran.stdout).toContain("is missing or empty");
    const lacking = context(["marfa", "cloudflared", "NOTICES.txt"]);
    expect(lacking.ran.status).toBe(1);
    expect(lacking.ran.stdout).toContain("holds no marfa-server");
    const noConnector = context(["marfa", "marfa-server", "NOTICES.txt"]);
    expect(noConnector.ran.status).toBe(1);
    expect(noConnector.ran.stdout).toContain("holds no cloudflared");
  });
});

describe("write-checksums.sh", () => {
  const run = (files: Record<string, string>, names: string[]) =>
    inFolder(files, (directory) =>
      spawnSync("bash", [CHECKSUMS, "sums.txt", ...names], {
        cwd: directory,
        encoding: "utf8",
      }),
    );

  it("covers each archive in the sha256sum format and verifies them", () => {
    let sums = "";
    const result = inFolder(
      { "a.tar.gz": "one", "b.tar.gz": "two" },
      (directory) => {
        const ran = spawnSync(
          "bash",
          [CHECKSUMS, "sums.txt", "a.tar.gz", "b.tar.gz"],
          {
            cwd: directory,
            encoding: "utf8",
          },
        );
        sums = readFileSync(join(directory, "sums.txt"), "utf8");
        return ran;
      },
    );
    expect(result.status).toBe(0);
    expect(sums.trim().split("\n")).toHaveLength(2);
    expect(sums).toMatch(
      /^[0-9a-f]{64} {2}a\.tar\.gz\n[0-9a-f]{64} {2}b\.tar\.gz\n$/,
    );
  });

  it("refuses an archive that is not there, naming it", () => {
    const result = run({ "a.tar.gz": "one" }, ["a.tar.gz", "missing.tar.gz"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("missing.tar.gz is missing or empty");
  });
});

describe("cloudflared.txt", () => {
  const pins = readFileSync(PINS, "utf8");
  const lines = pins
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"));
  const downloads = lines
    .filter((line) => line.startsWith("download "))
    .map((line) => line.split(/\s+/));

  it("names one release, one licence hash, one licence bundle hash and one signing team", () => {
    for (const kind of ["version", "licence", "dependencies", "team"]) {
      expect(
        lines.filter((line) => line.startsWith(`${kind} `)),
        kind,
      ).toHaveLength(1);
    }
    expect(PINNED).toMatch(/^\d{4}\.\d{1,2}\.\d+$/);
    for (const kind of ["licence", "dependencies"]) {
      expect(lines.find((line) => line.startsWith(`${kind} `))).toMatch(
        new RegExp(`^${kind} [0-9a-f]{64}$`),
      );
    }
    expect(lines.find((line) => line.startsWith("team "))).toMatch(
      /^team [A-Z0-9]{10}$/,
    );
  });

  it("pins a download and a program hash for exactly the targets the release builds", () => {
    const targets = /SUPPORTED_TARGETS="([^"]*)"/.exec(
      readFileSync(
        join(ROOT, "core", "marfa-enrichment", "native", "lib.sh"),
        "utf8",
      ),
    )![1]!;
    expect(downloads.map((fields) => fields[1]).sort()).toEqual(
      targets.split(" ").sort(),
    );
    for (const [, , asset, download, program, extra] of downloads) {
      expect(asset).toMatch(/^cloudflared-[a-z0-9-]+(\.tgz)?$/);
      expect(download).toMatch(/^[0-9a-f]{64}$/);
      expect(program).toMatch(/^[0-9a-f]{64}$/);
      expect(extra).toBeUndefined();
    }
  });

  it("takes a Linux program as its own download and a Mac program from an archive", () => {
    for (const [, target, asset, download, program] of downloads) {
      if (target!.endsWith("-apple-darwin")) {
        expect(asset).toMatch(/\.tgz$/);
        expect(download).not.toBe(program);
      } else {
        expect(asset).not.toMatch(/\./);
        expect(download).toBe(program);
      }
    }
  });

  it("says how to regenerate the licences when the pin moves, with a script that is there", () => {
    expect(pins).toContain(
      "scripts/release/cloudflared-licences.sh scripts/release/cloudflared-licences.txt",
    );
    expect(statSync(LICENCES_SCRIPT).mode & 0o111).not.toBe(0);
  });

  it("pins the committed licence bundle by its hash", () => {
    const want = lines.find((line) => line.startsWith("dependencies "))!;
    expect(want).toBe(`dependencies ${sha256(readFileSync(LICENCES))}`);
  });
});

describe("cloudflared-licences.txt", () => {
  const text = readFileSync(LICENCES, "utf8");
  const entries = [...text.matchAll(/^=== (\S+) (\S+) ===$/gm)];
  const bodies = text.split(/^=== \S+ \S+ ===$/m).slice(1);

  it("opens with the Go standard library and holds a licence text for every entry", () => {
    expect(entries[0]![1]).toBe("go");
    expect(entries.length).toBeGreaterThan(20);
    expect(bodies).toHaveLength(entries.length);
    for (const [index, body] of bodies.entries()) {
      // Every module's text is one or more files, each opened by its name.
      const label = `${entries[index]![1]!} ${entries[index]![2]!}`;
      if (index > 0) expect(body, label).toMatch(/^--- \S+ ---$/m);
      expect(body.trim().length, label).toBeGreaterThan(200);
    }
  });

  it("names each module once", () => {
    const names = entries.map((entry) => `${entry[1]!} ${entry[2]!}`);
    expect(new Set(names).size).toBe(names.length);
  });

  it("names the pinned release's own modules: the program's licence is not repeated here", () => {
    expect(text).not.toMatch(/^=== github\.com\/cloudflare\/cloudflared /m);
    expect(text).toContain("github.com/cloudflare/backoff");
  });
});

describe("the Go modules of cloudflared are all licensed", () => {
  const MODULES = join(RELEASE, "cloudflared-modules.sh");

  /** What `go version -m` prints, with tabs as it prints them. */
  const info = (release: string, deps: string[]) =>
    [
      `program: ${release}`,
      "\tpath\texample.com/cloudflared/cmd",
      "\tmod\texample.com/cloudflared\t(devel)\t",
      ...deps.map((dep) => `\t${dep}`),
      "",
    ].join("\n");

  function entriesOf(output: string) {
    const ran = spawnSync(
      "bash",
      [
        "-c",
        `source "${MODULES}"; go_release <<< "$INFO"; echo ---; go_modules <<< "$INFO"`,
      ],
      { encoding: "utf8", env: { ...process.env, INFO: output } },
    );
    expect(ran.status, ran.stderr).toBe(0);
    const [release, modules] = ran.stdout.split("---\n");
    return { release: release!.trim(), modules: modules!.trim() };
  }

  it("reads the Go release and each module, a replaced one by its replacement", () => {
    const read = entriesOf(
      info("go1.2.3", [
        "dep\texample.com/a\tv1.0.0\th1:aaa=",
        "dep\texample.com/b\tv2.0.0\th1:bbb=",
        "=>\texample.com/b-fork\tv2.0.1-0.2026\th1:ccc=",
        "dep\texample.com/c\tv3.0.0\t",
      ]),
    );
    expect(read.release).toBe("go1.2.3");
    expect(read.modules.split("\n")).toEqual([
      "example.com/a v1.0.0",
      "example.com/b-fork v2.0.1-0.2026",
      "example.com/c v3.0.0",
    ]);
  });
});

describe("fetch-cloudflared.sh", () => {
  const TARGET = "x86_64-unknown-linux-musl";
  const MAC = "aarch64-apple-darwin";
  const PROGRAM = connector();
  const LICENCE = "Apache License\nVersion 2.0\n";
  const GO = "go1.2.3";
  const DEPS = [
    "dep\texample.com/a\tv1.0.0\th1:aaa=",
    "dep\texample.com/b\tv2.0.0\th1:bbb=",
    "=>\texample.com/b-fork\tv2.0.1\th1:ccc=",
  ];
  const BUNDLE = [
    "Licences of the modules.",
    "",
    `=== go ${GO} ===`,
    "The Go licence.",
    "=== example.com/a v1.0.0 ===",
    "--- LICENSE ---",
    "Licence of a.",
    "=== example.com/b-fork v2.0.1 ===",
    "--- LICENSE ---",
    "Licence of the fork of b.",
    "",
  ].join("\n");
  const goInfo = (release = GO, deps = DEPS) =>
    [
      `program: ${release}`,
      "\tpath\texample.com/cloudflared/cmd",
      "\tmod\texample.com/cloudflared\t(devel)\t",
      ...deps.map((dep) => `\t${dep}`),
      "",
    ].join("\n");

  interface Setup {
    /** What the download serves, by the asset's name. */
    served?: Record<string, string | Buffer>;
    /** The pin file's text, from the folder that holds the served files. */
    pins?: (served: string) => string;
    notices?: string | null;
    target?: string;
    env?: Record<string, string>;
    /** A `codesign` stand-in, put first on the path. */
    codesign?: {
      details: string;
      verifies: boolean;
      /** Whether `--remove-signature` leaves the program unsigned; true unless said. */
      removes?: boolean;
    };
    /** What `go version -m` prints, or null for a machine without go. */
    go?: string | null;
    /** The bundle the script reads. */
    bundle?: string;
  }

  /** A tarball holding `files`, as the Mac download is. */
  function tarball(directory: string, files: Record<string, string>) {
    const inner = join(directory, "inner");
    mkdirSync(inner);
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(inner, name), text);
    }
    const file = join(directory, "made.tgz");
    spawnSync("tar", ["-czf", file, "-C", inner, ...Object.keys(files)]);
    return readFileSync(file);
  }

  /** The pin file's lines for a download, with the licences and the bundle's hashes. */
  const pinText = (
    target: string,
    asset: string,
    download: string | Buffer,
    program: string,
    options: { licence?: string; bundle?: string } = {},
  ) =>
    [
      `version ${PINNED}`,
      `licence ${sha256(options.licence ?? LICENCE)}`,
      `dependencies ${sha256(options.bundle ?? BUNDLE)}`,
      "team ABCDE12345",
      `download ${target} ${asset} ${sha256(download)} ${sha256(program)}`,
      "",
    ].join("\n");

  function fetchWith(setup: Setup = {}) {
    const directory = mkdtempSync(join(tmpdir(), "marfa-fetch-"));
    try {
      const served = join(directory, "served");
      const out = join(directory, "out");
      const bin = join(directory, "bin");
      mkdirSync(served);
      mkdirSync(out);
      mkdirSync(bin);
      const target = setup.target ?? TARGET;
      const mac = target === MAC;
      const archive = mac ? tarball(directory, { cloudflared: PROGRAM }) : null;
      const asset = mac ? "cloudflared-mac.tgz" : "cloudflared-linux";
      const files = setup.served ?? { [asset]: archive ?? PROGRAM };
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(served, name), content);
      }
      writeFileSync(join(served, "LICENSE"), LICENCE);
      writeFileSync(join(directory, "licences.txt"), setup.bundle ?? BUNDLE);
      writeFileSync(
        join(directory, "pins.txt"),
        setup.pins?.(served) ??
          pinText(target, asset, archive ?? PROGRAM, PROGRAM),
      );
      if (setup.notices !== null) {
        writeFileSync(join(out, "NOTICES.txt"), setup.notices ?? "notices\n");
      }
      const log = join(directory, "codesign.log");
      if (setup.codesign) {
        const { details, verifies, removes = true } = setup.codesign;
        writeFileSync(
          join(bin, "codesign"),
          `#!/bin/sh
echo "$*" >> '${log}'
case "$1" in
  --remove-signature) ${removes ? `touch '${bin}/removed'` : "true"}; exit 0 ;;
  --verify) [ -e '${bin}/removed' ] && exit 1; exit ${verifies ? "0" : "1"} ;;
esac
echo '${details}' >&2
`,
        );
        chmodSync(join(bin, "codesign"), 0o755);
      }
      if (setup.go !== null) {
        writeFileSync(join(directory, "go-info"), setup.go ?? goInfo());
        writeFileSync(
          join(bin, "go"),
          `#!/bin/sh\n[ "$1 $2" = "version -m" ] && [ -f "$3" ] || exit 2\ncat '${directory}/go-info'\n`,
        );
        chmodSync(join(bin, "go"), 0o755);
      }
      const ran = spawnSync("bash", [FETCH, target, out], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          // A runner may have go in a system folder, so a name nothing provides stands for none.
          MARFA_CLOUDFLARED_GO:
            setup.go === null ? "marfa-test-no-go" : join(bin, "go"),
          MARFA_CLOUDFLARED_PINS: join(directory, "pins.txt"),
          MARFA_CLOUDFLARED_DOWNLOADS: `file://${served}`,
          MARFA_CLOUDFLARED_LICENCE_URL: `file://${served}/LICENSE`,
          MARFA_CLOUDFLARED_LICENCES: join(directory, "licences.txt"),
          ...setup.env,
        },
      });
      const placed = join(out, "cloudflared");
      return {
        ran,
        placed: readdirSync(out).includes("cloudflared")
          ? readFileSync(placed, "utf8")
          : null,
        executable: readdirSync(out).includes("cloudflared")
          ? (statSync(placed).mode & 0o111) !== 0
          : false,
        leftovers: readdirSync(out).sort(),
        notices: readdirSync(out).includes("NOTICES.txt")
          ? readFileSync(join(out, "NOTICES.txt"), "utf8")
          : null,
        signing: readdirSync(directory).includes("codesign.log")
          ? readFileSync(log, "utf8")
          : "",
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  const signed = {
    details: "TeamIdentifier=ABCDE12345\nflags=0x10000(runtime)",
    verifies: true,
  };

  it("places the pinned program, executable, beside the notices, and adds the licence and the module licences to them", () => {
    const done = fetchWith();
    expect(done.ran.status, done.ran.stdout + done.ran.stderr).toBe(0);
    expect(done.placed).toBe(PROGRAM);
    expect(done.executable).toBe(true);
    expect(done.leftovers).toEqual(["NOTICES.txt", "cloudflared"]);
    expect(done.notices?.startsWith("notices\n")).toBe(true);
    expect(done.notices).toContain(`cloudflared ${PINNED}: Apache-2.0`);
    const notices = done.notices!;
    expect(notices.indexOf("Apache License\nVersion 2.0\n")).toBeGreaterThan(0);
    expect(notices.indexOf(BUNDLE)).toBeGreaterThan(
      notices.indexOf("Apache License\nVersion 2.0\n"),
    );
    expect(notices).toContain(
      `cloudflared ${PINNED}: the Go modules it is built from`,
    );
  });

  it("unpacks the Mac archive, accepts it only when Cloudflare's program is signed by the pinned team under the hardened runtime, then removes that signature", () => {
    const done = fetchWith({ target: MAC, codesign: signed });
    expect(done.ran.status, done.ran.stdout + done.ran.stderr).toBe(0);
    expect(done.placed).toBe(PROGRAM);
    const calls = done.signing.trim().split("\n");
    expect(calls.some((call) => call.startsWith("--verify --strict"))).toBe(
      true,
    );
    const removal = calls.findIndex((call) =>
      call.startsWith("--remove-signature "),
    );
    expect(removal).toBeGreaterThan(0);
    expect(calls[removal]).toMatch(/cloudflared\.part$/);
    for (const codesign of [
      { ...signed, verifies: false },
      {
        ...signed,
        details: "TeamIdentifier=ZZZZZZZZZZ\nflags=0x10000(runtime)",
      },
      { ...signed, details: "TeamIdentifier=ABCDE12345\nflags=0x0(none)" },
    ]) {
      const refused = fetchWith({ target: MAC, codesign });
      expect(refused.ran.status).toBe(1);
      expect(refused.ran.stdout).toMatch(
        /signature does not verify|is not signed by team ABCDE12345/,
      );
      expect(refused.placed).toBeNull();
      expect(refused.signing).not.toContain("--remove-signature");
    }
  });

  it("refuses a Mac program that is still signed once its signature was removed, and places nothing", () => {
    const done = fetchWith({
      target: MAC,
      codesign: { ...signed, removes: false },
    });
    expect(done.ran.status).toBe(1);
    expect(done.ran.stdout).toContain("still signed");
    expect(done.placed).toBeNull();
    expect(done.leftovers).toEqual(["NOTICES.txt"]);
  });

  it("leaves a Linux program's bytes and signature alone", () => {
    const done = fetchWith({ codesign: signed });
    expect(done.ran.status, done.ran.stdout + done.ran.stderr).toBe(0);
    expect(done.signing).toBe("");
  });

  it("refuses a download whose hash is not the pinned one, and places nothing", () => {
    const done = fetchWith({
      served: { "cloudflared-linux": `${PROGRAM}# tampered\n` },
    });
    expect(done.ran.status).toBe(1);
    expect(done.ran.stdout).toContain(
      `cloudflared-linux is ${sha256(`${PROGRAM}# tampered\n`)}, not the ${sha256(PROGRAM)} that pins.txt names`,
    );
    expect(done.placed).toBeNull();
    expect(done.notices).toBe("notices\n");
  });

  it("refuses a Mac archive whose program is not the pinned one, though the archive matches", () => {
    const done = fetchWith({
      target: MAC,
      codesign: signed,
      pins: (served) =>
        pinText(
          MAC,
          "cloudflared-mac.tgz",
          readFileSync(join(served, "cloudflared-mac.tgz")),
          "another program",
        ),
    });
    expect(done.ran.status).toBe(1);
    expect(done.ran.stdout).toContain(
      "the cloudflared program in cloudflared-mac.tgz is",
    );
    expect(done.placed).toBeNull();
  });

  it("refuses a Mac archive that holds anything but the program", () => {
    const directory = mkdtempSync(join(tmpdir(), "marfa-fetch-extra-"));
    try {
      const extra = tarball(directory, { cloudflared: PROGRAM, stray: "x" });
      const done = fetchWith({
        target: MAC,
        codesign: signed,
        served: { "cloudflared-mac.tgz": extra },
        pins: () => pinText(MAC, "cloudflared-mac.tgz", extra, PROGRAM),
      });
      expect(done.ran.status).toBe(1);
      expect(done.ran.stdout).toContain("not just cloudflared");
      expect(done.placed).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a licence that is not the pinned one, and leaves no program behind", () => {
    const done = fetchWith({
      pins: () =>
        pinText(TARGET, "cloudflared-linux", PROGRAM, PROGRAM, {
          licence: "another licence",
        }),
    });
    expect(done.ran.status).toBe(1);
    expect(done.ran.stdout).toContain("cloudflared's LICENSE is");
    expect(done.placed).toBeNull();
    expect(done.notices).toBe("notices\n");
  });

  describe("the licences of the Go modules", () => {
    it("accepts a program whose every module has an entry, a replaced one by its replacement", () => {
      const done = fetchWith();
      expect(done.ran.status, done.ran.stdout + done.ran.stderr).toBe(0);
    });

    it("refuses a program built from a module the bundle has no entry for, naming it, and places nothing", () => {
      const done = fetchWith({
        go: goInfo(GO, [...DEPS, "dep\texample.com/new\tv9.9.9\th1:nnn="]),
      });
      expect(done.ran.status).toBe(1);
      expect(done.ran.stdout).toContain(
        "built from example.com/new v9.9.9, which licences.txt has no entry for",
      );
      expect(done.ran.stdout).toContain("Regenerate it as pins.txt says");
      expect(done.placed).toBeNull();
      expect(done.notices).toBe("notices\n");
    });

    it("refuses a module at another version than the entry, and the original of a replaced module", () => {
      for (const deps of [
        ["dep\texample.com/a\tv1.0.1\th1:aaa="],
        [
          "dep\texample.com/b\tv2.0.0\th1:bbb=",
          "=>\texample.com/b-fork\tv2.0.2\th1:ccc=",
        ],
        ["dep\texample.com/b\tv2.0.0\th1:bbb="],
      ]) {
        const done = fetchWith({ go: goInfo(GO, deps) });
        expect(done.ran.status, deps.join()).toBe(1);
        expect(done.ran.stdout).toContain("has no entry for");
        expect(done.placed).toBeNull();
      }
    });

    it("refuses a program built with a Go release the bundle has no entry for", () => {
      const done = fetchWith({ go: goInfo("go9.9.9") });
      expect(done.ran.status).toBe(1);
      expect(done.ran.stdout).toContain("built from go go9.9.9");
    });

    it("refuses a bundle that is not the pinned one, even one with every entry", () => {
      const done = fetchWith({ bundle: `${BUNDLE}A change.\n` });
      expect(done.ran.status).toBe(1);
      expect(done.ran.stdout).toContain(
        `licences.txt is ${sha256(`${BUNDLE}A change.\n`)}, not the ${sha256(BUNDLE)} that pins.txt names`,
      );
      expect(done.placed).toBeNull();
    });

    it("refuses where go is missing or cannot read the program", () => {
      const missing = fetchWith({ go: null });
      expect(missing.ran.status).toBe(1);
      expect(missing.ran.stdout).toContain("go is needed");
      expect(missing.placed).toBeNull();
      const unreadable = fetchWith({ go: "" });
      expect(unreadable.ran.status).toBe(1);
      expect(unreadable.ran.stdout).toContain("go lists no modules");
    });
  });

  it("refuses a download that cannot be fetched", () => {
    const done = fetchWith({
      env: { MARFA_CLOUDFLARED_DOWNLOADS: "file:///no/such/folder" },
    });
    expect(done.ran.status).toBe(1);
    expect(done.ran.stdout).toContain("could not download");
    expect(done.placed).toBeNull();
  });

  it("refuses a target the pins do not name, a malformed hash, and a folder with no notices", () => {
    const target = fetchWith({ target: "x86_64-apple-darwin" });
    expect(target.ran.status).not.toBe(0);
    const hash = fetchWith({
      pins: () =>
        `version ${PINNED}\nlicence ${"a".repeat(64)}\ndependencies ${"a".repeat(64)}\nteam ABCDE12345\ndownload ${TARGET} cloudflared-linux ${"A".repeat(64)} ${"a".repeat(64)}\n`,
    });
    expect(hash.ran.status).toBe(1);
    expect(hash.ran.stdout).toContain("not 64 lowercase hexadecimal digits");
    const bare = fetchWith({ notices: null });
    expect(bare.ran.status).toBe(1);
    expect(bare.ran.stdout).toContain("NOTICES.txt is not a non-empty file");
  });

  it("refuses to add the notice twice", () => {
    const first = fetchWith();
    expect(first.ran.status).toBe(0);
    const twice = fetchWith({ notices: first.notices });
    expect(twice.ran.status).toBe(1);
    expect(twice.ran.stdout).toContain(
      "already carries the cloudflared notice",
    );
  });

  // The release runs this on the real downloads; set MARFA_FETCH_REAL=1 to run it here, with
  // network access and go.
  describe.skipIf(process.env.MARFA_FETCH_REAL !== "1")(
    "the pinned release, downloaded",
    () => {
      it.each([
        "aarch64-apple-darwin",
        "aarch64-unknown-linux-musl",
        "x86_64-unknown-linux-musl",
      ])(
        "has a licence entry for every module go lists for %s",
        (target) => {
          const directory = mkdtempSync(join(tmpdir(), "marfa-fetch-real-"));
          try {
            writeFileSync(join(directory, "NOTICES.txt"), "notices\n");
            const ran = spawnSync("bash", [FETCH, target, directory], {
              encoding: "utf8",
            });
            expect(ran.status, ran.stdout + ran.stderr).toBe(0);
            expect(
              readFileSync(join(directory, "NOTICES.txt"), "utf8"),
            ).toContain(readFileSync(LICENCES, "utf8"));
          } finally {
            rmSync(directory, { recursive: true, force: true });
          }
        },
        600_000,
      );
    },
  );
});
