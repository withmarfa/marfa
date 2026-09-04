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

/**
 * The install tree holds no binding one of the named platforms could load.
 *
 * Named for what it measures. It reads `node_modules` on the machine running
 * it, so it reports on what a packager would find to copy — not on an
 * artifact, which nothing here opens.
 */
export class MissingNativeBinaryError extends Error {
  readonly missing: NativeTargetFinding[];
  constructor(missing: NativeTargetFinding[]) {
    super(
      `@withmarfa/sdk/electron: this machine's install has no loadable SQLite binding for ${String(missing.length)} of ${String(missing.length)} named targets.\n` +
        missing
          .map(
            (finding) =>
              `  ${finding.target}: ${finding.problem ?? "unknown"} (${finding.package})`,
          )
          .join("\n") +
        `\n\nDeclare the platform packages above as direct dependencies of the application, not as` +
        ` optional ones. An install resolves only the build host's, so an artifact cross-built for` +
        ` another platform carries no binary it can load — and nothing says so until a user opens a store.` +
        `\n\nThis reads the install tree, not an artifact. It says the bindings a packager could copy are` +
        ` present and are for the platforms they claim; whether a packager then copies them is that` +
        ` packager's configuration and is not observed here.`,
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

/** Mach-O magics, as the first four bytes read big-endian. */
const MACH_MAGIC_64 = 0xcffaedfe;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const ELF_MAGIC = 0x7f454c46;
const PE_SIGNATURE = 0x50450000;

/** Bytes per `fat_arch` entry, which the 64-bit universal header widens. */
const FAT_ENTRY_BYTES = 20;
const FAT_ENTRY_BYTES_64 = 32;

/**
 * How many slices a universal binary may declare and still be read.
 *
 * Not a limit anybody would hit: Apple ships two. It is a disambiguator.
 * `0xcafebabe` is also the Java class-file magic, and a class file puts its
 * version number where a Mach-O puts its slice count — the lowest version
 * Java has ever emitted is 45, so any bound below that separates them.
 */
const MAX_FAT_SLICES = 32;

interface ObjectKind {
  platform: NativeTarget["platform"];
  /**
   * Every architecture the file carries.
   *
   * A thin binary names one, a universal binary one per slice. Never empty:
   * a file whose architecture cannot be read is refused rather than
   * accepted, because "the format was recognized and the architecture was
   * not" is the state a lipo-thinned artifact arrives in — a real Mach-O, in
   * the right package, that the target machine cannot load a byte of.
   */
  arches: readonly NativeTarget["arch"][];
}

/** What a file is, or why it cannot be one. */
type Identification = { kind: ObjectKind } | { refused: string };

/**
 * What a file's first bytes say it is.
 *
 * Reading the header rather than trusting the path is the difference between
 * a check that catches the failure and one that reports on filenames. The
 * shape being guarded against is a build that puts a binary where another
 * platform's belongs: the file is present, it is a real object file, and the
 * target machine cannot load it.
 *
 * **Every read is bounded and every unknown is a refusal.** Both directions
 * were wrong before and both were silent. A short file threw a `RangeError`
 * out of the half of this API documented not to throw, naming no target and
 * reaching none of the message the failure exists to produce; and an
 * unrecognized architecture was treated as permission to skip the
 * architecture test, so an `MZ` with no PE header behind it and a universal
 * binary carrying only the other architecture both passed.
 */
function identify(header: Buffer): Identification {
  const size = header.length;
  const u32be = (at: number): number | undefined =>
    at >= 0 && at + 4 <= size ? header.readUInt32BE(at) : undefined;
  const u32le = (at: number): number | undefined =>
    at >= 0 && at + 4 <= size ? header.readUInt32LE(at) : undefined;
  const u16le = (at: number): number | undefined =>
    at >= 0 && at + 2 <= size ? header.readUInt16LE(at) : undefined;
  const u16be = (at: number): number | undefined =>
    at >= 0 && at + 2 <= size ? header.readUInt16BE(at) : undefined;
  const hex = (value: number): string => `0x${value.toString(16)}`;
  const tooShort = (field: string): Identification => ({
    refused: `is ${String(size)} bytes, too short to hold its ${field}`,
  });

  const magic = u32be(0);
  if (magic === undefined) return tooShort("magic number");

  // Mach-O, 64-bit, little-endian on disk. The 32-bit magic is absent
  // deliberately: no target here is 32-bit macOS, so one is a finding.
  if (magic === MACH_MAGIC_64) {
    const cputype = u32le(4);
    if (cputype === undefined) return tooShort("Mach-O cputype");
    const arch = MACH_CPU[cputype];
    if (arch === undefined) {
      return {
        refused: `is a Mach-O for cputype ${hex(cputype)}, which is not an architecture this check knows`,
      };
    }
    return { kind: { platform: "darwin", arches: [arch] } };
  }

  if (magic === FAT_MAGIC || magic === FAT_MAGIC_64) {
    const slices = u32be(4);
    if (slices === undefined) return tooShort("universal-binary slice count");
    if (slices === 0 || slices > MAX_FAT_SLICES) {
      return {
        refused:
          `begins like a universal binary and declares ${String(slices)} architectures, which no Mach-O does ` +
          `(0xcafebabe is also the Java class-file magic, and a class file puts its version number here)`,
      };
    }
    const stride =
      magic === FAT_MAGIC_64 ? FAT_ENTRY_BYTES_64 : FAT_ENTRY_BYTES;
    const arches: NativeTarget["arch"][] = [];
    for (let slice = 0; slice < slices; slice += 1) {
      const cputype = u32be(8 + slice * stride);
      if (cputype === undefined)
        return tooShort("universal-binary slice table");
      const arch = MACH_CPU[cputype];
      // Every slice has to be one this check knows. A single unrecognized
      // entry means the bytes are not the table they were read as, which is
      // how a file that merely starts with the same four bytes gets this far.
      if (arch === undefined) {
        return {
          refused: `declares a universal-binary slice for cputype ${hex(cputype)}, which is not an architecture this check knows`,
        };
      }
      arches.push(arch);
    }
    return { kind: { platform: "darwin", arches } };
  }

  if (magic === ELF_MAGIC) {
    const data = size > 5 ? header[5] : undefined;
    if (data === undefined) return tooShort("ELF data encoding");
    if (data !== 1 && data !== 2) {
      return {
        refused: `is an ELF declaring data encoding ${String(data)}, which is neither little- nor big-endian`,
      };
    }
    const machine = data === 1 ? u16le(18) : u16be(18);
    if (machine === undefined) return tooShort("ELF e_machine");
    const arch = ELF_MACHINE[machine];
    if (arch === undefined) {
      return {
        refused: `is an ELF for machine ${hex(machine)}, which is not an architecture this check knows`,
      };
    }
    return { kind: { platform: "linux", arches: [arch] } };
  }

  if (u16be(0) === 0x4d5a) {
    const at = u32le(0x3c);
    if (at === undefined) return tooShort("PE header offset");
    if (at + 6 > size) {
      return {
        refused: `starts with MZ and points its PE header at ${hex(at)}, past the ${String(size)} bytes read`,
      };
    }
    if (u32be(at) !== PE_SIGNATURE) {
      return {
        refused: `starts with MZ but carries no PE signature at ${hex(at)} — a DOS stub, or a file that merely begins the same way`,
      };
    }
    const machine = u16le(at + 4);
    if (machine === undefined) return tooShort("PE machine type");
    const arch = PE_MACHINE[machine];
    if (arch === undefined) {
      return {
        refused: `is a PE image for machine ${hex(machine)}, which is not an architecture this check knows`,
      };
    }
    return { kind: { platform: "win32", arches: [arch] } };
  }

  return { refused: "is not an object file this check recognizes" };
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

  let header: Buffer;
  try {
    header = readHeader(binary);
  } catch (error) {
    // A file that cannot be opened is a finding like any other. Left to
    // throw, it would come out of the half of this API documented not to,
    // from inside a `.map`, naming neither the target nor the path.
    finding.problem = `${binary} could not be read: ${error instanceof Error ? error.message : String(error)}`;
    return finding;
  }

  const identification = identify(header);
  if ("refused" in identification) {
    finding.problem = `${binary} ${identification.refused}`;
    return finding;
  }
  const { kind } = identification;
  if (kind.platform !== wanted.platform) {
    finding.problem = `${binary} is a ${kind.platform} binary, and ${target} needs a ${wanted.platform} one`;
    return finding;
  }
  if (!kind.arches.includes(wanted.arch)) {
    // A universal binary carries several and is sound as long as the one
    // needed is among them. It is unsound when it is not — which is the
    // ordinary shape of a lipo-thinned artifact, and reads as a healthy
    // install from the filename down.
    finding.problem = `${binary} carries ${kind.arches.join(", ")}, and ${target} needs ${wanted.arch}`;
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
