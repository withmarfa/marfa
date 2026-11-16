/**
 * The PDFium library a release or a CI run links is the one the repository
 * names. `native/pdfium.sh` unpacks the saved library, hashes what it holds and
 * compares it with `native/pdfium-libraries.txt`, so a library that a cache
 * holds is never trusted on the word of its own entry. The script is run here
 * on a copy of the native folder against archives made in the test, and builds
 * nothing.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NATIVE = join(ROOT, "core", "marfa-enrichment", "native");
const TARGETS = [
  "aarch64-apple-darwin",
  "aarch64-unknown-linux-musl",
  "x86_64-unknown-linux-musl",
];

const sha256 = (data: Buffer | string): string =>
  createHash("sha256").update(data).digest("hex");

/** The hash `tree_hash` in lib.sh makes: every file's hash and path, sorted. */
function treeHash(folder: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(`./${relative(folder, path)}`);
    }
  };
  walk(folder);
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(
    files
      .map((file) => `${sha256(readFileSync(join(folder, file)))}  ${file}\n`)
      .join(""),
  );
}

describe("pdfium-libraries.txt", () => {
  const lines = readFileSync(join(NATIVE, "pdfium-libraries.txt"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"));

  it("names one library, by hash, for each target the scripts build", () => {
    const named = lines.map((line) => {
      const [target = "", hash, ...rest] = line.split(/\s+/);
      expect(hash, line).toMatch(/^[0-9a-f]{64}$/);
      expect(rest, line).toEqual([]);
      return target;
    });
    expect(named.slice().sort()).toEqual(TARGETS);
  });

  it("names the targets the build scripts know, and no others", () => {
    const lib = readFileSync(join(NATIVE, "lib.sh"), "utf8");
    const supported = /^SUPPORTED_TARGETS="([^"]+)"/m.exec(lib)?.[1] ?? "";
    expect(supported.split(" ").sort()).toEqual(TARGETS);
  });
});

