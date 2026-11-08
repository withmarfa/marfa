/**
 * `scripts/install.sh` installs the `marfa` command line and `marfa-server`
 * from a release. It installs nothing it has not checked: the archive must
 * match its line in the release's checksum file, and both programs in it must
 * run and report the release asked for.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "install.sh");

const NAMES = ["darwin-arm64", "linux-x86_64", "linux-aarch64"];
const PROGRAMS = ["marfa", "marfa-server"];

const cleanup: string[] = [];
afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), "marfa-install-script-"));
  cleanup.push(directory);
  return directory;
}

/**
 * A release folder with all three archives, each holding both programs.
 * Each says `<program> <version>`, unless `says` gives another answer for one,
 * or `programs` leaves one out.
 */
function release(
  version: string,
  options: { says?: Record<string, string>; programs?: string[] } = {},
) {
  const programs = options.programs ?? PROGRAMS;
  const base = folder();
  const lines: string[] = [];
  for (const name of NAMES) {
    const work = folder();
    for (const program of programs) {
      const says = options.says?.[program] ?? `${program} ${version}`;
      writeFileSync(join(work, program), `#!/bin/sh\necho "${says}"\n`);
      chmodSync(join(work, program), 0o755);
    }
    writeFileSync(join(work, "NOTICES.txt"), "licences\n");
    const archive = `marfa-${version}-${name}.tar.gz`;
    const made = spawnSync("tar", [
      "-czf",
      join(base, archive),
      "-C",
      work,
      ...programs,
      "NOTICES.txt",
    ]);
    expect(made.status).toBe(0);
    const hash = createHash("sha256")
      .update(readFileSync(join(base, archive)))
      .digest("hex");
    lines.push(`${hash}  ${archive}`);
  }
  writeFileSync(
    join(base, `marfa-${version}-checksums.txt`),
    `${lines.join("\n")}\n`,
  );
  return base;
}

function install(
  base: string,
  options: {
    version?: string;
    env?: Record<string, string>;
    dir?: string;
  } = {},
) {
  const dir = options.dir ?? join(folder(), "bin");
  const ran = spawnSync("sh", [SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: folder(),
      MARFA_DOWNLOAD_BASE: `file://${base}`,
      MARFA_VERSION: options.version ?? "0.0.23",
      MARFA_INSTALL_DIR: dir,
      ...options.env,
    },
  });
  return { dir, status: ran.status, out: ran.stdout, err: ran.stderr };
}

describe("a release is installed after it is checked", () => {
  it("puts both programs in the folder, runnable, and says what to do next", () => {
    const done = install(release("0.0.23"));
    expect(done.status, done.err).toBe(0);
    for (const program of PROGRAMS) {
      const installed = join(done.dir, program);
      expect(statSync(installed).mode & 0o111).not.toBe(0);
      expect(
        spawnSync(installed, ["--version"], { encoding: "utf8" }).stdout.trim(),
      ).toBe(`${program} 0.0.23`);
    }
    expect(done.out).toContain(
      "Installed marfa 0.0.23 and marfa-server 0.0.23",
    );
    expect(done.out).toContain("marfa server install");
    expect(done.out).toContain("is not on your PATH");
  });

  it("is quiet about the PATH when the folder is on it", () => {
    const dir = join(folder(), "bin");
    mkdirSync(dir);
    const done = install(release("0.0.23"), {
      dir,
      env: { PATH: `${dir}:${process.env.PATH ?? ""}` },
    });
    expect(done.status, done.err).toBe(0);
    expect(done.out).not.toContain("is not on your PATH");
  });

  it("replaces an earlier install and leaves no temporary file", () => {
    const dir = join(folder(), "bin");
    expect(install(release("0.0.22"), { version: "0.0.22", dir }).status).toBe(
      0,
    );
    const done = install(release("0.0.23"), { dir });
    expect(done.status, done.err).toBe(0);
    for (const program of PROGRAMS) {
      expect(
        spawnSync(join(dir, program), ["--version"], {
          encoding: "utf8",
        }).stdout.trim(),
      ).toBe(`${program} 0.0.23`);
    }
    expect(
      spawnSync("ls", ["-A", dir], { encoding: "utf8" }).stdout.trim(),
    ).toBe("marfa\nmarfa-server");
  });
});

