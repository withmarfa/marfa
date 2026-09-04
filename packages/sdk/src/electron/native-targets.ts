import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
} from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Whether a desktop artifact carries a SQLite binding the machine it was
 * built for can load.
 *
 * The engine's SQLite binding ships its native code as nine platform
 * packages, declared as optional dependencies of `libsql`. An install
 * resolves the build host's and skips the other eight, which is right for a
 * server — it runs where it was installed — and wrong for a desktop
 * application, which is built on one machine and run on others. Build on an
 * Apple Silicon Mac and the Windows artifact contains a macOS binary, or
 * nothing at all.
 *
 * **Nothing about that is an error at build time.** The build succeeds, the
 * installer is signed, and the first report is a module-not-found at the
 * first store open on a user's machine, on a code path with no visible
 * relationship to a missing file. So an application declares the platform
 * packages it ships for as direct dependencies — all of them install
 * whatever the host — and runs this check as part of its build, which fails
 * naming any target whose binary is absent.
 *
 * The other two routes were considered. Building each platform on its own
 * machine is a packaging decision nobody here has taken. Fetching the right
 * package per target while packaging is the most delicate of the three: it
 * puts a network request inside the step that produces the artifact and
 * moves the failure to a place with even less to say about it. The cost of
 * the route taken is install weight, about eight megabytes per target, which
 * is the honest trade.
 */

/** The targets libsql publishes a prebuilt binding for. */
export type LibsqlTarget =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm-gnueabihf"
  | "linux-arm-musleabihf"
  | "linux-arm64-gnu"
  | "linux-arm64-musl"
  | "linux-x64-gnu"
  | "linux-x64-musl"
  | "win32-x64-msvc";

export interface NativeTarget {
  /** The npm package holding the prebuilt binding. */
  package: string;
  /** What `process.platform` reads on a machine of this kind. */
  platform: "darwin" | "linux" | "win32";
  /** What `process.arch` reads. */
  arch: "arm" | "arm64" | "x64";
}

/**
 * The nine, as `libsql` itself names them.
 *
 * `native-targets.test.ts` holds this to `libsql`'s own
 * `optionalDependencies` rather than to a reading of them, so a target added
 * or renamed upstream fails here instead of quietly becoming a platform
 * nobody ships a binary for.
 */
export const LIBSQL_NATIVE_TARGETS: Record<LibsqlTarget, NativeTarget> = {
  "darwin-arm64": {
    package: "@libsql/darwin-arm64",
    platform: "darwin",
    arch: "arm64",
  },
  "darwin-x64": {
    package: "@libsql/darwin-x64",
    platform: "darwin",
    arch: "x64",
  },
  "linux-arm-gnueabihf": {
    package: "@libsql/linux-arm-gnueabihf",
    platform: "linux",
    arch: "arm",
  },
  "linux-arm-musleabihf": {
    package: "@libsql/linux-arm-musleabihf",
    platform: "linux",
    arch: "arm",
  },
  "linux-arm64-gnu": {
    package: "@libsql/linux-arm64-gnu",
    platform: "linux",
    arch: "arm64",
  },
  "linux-arm64-musl": {
    package: "@libsql/linux-arm64-musl",
    platform: "linux",
    arch: "arm64",
  },
  "linux-x64-gnu": {
    package: "@libsql/linux-x64-gnu",
    platform: "linux",
    arch: "x64",
  },
  "linux-x64-musl": {
    package: "@libsql/linux-x64-musl",
    platform: "linux",
    arch: "x64",
  },
  "win32-x64-msvc": {
    package: "@libsql/win32-x64-msvc",
    platform: "win32",
    arch: "x64",
  },
};

export interface VerifyNativeTargetsOptions {
  /**
   * A file path or module URL to look for the platform packages from —
   * usually `import.meta.url` of the script running the check, so the search
   * starts at the application that declared them. Its directory is where the
   * `node_modules` walk begins.
   */
  resolveFrom: string;
  /** The platforms this artifact is built to run on. */
  targets: readonly LibsqlTarget[];
}

export interface NativeTargetFinding {
  target: LibsqlTarget;
  package: string;
  /** The binary that was examined, when one was found. */
  path: string | undefined;
  /** What is wrong, in a sentence, or undefined when nothing is. */
  problem: string | undefined;
}

