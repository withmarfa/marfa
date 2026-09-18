/**
 * The server's workspace dependencies must stay acyclic.
 *
 * A prod dependency on a workspace package that itself depends on the
 * server (`@withmarfa/sdk`, whose tests boot the server) closes a cycle.
 * pnpm installs it happily, and every warm local build passes because the
 * dependency's `dist` is already on disk — but the topological ordering
 * behind `pnpm --filter @withmarfa/server... build` stops guaranteeing the
 * server's own dependencies build first, and in a clean tree the server's
 * declaration pass then fails to resolve them. That is exactly how the
 * container image build broke while the full local matrix was green.
 *
 * This asserts the property directly, in the place a contributor adding a
 * dependency will see it, rather than waiting for a deploy to fail.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

interface PackageJson {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function readPackage(dir: string): PackageJson {
  return JSON.parse(
    readFileSync(join(repoRoot, dir, "package.json"), "utf8"),
  ) as PackageJson;
}

/** Workspace packages the server may reach, mapped to their directory. */
const WORKSPACE_DIRS: Record<string, string> = {
  "@withmarfa/shared": "packages/shared",
  "@withmarfa/types": "packages/types",
  "@withmarfa/sdk": "packages/sdk",
};

describe("server workspace dependencies", () => {
  it("never depend on a package that depends back on the server", () => {
    const server = readPackage("packages/server");
    const prodWorkspaceDeps = Object.entries(server.dependencies ?? {})
      .filter(([, spec]) => spec.startsWith("workspace:"))
      .map(([name]) => name);

    const cyclic = prodWorkspaceDeps.filter((name) => {
      const dir = WORKSPACE_DIRS[name];
      if (!dir) return false;
      const dep = readPackage(dir);
      return Boolean(
        dep.dependencies?.["@withmarfa/server"] ??
        dep.devDependencies?.["@withmarfa/server"],
      );
    });

    expect(
      cyclic,
      `these workspace packages depend back on the server, so depending on them ` +
        `from the server breaks clean-tree build ordering: ${cyclic.join(", ")}`,
    ).toEqual([]);
  });
});