describe("it installs nothing it cannot vouch for", () => {
  const refused = (done: ReturnType<typeof install>, said: string) => {
    expect(done.status, done.out).not.toBe(0);
    expect(done.err).toContain(said);
    for (const program of PROGRAMS) {
      expect(existsSync(join(done.dir, program))).toBe(false);
    }
  };

  it("refuses an archive that does not match its checksum", () => {
    const base = release("0.0.23");
    const sums = join(base, "marfa-0.0.23-checksums.txt");
    writeFileSync(
      sums,
      readFileSync(sums, "utf8").replace(/^[0-9a-f]{64}/gm, "0".repeat(64)),
    );
    refused(install(base), "does not match");
  });

  it("refuses a release without its checksum file", () => {
    const base = release("0.0.23");
    rmSync(join(base, "marfa-0.0.23-checksums.txt"));
    refused(install(base), "cannot be checked");
  });

  it("refuses a checksum file that lacks the archive or names it twice", () => {
    const base = release("0.0.23");
    const sums = join(base, "marfa-0.0.23-checksums.txt");
    const text = readFileSync(sums, "utf8");
    writeFileSync(sums, "");
    refused(install(base), "has no line for");
    writeFileSync(sums, text + text);
    refused(install(base), "more than once");
  });

  it("refuses a binary that reports another release", () => {
    refused(
      install(release("0.0.23", { says: { marfa: "marfa 0.0.99" } })),
      "reports 'marfa 0.0.99'",
    );
  });

  it("refuses an archive that lacks marfa-server", () => {
    refused(
      install(release("0.0.23", { programs: ["marfa"] })),
      "holds no marfa-server",
    );
  });

  it("refuses a marfa-server that reports another release", () => {
    refused(
      install(
        release("0.0.23", { says: { "marfa-server": "marfa-server 0.0.99" } }),
      ),
      "reports 'marfa-server 0.0.99'",
    );
  });

  it("refuses a release that does not exist", () => {
    refused(
      install(release("0.0.23"), { version: "0.0.24" }),
      "could not download",
    );
  });

  it("refuses what is not a release number", () => {
    for (const version of ["latest", "v0.0.23", "0.0.23/../x", "../0.0.23"]) {
      refused(install(release("0.0.23"), { version }), "is not a release");
    }
  });

  it("refuses a system it has no archive for", () => {
    const fake = folder();
    writeFileSync(join(fake, "uname"), '#!/bin/sh\necho "FreeBSD"\n');
    chmodSync(join(fake, "uname"), 0o755);
    refused(
      install(release("0.0.23"), {
        env: { PATH: `${fake}:${process.env.PATH ?? ""}` },
      }),
      "FreeBSD is not supported",
    );
  });

  /** A machine that answers `uname -s` and `uname -m` as given, and `sysctl` as an Intel or Apple silicon Mac does. */
  function machine(kernel: string, cpu: string, appleSilicon = false) {
    const fake = folder();
    writeFileSync(
      join(fake, "uname"),
      `#!/bin/sh\ncase "$1" in -s) echo ${kernel} ;; -m) echo ${cpu} ;; esac\n`,
    );
    writeFileSync(
      join(fake, "sysctl"),
      `#!/bin/sh\necho ${appleSilicon ? "1" : "0"}\n`,
    );
    chmodSync(join(fake, "uname"), 0o755);
    chmodSync(join(fake, "sysctl"), 0o755);
    return { PATH: `${fake}:${process.env.PATH ?? ""}` };
  }

  it("refuses an Intel Mac before it downloads anything, and says why", () => {
    const done = install(release("0.0.23"), {
      env: machine("Darwin", "x86_64"),
      version: "0.0.99",
    });
    expect(done.status).not.toBe(0);
    expect(done.err).toContain("Intel Mac");
    expect(done.out).not.toContain("Downloading");
  });

  it("picks the Apple silicon archive in a Rosetta shell on an Apple silicon Mac", () => {
    const done = install(release("0.0.23"), {
      env: machine("Darwin", "x86_64", true),
    });
    expect(done.out).toContain("for darwin arm64");
  });

  it("names the folder to change when it cannot write to the one chosen", () => {
    const locked = folder();
    chmodSync(locked, 0o500);
    const done = install(release("0.0.23"), { dir: join(locked, "bin") });
    expect(done.status).not.toBe(0);
    expect(done.err).toContain("MARFA_INSTALL_DIR");
    chmodSync(locked, 0o700);
  });
});