export interface NativeTargetReport {
  ok: boolean;
  /** Every target that would fail on the machine it was built for. */
  missing: NativeTargetFinding[];
  /** Every target, whether or not it is sound. */
  findings: NativeTargetFinding[];
}

/** The build produced an artifact a target platform cannot load. */
export class MissingNativeBinaryError extends Error {
  readonly missing: NativeTargetFinding[];
  constructor(missing: NativeTargetFinding[]) {
    super(
      `@withmarfa/sdk/electron: this build ships no loadable SQLite binding for ${String(missing.length)} of its targets.\n` +
        missing
          .map(
            (finding) =>
              `  ${finding.target}: ${finding.problem ?? "unknown"} (${finding.package})`,
          )
          .join("\n") +
        `\n\nDeclare the platform packages above as direct dependencies of the application, not as` +
        ` optional ones. An install resolves only the build host's, so an artifact cross-built for` +
        ` another platform carries no binary it can load — and nothing says so until a user opens a store.`,
    );
    this.name = "MissingNativeBinaryError";
    this.missing = missing;
  }
}

/** Mach-O CPU types, as the header records them. */
const MACH_CPU: Record<number, NativeTarget["arch"]> = {
  0x01000007: "x64",
  0x0100000c: "arm64",
};

/** ELF `e_machine` values. */
const ELF_MACHINE: Record<number, NativeTarget["arch"]> = {
  0x28: "arm",
  0x3e: "x64",
  0xb7: "arm64",
};

/** PE COFF machine types. */
const PE_MACHINE: Record<number, NativeTarget["arch"]> = {
  0x01c4: "arm",
  0x8664: "x64",
  0xaa64: "arm64",
};

interface ObjectKind {
  platform: NativeTarget["platform"];
  /** Undefined when the format was recognized and the architecture was not. */
  arch: NativeTarget["arch"] | undefined;
}

/**
 * What a file's first bytes say it is.
 *
 * Reading the header rather than trusting the path is the difference between
 * a check that catches the failure and one that reports on filenames. The
 * shape being guarded against is a build that puts the host's binary where
 * another platform's belongs: the file is present, it is a real object file,
 * and the target machine cannot load a byte of it.
 */
function identify(header: Buffer): ObjectKind | undefined {
  if (header.length < 4) return undefined;
  const magic = header.readUInt32BE(0);

  // Mach-O, 64-bit, little-endian on disk. The 32-bit magic is not listed:
  // no target here is 32-bit macOS, so meeting one is a finding rather than
  // something to accept.
  if (magic === 0xcffaedfe) {
    return { platform: "darwin", arch: MACH_CPU[header.readUInt32LE(4)] };
  }
  // A universal binary carries several architectures and names none of them
  // in its first word. The platform is still settled, which is the half that
  // catches the cross-build mistake.
  if (magic === 0xcafebabe || magic === 0xbebafeca) {
    return { platform: "darwin", arch: undefined };
  }
  if (magic === 0x7f454c46) {
    return { platform: "linux", arch: ELF_MACHINE[header.readUInt16LE(18)] };
  }
  if (header.readUInt16BE(0) === 0x4d5a) {
    const offset = header.readUInt32LE(0x3c);
    if (offset + 6 > header.length)
      return { platform: "win32", arch: undefined };
    if (header.readUInt32BE(offset) !== 0x50450000) {
      return { platform: "win32", arch: undefined };
    }
    return {
      platform: "win32",
      arch: PE_MACHINE[header.readUInt16LE(offset + 4)],
    };
  }
  return undefined;
}

/** How much of a binary has to be read. Enough for a PE header at any
 *  plausible `e_lfanew`, which is the furthest of the three formats. */
const HEADER_BYTES = 1024;

