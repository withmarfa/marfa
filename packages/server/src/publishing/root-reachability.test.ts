/**
 * The reachability check's own tests, plus the one that holds the runtime
 * kit to it.
 *
 * Sits here rather than in the kit because the kit builds for the Workers
 * type environment and this needs the TypeScript compiler and the
 * filesystem. It runs in the ordinary suite, and therefore also inside the
 * publish workflow, which is the point: a symbol missing from the root is
 * only ever discovered by somebody reaching for it, and by then it is
 * published.
 */
import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkRootReachability,
  RUNTIME_SDK_ROOT_EXCLUSIONS,
} from "./root-reachability.js";
import { readPackageExportSurfaces } from "./read-module-exports.js";

const PACKAGES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const KIT_SRC = resolve(PACKAGES_DIR, "runtime-sdk/src");

describe("checkRootReachability", () => {
  it("is quiet when the root carries everything", () => {
    expect(checkRootReachability(["a", "b"], ["a", "b"], [])).toEqual({
      unreachable: [],
      staleExclusions: [],
    });
  });

  it("reports a symbol a module exports and the root does not", () => {
    expect(checkRootReachability(["a", "b"], ["a"], []).unreachable).toEqual([
      "b",
    ]);
  });

  it("accepts a symbol that is deliberately excluded", () => {
    const report = checkRootReachability(
      ["a", "b"],
      ["a"],
      [{ symbol: "b", reason: "why" }],
    );
    expect(report.unreachable).toEqual([]);
  });

  it("refuses an exclusion for a symbol that no longer exists", () => {
    // An enumeration nobody prunes is the thing this exists against, so it
    // must not be allowed to grow one of its own.
    const report = checkRootReachability(
      ["a"],
      ["a"],
      [{ symbol: "gone", reason: "why" }],
    );
    expect(report.staleExclusions).toEqual(["gone"]);
  });

  it("treats a rename as one of each", () => {
    const report = checkRootReachability(
      ["renamed"],
      [],
      [{ symbol: "original", reason: "why" }],
    );
    expect(report.unreachable).toEqual(["renamed"]);
    expect(report.staleExclusions).toEqual(["original"]);
  });
});

describe("the runtime kit's root", () => {
  const surfaces = readPackageExportSurfaces(KIT_SRC);

  it("reads both surfaces", () => {
    // An empty read would satisfy every assertion below, so the counts are
    // established before anything is compared.
    expect(surfaces.rootExports.length).toBeGreaterThan(0);
    expect(surfaces.moduleExports.length).toBeGreaterThan(0);
  });

  it("carries every symbol its modules export, bar the declared exclusions", () => {
    const report = checkRootReachability(
      surfaces.moduleExports,
      surfaces.rootExports,
      RUNTIME_SDK_ROOT_EXCLUSIONS,
    );
    expect(report.unreachable).toEqual([]);
  });

  it("declares no exclusion for a symbol that has gone", () => {
    const report = checkRootReachability(
      surfaces.moduleExports,
      surfaces.rootExports,
      RUNTIME_SDK_ROOT_EXCLUSIONS,
    );
    expect(report.staleExclusions).toEqual([]);
  });

  it("gives every exclusion a reason a person can read", () => {
    for (const e of RUNTIME_SDK_ROOT_EXCLUSIONS) {
      expect(e.reason.length, `${e.symbol} has no reason`).toBeGreaterThan(20);
    }
  });
});