describe("native/pdfium.sh on a saved library", () => {
  const scratch = mkdtempSync(join(tmpdir(), "pdfium-library-"));
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });
  const target = "aarch64-apple-darwin";
  let count = 0;

  interface Setup {
    /** What the file names for the target: the saved library's hash, another, or nothing. */
    names?: "the library" | "another" | "nothing";
    /** The file names the library, but for another target. */
    otherTarget?: boolean;
    /** The library changes after its hash was taken. */
    tamper?: boolean;
    /** The archive holds a link. */
    link?: boolean;
    unpinned?: boolean;
  }

  function run(setup: Setup) {
    const dir = join(scratch, `case-${String(count++)}`);
    const native = join(dir, "native");
    mkdirSync(native, { recursive: true });
    for (const name of ["lib.sh", "pdfium.sh", "manifest.txt", "patches"]) {
      cpSync(join(NATIVE, name), join(native, name), { recursive: true });
    }
    const recipe = execFileSync(
      "bash",
      [join(native, "pdfium.sh"), target, "--recipe"],
      { encoding: "utf8" },
    ).trim();

    // The library as the build saves it.
    const tree = join(dir, "tree");
    mkdirSync(join(tree, "lib"), { recursive: true });
    mkdirSync(join(tree, "include", "pdfium"), { recursive: true });
    mkdirSync(join(tree, "licenses", "pdfium"), { recursive: true });
    writeFileSync(join(tree, "lib", "libpdfium.a"), "the library");
    writeFileSync(join(tree, "include", "pdfium", "fpdfview.h"), "a header");
    writeFileSync(join(tree, "licenses", "pdfium", "LICENSE"), "a licence");
    writeFileSync(join(tree, "pdfium-commit"), "0".repeat(40));
    const hash = treeHash(tree);

    if (setup.tamper) writeFileSync(join(tree, "lib", "libpdfium.a"), "other");
    if (setup.link) symlinkSync("/etc/passwd", join(tree, "lib", "link"));
    const root = join(dir, "root");
    mkdirSync(join(root, "archives"), { recursive: true });
    const archive = join(root, "archives", `pdfium-${target}-${recipe}.tgz`);
    execFileSync("tar", ["-czf", archive, "-C", tree, "."]);
    writeFileSync(`${archive}.sha256`, `${sha256(readFileSync(archive))}  x\n`);

    const named =
      setup.names === "nothing" || setup.otherTarget
        ? []
        : [`${target} ${setup.names === "another" ? "f".repeat(64) : hash}`];
    const other = setup.otherTarget
      ? [`x86_64-unknown-linux-musl ${hash}`]
      : [];
    writeFileSync(
      join(native, "pdfium-libraries.txt"),
      ["# test", ...named, ...other, ""].join("\n"),
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MARFA_NATIVE_ROOT: root,
    };
    delete env.MARFA_PDFIUM_UNPINNED;
    if (setup.unpinned) env.MARFA_PDFIUM_UNPINNED = "1";
    const result = spawnSync("bash", [join(native, "pdfium.sh"), target], {
      env,
      encoding: "utf8",
    });
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      installed: existsSync(join(root, "prefix", target, "lib", "libpdfium.a")),
      hash,
      root,
    };
  }

  it("installs the library the file names, and builds nothing", () => {
    const result = run({ names: "the library" });
    expect(result.output).toContain("names (");
    expect(result.status).toBe(0);
    expect(result.installed).toBe(true);
    expect(
      readFileSync(
        join(result.root, "prefix", target, "lib", "libpdfium.a"),
        "utf8",
      ),
    ).toBe("the library");
    expect(
      statSync(join(result.root, "prefix", target, "pdfium-commit")).isFile(),
    ).toBe(true);
  });

  it("refuses a library whose hash is not the one the file names, and installs nothing", () => {
    const result = run({ names: "another" });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("refusing the PDFium library");
    expect(result.installed).toBe(false);
  });

  it("refuses a library that changed after its hash was named", () => {
    const result = run({ names: "the library", tamper: true });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("refusing the PDFium library");
    expect(result.installed).toBe(false);
  });

  it("refuses a library the file does not name, and prints the line to commit", () => {
    const result = run({ names: "nothing" });
    expect(result.status).not.toBe(0);
    expect(result.installed).toBe(false);
    expect(result.output).toContain(`${target} ${result.hash}`);
  });

  it("does not count the line of another target", () => {
    const result = run({ otherTarget: true });
    expect(result.status).not.toBe(0);
    expect(result.installed).toBe(false);
  });

  it("refuses an archive that holds a link", () => {
    const result = run({ names: "the library", link: true });
    expect(result.status).not.toBe(0);
    expect(result.installed).toBe(false);
  });

  it("installs a library the file does not name only when told it is unpinned", () => {
    const result = run({ names: "nothing", unpinned: true });
    expect(result.status).toBe(0);
    expect(result.installed).toBe(true);
    expect(result.output).toContain(`${target} ${result.hash}`);
  });
});

describe("the Xcode the macOS hash holds for", () => {
  interface Step {
    name?: string;
    run?: string;
    uses?: string;
  }
  const job = (
    parse(
      readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8"),
    ) as {
      jobs: Record<string, { env?: Record<string, string>; steps: Step[] }>;
    }
  ).jobs["programs-macos"]!;

  it("is selected by name, not left to the image's default", () => {
    const version = job.env?.XCODE_VERSION ?? "";
    expect(version).toMatch(/^\d+(\.\d+)+$/);
    expect(job.env?.DEVELOPER_DIR).toBe(
      `/Applications/Xcode_${version}.app/Contents/Developer`,
    );
  });

  it("is checked by the first step, which names the Xcode when it is missing", () => {
    const first = job.steps[0]!;
    expect(first.uses).toBeUndefined();
    expect(first.run).toContain("xcodebuild -version");
    expect(first.run).toContain('"$XCODE_VERSION"');
    expect(first.run).toContain("::error::");
  });
});
