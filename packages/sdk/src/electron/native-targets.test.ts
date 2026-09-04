import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  LIBSQL_NATIVE_TARGETS,
  MissingNativeBinaryError,
  assertNativeTargets,
  verifyNativeTargets,
} from "./native-targets.js";
import type { LibsqlTarget } from "./native-targets.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Object-file headers, written by hand.
 *
 * The check reads the first bytes of a binary and nothing else, so a header
 * exercises the whole of it. Synthesizing them rather than copying real
 * binaries around also lets a test place a macOS binary where a Windows one
 * belongs, which is the failure this check exists for and which no install
 * on this machine would ever produce on its own.
 */
function machO(cputype: number): Buffer {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64, little-endian on disk
  header.writeUInt32LE(cputype >>> 0, 4);
  return header;
}

function elf(machine: number): Buffer {
  const header = Buffer.alloc(64);
  header.write("\x7fELF", 0, "binary");
  header[4] = 2; // ELFCLASS64
  header[5] = 1; // ELFDATA2LSB
  header.writeUInt16LE(machine, 18);
  return header;
}

function pe(machine: number): Buffer {
  const header = Buffer.alloc(256);
  header.write("MZ", 0, "binary");
  header.writeUInt32LE(128, 0x3c); // e_lfanew
  header.write("PE\0\0", 128, "binary");
  header.writeUInt16LE(machine, 132);
  return header;
}

const MACH_ARM64 = 0x0100000c;
const MACH_X64 = 0x01000007;
const ELF_X64 = 0x3e;
const ELF_ARM64 = 0xb7;
const PE_X64 = 0x8664;

/** A binary of the shape each target's package is meant to hold. */
const CORRECT: Record<string, Buffer> = {
  "darwin-arm64": machO(MACH_ARM64),
  "darwin-x64": machO(MACH_X64),
  "linux-x64-gnu": elf(ELF_X64),
  "linux-arm64-gnu": elf(ELF_ARM64),
  "win32-x64-msvc": pe(PE_X64),
};

/**
 * A tree shaped like an install, holding whatever each test wants it to.
 *
 * A target left out of `contents` has no package at all, which is the state
 * every ordinary install produces for eight of the nine: they are optional
 * dependencies of `libsql`, so a resolver skips the ones the build host
 * cannot run.
 */
function tree(contents: Partial<Record<LibsqlTarget, Buffer>>): string {
  const root = mkdtempSync(join(tmpdir(), "marfa-native-targets-"));
  roots.push(root);

  for (const [target, binary] of Object.entries(contents)) {
    const dir = join(root, "node_modules", "@libsql", target);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: `@libsql/${target}`,
        version: "0.0.0-test",
        main: "index.node",
      }),
    );
    writeFileSync(join(dir, "index.node"), binary);
  }
  return join(root, "resolve-from.js");
}

describe("what libsql ships its native binding as", () => {
  it("knows exactly the packages libsql declares", () => {
    // The registry is a copy of somebody else's list, so it is held to the
    // original rather than to a memory of it. A tenth target added upstream,
    // or one renamed, is a package an app would silently stop shipping — the
    // failure this whole check exists to catch, arriving through the check.
    //
    // Resolved through `@libsql/client`, which is what this package actually
    // declares, rather than reaching for `libsql` by name from here. The
    // manifest is then read off disk, because `libsql`'s `exports` map does
    // not publish `./package.json`: the file is there and the resolver
    // refuses to name it.
    const fromHere = createRequire(import.meta.url);
    const libsqlEntry = createRequire(
      fromHere.resolve("@libsql/client"),
    ).resolve("libsql");
    const manifest = JSON.parse(
      readFileSync(join(dirname(libsqlEntry), "package.json"), "utf8"),
    ) as {
      optionalDependencies?: Record<string, string>;
    };
    const declared = Object.keys(manifest.optionalDependencies ?? {}).sort();
    const known = Object.values(LIBSQL_NATIVE_TARGETS)
      .map((target) => target.package)
      .sort();
    expect(known).toEqual(declared);
    expect(known.length).toBe(9);
  });
});

