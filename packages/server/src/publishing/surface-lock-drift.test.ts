/**
 * The check that a regeneration cannot silence.
 *
 * `published-surface.test.ts` compares the lock against the tree, and
 * regenerating the lock makes them agree — which is also the remedy it
 * prints, so the one path that stays open through that guard is the one a
 * careful author walks down. These hold the other comparison: the committed
 * lock against the lock on the base being merged into, where regenerating is
 * the act that produces the violation rather than the act that clears it.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareSurfaceLocks,
  decideSurfaceLockDrift,
  describeSurfaceLockDrift,
  type SurfaceLock,
} from "./published-surface.js";

const entry = (
  version: string,
  hash: string,
  exports = 10,
): SurfaceLock[string] => ({ version, hash, exports });

describe("compareSurfaceLocks", () => {
  it("refuses a surface that moved under a standing version", () => {
    const drifts = compareSurfaceLocks(
      { "@withmarfa/sdk": entry("4.0.0", "aaa", 134) },
      { "@withmarfa/sdk": entry("4.0.0", "bbb", 134) },
    );
    expect(drifts).toEqual([
      {
        name: "@withmarfa/sdk",
        version: "4.0.0",
        from: "aaa",
        to: "bbb",
        fromExports: 134,
        toExports: 134,
      },
    ]);
  });

  it("is quiet when nothing moved at all", () => {
    // The ordinary case, and the one the other fixtures could not hold. With
    // (version same, hash moved), (both moved) and (version moved, hash same)
    // covered but not this, deleting the hash-equality guard left every test
    // green while the check reported every untouched package as drift on every
    // pull request — a guard that refuses everything is as useless as one that
    // refuses nothing, and louder.
    expect(
      compareSurfaceLocks(
        { "@withmarfa/sdk": entry("4.0.0", "aaa") },
        { "@withmarfa/sdk": entry("4.0.0", "aaa") },
      ),
    ).toEqual([]);
  });

  it("is quiet when the version moved with the surface", () => {
    expect(
      compareSurfaceLocks(
        { "@withmarfa/sdk": entry("4.0.0", "aaa") },
        { "@withmarfa/sdk": entry("5.0.0", "bbb") },
      ),
    ).toEqual([]);
  });

  it("is quiet when a version moved and the surface did not", () => {
    // A release carrying no surface change: a fix, a dependency bump, a
    // re-publish. There is nothing here for this check to have an opinion on.
    expect(
      compareSurfaceLocks(
        { "@withmarfa/sdk": entry("4.0.0", "aaa") },
        { "@withmarfa/sdk": entry("4.0.1", "aaa") },
      ),
    ).toEqual([]);
  });

  it("says nothing about a package added or removed by the change", () => {
    // Both are real violations and both belong to the tree-against-lock
    // comparison, which owns them already and reports them better. Restating
    // either here would make two rules free to drift, which is the failure
    // this repository records most often.
    expect(
      compareSurfaceLocks({}, { "@withmarfa/new": entry("1.0.0", "aaa") }),
    ).toEqual([]);
    expect(
      compareSurfaceLocks({ "@withmarfa/gone": entry("1.0.0", "aaa") }, {}),
    ).toEqual([]);
  });

  it("reports every drifted package, not the first", () => {
    const drifts = compareSurfaceLocks(
      {
        "@withmarfa/sdk": entry("4.0.0", "aaa"),
        "@withmarfa/shared": entry("6.0.0", "ccc"),
      },
      {
        "@withmarfa/sdk": entry("4.0.0", "bbb"),
        "@withmarfa/shared": entry("6.0.0", "ddd"),
      },
    );
    expect(drifts.map((d) => d.name)).toEqual([
      "@withmarfa/sdk",
      "@withmarfa/shared",
    ]);
  });
});

describe("describeSurfaceLockDrift", () => {
  it("names the re-export case, which is the one a diff does not explain", () => {
    // The change that motivates this check touches no file in the package it
    // breaks. Whoever reads the failure will be looking at a diff with
    // nothing in it that resembles the named package, so the message has to
    // supply the connection or it sends them looking in the wrong place.
    const message = describeSurfaceLockDrift({
      name: "@withmarfa/sdk",
      version: "4.0.0",
      from: "aaa",
      to: "bbb",
      fromExports: 134,
      toExports: 134,
    });
    expect(message).toContain("re-exports");
    expect(message).toContain("@withmarfa/sdk@4.0.0");
    expect(message).toContain("Still 134 exported names");
    // And it must not send the reader to the remedy that produced the
    // violation, which is the remedy every other message in this area prints.
    expect(message).toContain("Regenerating the lock again will not clear");
  });

  it("gives the counts when they moved", () => {
    const message = describeSurfaceLockDrift({
      name: "@withmarfa/shared",
      version: "6.0.0",
      from: "aaa",
      to: "bbb",
      fromExports: 200,
      toExports: 198,
    });
    expect(message).toContain("198 exported names now, 200 on the base");
  });
});

describe("the drift script", () => {
  const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

  function runDrift(args: string[]): { status: number; stderr: string } {
    try {
      execFileSync("pnpm", ["--silent", "run", "surface-lock:drift", ...args], {
        cwd: SERVER_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, stderr: "" };
    } catch (err) {
      const e = err as { status?: number; stderr?: string };
      return { status: e.status ?? -1, stderr: e.stderr ?? "" };
    }
  }

  it("exits non-zero when it cannot read its baseline", () => {
    // The property this file exists to hold, more than any comparison above.
    // A guard that cannot see its baseline knows nothing, and reporting that
    // as agreement is how a check turns itself off with a green tick and no
    // output. A shallow clone is the ordinary way to arrive here.
    const { status, stderr } = runDrift(["refs/heads/no-such-ref-here"]);
    expect(status).not.toBe(0);
    expect(stderr).toContain("no baseline to compare against");
    expect(stderr).toContain("fetch-depth");
  });

  it("refuses to run with no baseline named at all", () => {
    const { status, stderr } = runDrift([]);
    expect(status).not.toBe(0);
    expect(stderr).toContain("nothing to compare against");
  });
});

describe("the decision the check acts on", () => {
  // Everything above tests the comparison; the two script cases below exit
  // before they reach it. So until this block existed, `process.exit(1)`
  // changed to `process.exit(0)` on the refusal path passed the whole suite,
  // and so did replacing the comparison with `compareSurfaceLocks(head, head)`.
  // The guard could be switched off inside the file that is the guard.
  it("refuses, and names the package and the version it stood at", () => {
    const verdict = decideSurfaceLockDrift(
      { "@withmarfa/sdk": entry("4.0.0", "aaa", 134) },
      { "@withmarfa/sdk": entry("4.0.0", "bbb", 134) },
      "abc1234",
    );
    expect(
      verdict.code,
      "a surface that moved under a standing version did not produce a failing exit status, so the check would pass through the one thing it exists to refuse",
    ).toBe(1);
    expect(verdict.report).toContain("@withmarfa/sdk");
    expect(verdict.report).toContain("4.0.0");
  });

  it("passes when no surface moved, and says what it looked at", () => {
    const clean = {
      "@withmarfa/sdk": entry("4.0.0", "aaa"),
      "@withmarfa/shared": entry("6.16.0", "ccc"),
    };
    const verdict = decideSurfaceLockDrift(clean, clean, "abc1234");
    expect(verdict.code).toBe(0);
    // The count and the base ref, because a check that prints only "ok" is one
    // nobody can tell apart from a check that compared nothing.
    expect(verdict.report).toContain("2 packages");
    expect(verdict.report).toContain("abc1234");
  });

  it("counts every drifted package rather than stopping at the first", () => {
    const verdict = decideSurfaceLockDrift(
      {
        "@withmarfa/sdk": entry("4.0.0", "aaa"),
        "@withmarfa/shared": entry("6.16.0", "ccc"),
      },
      {
        "@withmarfa/sdk": entry("4.0.0", "bbb"),
        "@withmarfa/shared": entry("6.16.0", "ddd"),
      },
      "abc1234",
    );
    expect(verdict.code).toBe(1);
    expect(verdict.report).toContain("2 packages");
    expect(verdict.report).toContain("@withmarfa/sdk");
    expect(verdict.report).toContain("@withmarfa/shared");
  });
});