function readHeader(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const read = readSync(fd, buffer, 0, HEADER_BYTES, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * The binding inside a platform package.
 *
 * `main` first, because that is what the package says; a scan for a `.node`
 * file second, so a package that stops naming its binary in `main` is found
 * rather than reported missing.
 */
function findBinary(packageDirectory: string): string | undefined {
  try {
    const manifest = JSON.parse(
      readFileSync(join(packageDirectory, "package.json"), "utf8"),
    ) as { main?: string };
    if (manifest.main?.endsWith(".node") === true) {
      const candidate = join(packageDirectory, manifest.main);
      readHeader(candidate);
      return candidate;
    }
  } catch {
    // Falls through to the scan. A manifest that will not parse, or a `main`
    // pointing at nothing, is the same question as a package with no binary.
  }
  try {
    const found = readdirSync(packageDirectory).find((name) =>
      name.endsWith(".node"),
    );
    return found === undefined ? undefined : join(packageDirectory, found);
  } catch {
    return undefined;
  }
}

/**
 * Where a package lives, by walking `node_modules` up from a directory.
 *
 * Node's own algorithm for the part that matters, written out rather than
 * delegated to `require.resolve`. **`createRequire` is not reliably Node's
 * resolver**: run under `tsx` it answers from a broader search, so a package
 * the application does not actually depend on resolves anyway — and this
 * check reported five sound platforms with one of them uninstalled, which is
 * the exact failure it exists to catch, passing. Vitest patches it in the
 * same direction. A walk cannot be patched and answers the same everywhere.
 *
 * Symlinks are followed by `existsSync`, which is what makes this work on a
 * pnpm tree: the entry in a package's `node_modules` is a link into the
 * store, and following it is the point rather than an accident.
 */
function resolvePackageDirectory(
  from: string,
  packageName: string,
): string | undefined {
  let directory = from;
  const { root } = parse(directory);
  for (;;) {
    const candidate = join(directory, "node_modules", packageName);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (directory === root) return undefined;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** A module URL or a file path, as the directory to start walking from. */
function startingDirectory(resolveFrom: string): string {
  const path = resolveFrom.startsWith("file:")
    ? fileURLToPath(resolveFrom)
    : resolveFrom;
  return dirname(path);
}

function inspect(target: LibsqlTarget, from: string): NativeTargetFinding {
  const wanted = LIBSQL_NATIVE_TARGETS[target];
  const finding: NativeTargetFinding = {
    target,
    package: wanted.package,
    path: undefined,
    problem: undefined,
  };

  const packageDirectory = resolvePackageDirectory(from, wanted.package);
  if (packageDirectory === undefined) {
    finding.problem = `${wanted.package} is not installed — an install resolves only the build host's platform package, so this one was skipped`;
    return finding;
  }

  const binary = findBinary(packageDirectory);
  if (binary === undefined) {
    finding.problem = `${wanted.package} is installed but holds no .node binary`;
    return finding;
  }
  finding.path = binary;

  const kind = identify(readHeader(binary));
  if (kind === undefined) {
    finding.problem = `${binary} is not an object file this check recognizes`;
    return finding;
  }
  if (kind.platform !== wanted.platform) {
    finding.problem = `${binary} is a ${kind.platform} binary, and ${target} needs a ${wanted.platform} one`;
    return finding;
  }
  // An architecture the format did not name is not a finding: a universal
  // binary genuinely holds several, and refusing one would fail a build that
  // is correct.
  if (kind.arch !== undefined && kind.arch !== wanted.arch) {
    finding.problem = `${binary} is built for ${kind.arch}, and ${target} needs ${wanted.arch}`;
    return finding;
  }
  return finding;
}

/** Report on every target, sound or not. */
export function verifyNativeTargets(
  options: VerifyNativeTargetsOptions,
): NativeTargetReport {
  const from = startingDirectory(options.resolveFrom);
  const findings = options.targets.map((target) => inspect(target, from));
  const missing = findings.filter((finding) => finding.problem !== undefined);
  return { ok: missing.length === 0, missing, findings };
}

/**
 * Fail the build, naming every target that would not load.
 *
 * Throws rather than returning, because the whole point is that this sits in
 * the path that produces the artifact. A check whose result somebody has to
 * remember to read is the arrangement this replaces.
 */
export function assertNativeTargets(options: VerifyNativeTargetsOptions): void {
  const report = verifyNativeTargets(options);
  if (!report.ok) throw new MissingNativeBinaryError(report.missing);
}
