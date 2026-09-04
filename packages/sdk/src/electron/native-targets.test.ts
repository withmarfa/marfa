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
import type { LibsqlTarget, NativeTargetReport } from "./native-targets.js";

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

/**
 * A universal binary: a header naming its slices and nothing else.
 *
 * The layout is `magic`, `nfat_arch`, then one 20-byte `fat_arch` per slice
 * beginning with `cputype` — all big-endian. Only the cputypes matter here,
 * so the offset, size and align fields are left zero.
 */
function fatMachO(cputypes: number[]): Buffer {
  const header = Buffer.alloc(8 + 20 * cputypes.length);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(cputypes.length, 4);
  cputypes.forEach((cputype, index) => {
    header.writeUInt32BE(cputype >>> 0, 8 + index * 20);
  });
  return header;
}

/** A Java class file, which begins with the same four bytes a universal
 *  binary does. `cafebabe`, minor version, major version. */
function javaClass(major: number): Buffer {
  const header = Buffer.alloc(64);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt16BE(0, 4);
  header.writeUInt16BE(major, 6);
  return header;
}

/** An `MZ` file with whatever `e_lfanew` and PE signature the caller wants. */
function dosStub(options: {
  lfanew?: number;
  signature?: number;
  machine?: number;
  size?: number;
}): Buffer {
  const header = Buffer.alloc(options.size ?? 512);
  header.write("MZ", 0, "binary");
  if (options.lfanew !== undefined) header.writeUInt32LE(options.lfanew, 0x3c);
  if (options.signature !== undefined && options.lfanew !== undefined) {
    header.writeUInt32BE(options.signature, options.lfanew);
    if (options.machine !== undefined) {
      header.writeUInt16LE(options.machine, options.lfanew + 4);
    }
  }
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
function tree(
  contents: Partial<Record<LibsqlTarget, Buffer>>,
  options: { sealExports?: boolean } = {},
): string {
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
        // An `exports` map publishing the binding and nothing else, which is
        // what `libsql` itself already does and what napi and neon packages
        // increasingly do. It changes nothing on disk and makes the manifest
        // unnameable through the resolver.
        ...(options.sealExports === true
          ? { exports: { ".": "./index.node" } }
          : {}),
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
    const from = tree({ "darwin-arm64": CORRECT["darwin-arm64"] });
    const report = verifyNativeTargets({
      resolveFrom: from,
      targets: ["win32-x64-msvc"],
    });
    expect(report.ok).toBe(false);
    expect(report.missing[0]?.problem).toMatch(/not installed/);
  });

  it("finds a package whose manifest the resolver refuses to name", () => {
    // The case that separates the walk from `require.resolve`, and the only
    // one of the two differences a test in this suite can reach. A package
    // with an `exports` map that does not publish `./package.json` is on
    // disk and unnameable: the walk reads the file, while
    // `createRequire(...).resolve(pkg + "/package.json")` — which is what
    // this check used to do — throws `ERR_PACKAGE_PATH_NOT_EXPORTED` and
    // reports the package uninstalled. `libsql` is already shaped this way.
    //
    // The first assertion is part of the comparison rather than a note
    // beside it: it establishes, here, that the strategy this replaced does
    // fail on this tree. Swap `resolvePackageDirectory` back and this test
    // reddens; the rest of the file does not.
    const from = tree(
      { "win32-x64-msvc": CORRECT["win32-x64-msvc"] },
      { sealExports: true },
    );
    expect(() =>
      createRequire(from).resolve("@libsql/win32-x64-msvc/package.json"),
    ).toThrow(/ERR_PACKAGE_PATH_NOT_EXPORTED|not defined by "exports"/);

    const report = verifyNativeTargets({
      resolveFrom: from,
      targets: ["win32-x64-msvc"],
    });
    expect(report.ok).toBe(true);
  });
});

/**
 * What the reader has to refuse.
 *
 * Every case here is a file that is present, is the right size, and cannot
 * be loaded by the platform whose package it is sitting in. A check that
 * asks whether a file exists passes all of them, and so did this one: each
 * was built as a fake tree and run through the real `verifyNativeTargets`.
 */
