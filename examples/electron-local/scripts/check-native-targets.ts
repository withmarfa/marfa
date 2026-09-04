import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LIBSQL_NATIVE_TARGETS,
  assertNativeTargets,
} from "@withmarfa/sdk/electron";
import type { LibsqlTarget } from "@withmarfa/sdk/electron";

/**
 * Fail the build if this application would ship an artifact a target platform
 * cannot open a store with.
 *
 * The engine's SQLite binding arrives as nine platform packages, declared as
 * optional dependencies of `libsql`. An install resolves the build host's and
 * skips the rest, which is right for a server and wrong for a desktop
 * application: built on an Apple Silicon Mac, the Windows artifact carries a
 * macOS binary or none at all. **The build succeeds either way.** The failure
 * arrives as a module-not-found at the first store open on somebody else's
 * machine, on a code path that has nothing to do with a missing file.
 *
 * So this application declares the platform packages it ships for as direct
 * dependencies — all of them install whatever the host — and this script says
 * so is still true. It runs from `build`, not from a separate command
 * somebody has to remember, because the arrangement it replaces was exactly a
 * thing somebody had to remember.
 *
 * The cost is install weight, about eight megabytes per target. That is the
 * honest trade, and it is cheaper than the two alternatives: building each
 * platform on its own machine is a packaging decision this repository has not
 * taken, and fetching the right package per target during packaging puts a
 * network request inside the step that produces the artifact.
 */

/**
 * The platforms this application ships for.
 *
 * Five rather than nine. Electron's own desktop builds are macOS on both
 * architectures, Windows on x64, and Linux on x64 and arm64 against glibc —
 * so the two musl variants and the two 32-bit ARM ones have no Electron to
 * run under. Windows on arm64 is the gap in the other direction: Electron
 * builds for it and libsql publishes no binding, which is a platform this
 * application cannot ship rather than one it forgot.
 */
const SHIPPED: readonly LibsqlTarget[] = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "win32-x64-msvc",
];

const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  dependencies?: Record<string, string>;
};

const knownPackages = new Map(
  Object.entries(LIBSQL_NATIVE_TARGETS).map(([target, entry]) => [
    entry.package,
    target as LibsqlTarget,
  ]),
);

/**
 * What the manifest actually declares, as targets.
 *
 * Checked against {@link SHIPPED} in both directions, because either half
 * going missing on its own is silent. Drop the dependency and the check would
 * narrow to what is left and pass; add one without listing it here and it
 * would ship unverified. A platform genuinely leaving is then a two-line diff
 * rather than a one-line one, which is the point.
 */
const declared = Object.keys(manifest.dependencies ?? {})
  .map((name) => knownPackages.get(name))
  .filter((target): target is LibsqlTarget => target !== undefined)
  .sort();

const shipped = [...SHIPPED].sort();
const undeclared = shipped.filter((target) => !declared.includes(target));
const unlisted = declared.filter((target) => !shipped.includes(target));

if (undeclared.length > 0 || unlisted.length > 0) {
  const lines = [
    "This application's shipped platforms and its declared dependencies disagree.",
  ];
  if (undeclared.length > 0) {
    lines.push(
      `  shipped but not declared: ${undeclared.join(", ")} — add ${undeclared
        .map((target) => LIBSQL_NATIVE_TARGETS[target].package)
        .join(", ")} to dependencies`,
    );
  }
  if (unlisted.length > 0) {
    lines.push(
      `  declared but not shipped: ${unlisted.join(", ")} — add it to SHIPPED, or drop the dependency`,
    );
  }
  console.error(lines.join("\n"));
  process.exit(1);
}

// Names every platform whose binary is absent or is for something else. The
// message is printed rather than the stack: what a person needs at this point
// is which platform and what to do, and a trace through a check they did not
// write is neither.
try {
  assertNativeTargets({ resolveFrom: import.meta.url, targets: SHIPPED });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

console.log(`Native SQLite bindings present for: ${shipped.join(", ")}`);
