/**
 * `scripts/install.sh` installs the `marfa` command line from a release. It
 * installs nothing it has not checked: the archive must match its line in the
 * release's checksum file, and the binary in it must run and report the
 * release asked for.
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

const NAMES = [
  "darwin-arm64",
  "darwin-x86_64",
  "linux-x86_64",
  "linux-aarch64",
];

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

/** A release folder with all four archives, each holding a `marfa` that says `reports`. */
function release(version: string, reports = `marfa ${version}`) {
  const base = folder();
  const lines: string[] = [];
  for (const name of NAMES) {
    const work = folder();
    writeFileSync(join(work, "marfa"), `#!/bin/sh\necho "${reports}"\n`);
    chmodSync(join(work, "marfa"), 0o755);
    const archive = `marfa-${version}-${name}.tar.gz`;
    const made = spawnSync("tar", [
      "-czf",
      join(base, archive),
      "-C",
      work,
      "marfa",
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
  it("puts a runnable marfa in the folder and says what to do next", () => {
    const done = install(release("0.0.23"));
    expect(done.status, done.err).toBe(0);
    const installed = join(done.dir, "marfa");
    expect(statSync(installed).mode & 0o111).not.toBe(0);
    expect(
      spawnSync(installed, ["--version"], { encoding: "utf8" }).stdout.trim(),
    ).toBe("marfa 0.0.23");
    expect(done.out).toContain("Installed marfa 0.0.23");
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
    expect(
      spawnSync(join(dir, "marfa"), ["--version"], {
        encoding: "utf8",
      }).stdout.trim(),
    ).toBe("marfa 0.0.23");
    expect(
      spawnSync("ls", ["-A", dir], { encoding: "utf8" }).stdout.trim(),
    ).toBe("marfa");
  });
});

describe("it installs nothing it cannot vouch for", () => {
  const refused = (done: ReturnType<typeof install>, said: string) => {
    expect(done.status, done.out).not.toBe(0);
    expect(done.err).toContain(said);
    expect(existsSync(join(done.dir, "marfa"))).toBe(false);
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
      install(release("0.0.23", "marfa 0.0.99")),
      "reports 'marfa 0.0.99'",
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

  it("names the folder to change when it cannot write to the one chosen", () => {
    const locked = folder();
    chmodSync(locked, 0o500);
    const done = install(release("0.0.23"), { dir: join(locked, "bin") });
    expect(done.status).not.toBe(0);
    expect(done.err).toContain("MARFA_INSTALL_DIR");
    chmodSync(locked, 0o700);
  });
});