describe("verifying an artifact ships a binary for every platform it targets", () => {
  it("passes when each target's package holds a binary of its own shape", () => {
    const from = tree(CORRECT);
    const report = verifyNativeTargets({
      resolveFrom: from,
      targets: [
        "darwin-arm64",
        "darwin-x64",
        "linux-x64-gnu",
        "win32-x64-msvc",
      ],
    });
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
  });

  it("fails, naming the platform, when a target's package was never installed", () => {
    // The state every ordinary install produces. It is not a build error:
    // the build succeeds, the artifact ships, and the first report is a
    // module-not-found on a user's machine at first store open.
    const withoutWindows = { ...CORRECT };
    delete withoutWindows["win32-x64-msvc"];
    const from = tree(withoutWindows);
    const report = verifyNativeTargets({
      resolveFrom: from,
      targets: ["darwin-arm64", "win32-x64-msvc"],
    });
    expect(report.ok).toBe(false);
    expect(report.missing.map((finding) => finding.target)).toEqual([
      "win32-x64-msvc",
    ]);
    expect(report.missing[0]?.problem).toMatch(
      /not installed|cannot be resolved/,
    );
  });

  it("fails when the package is there and the binary inside it is not", () => {
    const from = tree(CORRECT);
    rmSync(
      join(
        dirname(from),
        "node_modules",
        "@libsql",
        "darwin-x64",
        "index.node",
      ),
    );
    const report = verifyNativeTargets({
      resolveFrom: from,
      targets: ["darwin-x64"],
    });
    expect(report.ok).toBe(false);
    expect(report.missing[0]?.target).toBe("darwin-x64");
  });

  it("fails when a target's package holds another platform's binary", () => {
    // The failure in its most misleading dress: the package is present, the
    // file is present, the file is a real object file, and nothing the
    // Windows machine runs can load it. A check that asked only whether a
    // file was there would pass.
    const from = tree({ ...CORRECT, "win32-x64-msvc": machO(MACH_X64) });
    const report = verifyNativeTargets({
      resolveFrom: from,
      targets: ["win32-x64-msvc"],
    });
    expect(report.ok).toBe(false);
    expect(report.missing[0]?.problem).toMatch(/darwin/);
  });

  it("fails when the platform is right and the architecture is not", () => {
    const from = tree({ ...CORRECT, "darwin-x64": machO(MACH_ARM64) });
    const report = verifyNativeTargets({
      resolveFrom: from,
      targets: ["darwin-x64"],
    });
    expect(report.ok).toBe(false);
    expect(report.missing[0]?.problem).toMatch(/arm64/);
  });

  it("names every target that is missing, not the first one it meets", () => {
    // A check that stopped at the first would send someone round the loop
    // once per platform, and each loop is a full packaging run.
    const from = tree({ "darwin-arm64": CORRECT["darwin-arm64"] });
    const report = verifyNativeTargets({
      resolveFrom: from,
      targets: [
        "darwin-arm64",
        "darwin-x64",
        "linux-x64-gnu",
        "win32-x64-msvc",
      ],
    });
    expect(report.missing.map((finding) => finding.target).sort()).toEqual([
      "darwin-x64",
      "linux-x64-gnu",
      "win32-x64-msvc",
    ]);
  });

  it("throws with every missing platform in the message", () => {
    const from = tree({ "darwin-arm64": CORRECT["darwin-arm64"] });
    let thrown: unknown;
    try {
      assertNativeTargets({
        resolveFrom: from,
        targets: ["darwin-arm64", "win32-x64-msvc", "linux-arm64-gnu"],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MissingNativeBinaryError);
    const message = (thrown as Error).message;
    expect(message).toContain("win32-x64-msvc");
    expect(message).toContain("linux-arm64-gnu");
    expect(message).not.toContain("darwin-arm64:");
  });

  it("says nothing and throws nothing when everything is in place", () => {
    expect(() => {
      assertNativeTargets({
        resolveFrom: tree(CORRECT),
        targets: ["darwin-arm64", "win32-x64-msvc"],
      });
    }).not.toThrow();
  });

  it("resolves against a module URL as readily as a path", () => {
    // Callers reach for `import.meta.url`, and a check that only took a path
    // would be one `fileURLToPath` away from working in every consumer.
    const from = pathToFileURL(tree(CORRECT)).href;
    const report = verifyNativeTargets({
      resolveFrom: from,
      targets: ["darwin-arm64"],
    });
    console.log(JSON.stringify(report.findings, null, 2));
    expect(report.ok).toBe(true);
  });

  it("passes against a real binary in a real install", () => {
    // The one test here that reads a binary libsql published rather than a
    // header this file wrote. It proves the reader agrees with the real
    // thing, which every synthetic case above assumes.
    //
    // The walk starts at `libsql`'s own directory because that is the one
    // place a platform package is guaranteed to be on any machine: it is
    // libsql's optional dependency, and an install always resolves the host's
    // own. Starting anywhere else would make this test depend on which
    // targets some other package happens to have declared.
    const fromHere = createRequire(import.meta.url);
    const libsqlDir = dirname(
      createRequire(fromHere.resolve("@libsql/client")).resolve("libsql"),
    );

    const host = `${process.platform}-${process.arch}`;
    const target = (Object.keys(LIBSQL_NATIVE_TARGETS) as LibsqlTarget[]).find(
      (name) =>
        `${LIBSQL_NATIVE_TARGETS[name].platform}-${LIBSQL_NATIVE_TARGETS[name].arch}` ===
        host,
    );
    if (target === undefined) {
      throw new Error(`no libsql target for ${host}; the registry needs one`);
    }

    const report = verifyNativeTargets({
      resolveFrom: join(libsqlDir, "check.js"),
      targets: [target],
    });
    expect(report.missing.map((finding) => finding.problem)).toEqual([]);
    // The binary it read is the published one, not something this file made.
    expect(report.findings[0]?.path).toContain(`@libsql/${target}`);
  });

  it("does not find a package the application has not declared", () => {
    // The case the check exists for, and the one it used to pass. Resolution
    // through `createRequire` answers from a broader search under `tsx` and
    // under Vitest, so a platform package that is merely present somewhere in
    // the store resolved as though the application depended on it — and a
    // build with one platform uninstalled reported five sound platforms.
    const from = tree({ "darwin-arm64": CORRECT["darwin-arm64"] });
    const report = verifyNativeTargets({
      resolveFrom: from,
      targets: ["win32-x64-msvc"],
    });
    expect(report.ok).toBe(false);
    expect(report.missing[0]?.problem).toMatch(/not installed/);
  });
});