describe("binaries that are present and cannot be loaded", () => {
  function problemFor(target: LibsqlTarget, binary: Buffer): string {
    const contents: Partial<Record<LibsqlTarget, Buffer>> = {
      [target]: binary,
    };
    const report = verifyNativeTargets({
      resolveFrom: tree(contents),
      targets: [target],
    });
    expect(report.ok).toBe(false);
    const problem = report.missing[0]?.problem;
    expect(problem).toBeDefined();
    return problem ?? "";
  }

  it("refuses an MZ file whose PE offset is zero", () => {
    // A DOS stub with nothing after it. `e_lfanew` reads 0, the signature
    // check lands back on the `MZ`, and the old reader called that Windows
    // with an architecture it declined to name — which the architecture
    // test then skipped.
    expect(problemFor("win32-x64-msvc", dosStub({ lfanew: 0 }))).toMatch(
      /PE signature/i,
    );
  });

  it("refuses an MZ file whose PE offset points nowhere", () => {
    expect(
      problemFor("win32-x64-msvc", dosStub({ lfanew: 0x7fffffff })),
    ).toMatch(/PE header|past the/i);
  });

  it("refuses an MZ file that is just text", () => {
    const text = Buffer.from("MZ this is not a binary at all, it is prose.\n");
    expect(problemFor("win32-x64-msvc", text)).toMatch(/PE|short/i);
  });

  it("refuses a universal binary that carries only the other architecture", () => {
    // The ordinary shape of a lipo-thinned artifact, and precisely the
    // failure this check exists for: a real Mach-O, in the right package,
    // that an arm64 machine cannot load a byte of.
    expect(problemFor("darwin-arm64", fatMachO([MACH_X64]))).toMatch(/x64/);
  });

  it("accepts a universal binary that carries the architecture it needs", () => {
    const report = verifyNativeTargets({
      resolveFrom: tree({ "darwin-arm64": fatMachO([MACH_X64, MACH_ARM64]) }),
      targets: ["darwin-arm64"],
    });
    expect(report.ok).toBe(true);
  });

  it("refuses a Java class file, which begins with the same four bytes", () => {
    // `0xcafebabe` is the universal-binary magic and the Java class-file
    // magic. Reading the slice count is what tells them apart: a class file
    // declares a version number where a Mach-O declares a handful of
    // architectures.
    expect(problemFor("darwin-arm64", javaClass(52))).toMatch(
      /universal|architectures|class/i,
    );
  });

  it("refuses a universal binary declaring an absurd number of slices", () => {
    const header = Buffer.alloc(64);
    header.writeUInt32BE(0xcafebabe, 0);
    header.writeUInt32BE(100_000, 4);
    expect(problemFor("darwin-arm64", header)).toMatch(/architectures|slices/i);
  });

  it("refuses a Mach-O built for an architecture it does not know", () => {
    expect(problemFor("darwin-arm64", machO(0x0000_0012))).toMatch(
      /cputype|architecture/i,
    );
  });

  it("refuses an ELF built for the wrong machine", () => {
    expect(problemFor("linux-x64-gnu", elf(ELF_ARM64))).toMatch(/arm64/);
  });
});

/**
 * Files too short to hold the field the reader is about to read.
 *
 * `verifyNativeTargets` is the half of this API documented not to throw, and
 * every one of these used to come out of it as a `RangeError` from inside a
 * `.map` — naming no target, no path, and never reaching the message the
 * failure was written for.
 */
describe("binaries too short to read", () => {
  const truncated: [string, Buffer][] = [
    ["nothing at all", Buffer.alloc(0)],
    ["one byte", Buffer.from([0x4d])],
    ["a Mach-O magic and no more", Buffer.from([0xcf, 0xfa, 0xed, 0xfe])],
    ["an ELF magic and no more", Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
    [
      "an ELF header cut before e_machine",
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]),
    ],
    ["an MZ stub with no e_lfanew", Buffer.from("MZ\x90\x00\x03\x00\x00\x00")],
    [
      "a universal header with no slice table",
      Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]),
    ],
  ];

  for (const [what, binary] of truncated) {
    it(`refuses ${what} without throwing`, () => {
      const from = tree({ "darwin-arm64": binary });
      let report: NativeTargetReport | undefined;
      expect(() => {
        report = verifyNativeTargets({
          resolveFrom: from,
          targets: ["darwin-arm64"],
        });
      }).not.toThrow();
      expect(report?.ok).toBe(false);
      // The point of not throwing: the failure arrives as the message that
      // names the platform and says what to do about it.
      expect(report?.missing[0]?.target).toBe("darwin-arm64");
      expect(report?.missing[0]?.problem).toBeDefined();
    });
  }

  it("reaches the error the whole check is written for", () => {
    expect(() => {
      assertNativeTargets({
        resolveFrom: tree({ "darwin-arm64": Buffer.alloc(2) }),
        targets: ["darwin-arm64"],
      });
    }).toThrow(MissingNativeBinaryError);
  });
});
