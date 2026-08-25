/**
 * The published surface lock's own tests, plus the check that gates a merge.
 *
 * The gating test lives here, in the ordinary suite, rather than in a
 * generated-artifact freshness workflow, for the same reason the manifest
 * lock's does: those workflows are excluded from pull-request events, so
 * the only pre-merge guard is a manual dispatch somebody has to remember to
 * read. A plain test cannot be merged past — and this one additionally runs
 * inside the publish workflow, which executes the suite before it packs
 * anything, so a surface that moved under a standing version cannot reach
 * npm either.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSurfaceLock,
  compareToSurfaceLock,
  blockingViolations,
  describeSurfaceViolation,
  hashExportNames,
  type PackageSurface,
  type SurfaceLock,
} from "./published-surface.js";
import { readPublishedSurfaces } from "./read-surfaces.js";

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGES_DIR = resolve(SERVER_ROOT, "..");
const LOCK_PATH = resolve(SERVER_ROOT, "published-surface-lock.json");

function surface(over: Partial<PackageSurface> = {}): PackageSurface {
  return {
    name: "@withmarfa/example",
    version: "1.0.0",
    exportNames: ["alpha", "beta"],
    ...over,
  };
}

describe("hashExportNames", () => {
  it("depends on the set of names, not their order", () => {
    expect(hashExportNames(["b", "a"])).toBe(hashExportNames(["a", "b"]));
  });

  it("moves when a name is removed", () => {
    expect(hashExportNames(["a", "b"])).not.toBe(hashExportNames(["a"]));
  });

  it("moves when a name is added", () => {
    expect(hashExportNames(["a"])).not.toBe(hashExportNames(["a", "b"]));
  });
});

describe("compareToSurfaceLock", () => {
  it("is quiet when the tree matches the lock", () => {
    const s = [surface()];
    expect(compareToSurfaceLock(s, buildSurfaceLock(s))).toEqual([]);
  });

  it("refuses a surface that moved under a standing version", () => {
    // The defect this whole file exists for: shared published at 4.0.0,
    // then lost exports with the version left alone.
    const locked = buildSurfaceLock([surface()]);
    const now = [surface({ exportNames: ["alpha"] })];

    const violations = compareToSurfaceLock(now, locked);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      kind: "surface-moved",
      name: "@withmarfa/example",
      version: "1.0.0",
      lockedExports: 2,
      currentExports: 1,
    });
    expect(blockingViolations(violations)).toHaveLength(1);
  });

  it("permits a version that moves with the surface", () => {
    const locked = buildSurfaceLock([surface()]);
    const now = [surface({ version: "2.0.0", exportNames: ["alpha"] })];

    // Reported so the generator gets run, but not a thing that blocks a
    // merge: moving the version is the correct response to a surface
    // change and refusing it would refuse the fix.
    expect(blockingViolations(compareToSurfaceLock(now, locked))).toEqual([]);
  });

  it("permits a version that moves with no surface change", () => {
    // A patch release for a fixed implementation is legitimate.
    const locked = buildSurfaceLock([surface()]);
    const now = [surface({ version: "1.0.1" })];
    expect(blockingViolations(compareToSurfaceLock(now, locked))).toEqual([]);
  });

  it("refuses a publishable package the lock has never seen", () => {
    const violations = compareToSurfaceLock([surface()], {});
    expect(violations[0]).toMatchObject({ kind: "unlocked" });
    expect(blockingViolations(violations)).toHaveLength(1);
  });

  it("refuses a locked package that has gone", () => {
    const locked = buildSurfaceLock([surface()]);
    const violations = compareToSurfaceLock([], locked);
    expect(violations[0]).toMatchObject({ kind: "removed" });
    expect(blockingViolations(violations)).toHaveLength(1);
  });

  it("names the package and both counts when a surface moves", () => {
    const locked = buildSurfaceLock([surface()]);
    const now = [surface({ exportNames: ["alpha"] })];
    const text = describeSurfaceViolation(
      compareToSurfaceLock(now, locked)[0]!,
    );
    expect(text).toContain("@withmarfa/example");
    expect(text).toContain("1.0.0");
    expect(text).toContain("Removing an export is a major");
  });
});

describe("the tree against the committed lock", () => {
  const surfaces = readPublishedSurfaces(PACKAGES_DIR);
  const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as SurfaceLock;

  it("reads a surface for every publishable package", () => {
    // An empty read hashes consistently and would pass forever, so the
    // count is asserted before anything is compared.
    expect(surfaces.length).toBeGreaterThan(0);
    for (const s of surfaces) {
      expect(s.exportNames.length, `${s.name} exports nothing`).toBeGreaterThan(
        0,
      );
    }
  });

  it("locks every publishable package and nothing else", () => {
    expect(Object.keys(lock).sort()).toEqual(
      surfaces.map((s) => s.name).sort(),
    );
  });

  it("no package's surface has moved under a standing version", () => {
    const blocking = blockingViolations(compareToSurfaceLock(surfaces, lock));
    expect(blocking.map(describeSurfaceViolation)).toEqual([]);
  });
});
