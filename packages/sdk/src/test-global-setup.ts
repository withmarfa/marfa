/**
 * Vitest global setup for `@withmarfa/sdk`.
 *
 * One job: refuse to run when a workspace dependency's build is older than its
 * source. This package's fixtures build a whole in-process Marfa server out of
 * `@withmarfa/server`'s compiled `dist`, so a route changed in source and not
 * rebuilt is invisible here — the suite exercises the previous version and
 * passes or fails on it with nothing saying so. That is the worst shape of
 * false signal: confident, reproducible, and answering a question nobody asked.
 *
 * **`packages/server` has carried this check for a while and this package did
 * not**, so the same failure was still available here and was duly found: two
 * rounds of conclusions drawn from a permission gate changed in source and not
 * rebuilt, including a defect "found" in code that was already correct.
 *
 * A near-copy of `packages/server/src/test-global-setup.ts` rather than a
 * shared module, and deliberately. Each package sets `rootDir` to itself, so a
 * setup file inside `src/` cannot import one from outside the package, and
 * moving both files out of `src/` to reach a shared root module puts them
 * outside every tsconfig — where the linter has no types for `node:fs` and the
 * check stops being type-checked at all. A duplicated forty lines that both
 * compile beats one that neither does.
 *
 * A timestamp comparison rather than a content hash: it is cheap, it needs no
 * build-tool cooperation, and the failure it guards against is always "source
 * edited, build not re-run", which moves mtime. CI builds before it tests, so
 * this is silent there.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Workspace dependencies this package imports through a built `dist` rather
 * than from source. Each entry is a directory under `packages/`.
 *
 * `server` is the one this package has that the server's own list cannot: the
 * fixtures import `createApp` from it and stand a real server up in-process.
 */
const BUILT_DEPS = ["types", "shared", "server"] as const;

/** Newest mtime beneath `dir`, or 0 if it does not exist. */
function newestMtime(dir: string): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full));
    } else {
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        // Raced with a concurrent build or clean; skip it.
      }
    }
  }
  return newest;
}

export default function setup(): void {
  const packagesDir = join(import.meta.dirname, "..", "..");
  const stale: string[] = [];

  for (const dep of BUILT_DEPS) {
    const src = join(packagesDir, dep, "src");
    const dist = join(packagesDir, dep, "dist");
    if (!existsSync(src)) continue;

    const builtAt = newestMtime(dist);
    if (builtAt === 0) {
      stale.push(`@withmarfa/${dep} (never built)`);
      continue;
    }
    if (newestMtime(src) > builtAt) stale.push(`@withmarfa/${dep}`);
  }

  if (stale.length === 0) return;

  throw new Error(
    [
      "",
      "Refusing to run: these packages have source newer than their build,",
      "so the suite would test the previous version and report on it as",
      "though it were current.",
      "",
      ...stale.map((s) => `  - ${s}`),
      "",
      "Rebuild, then re-run:",
      "",
      "  pnpm build",
      "",
    ].join("\n"),
  );
}
