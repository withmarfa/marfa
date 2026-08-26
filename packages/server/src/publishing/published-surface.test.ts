/**
 * The published surface lock's own tests, plus the check that gates a merge.
 *
 * The gating test lives here, in the ordinary suite, rather than in a
 * generated-artifact freshness workflow, for the same reason the manifest
 * lock's does: those workflows are excluded from pull-request events, so
 * the only pre-merge guard is a manual dispatch somebody has to remember to
 * read. A plain test cannot be merged past, and the publish workflow will
 * not pack anything without a green run of this suite on the same commit,
 * so a surface that moved under a stale lock cannot reach npm either.
 *
 * Every case that asks whether something is REFUSED asserts on
 * `blockingViolations`, never on the raw list. This guard was reachable,
 * tested and green for its whole life while blocking nothing, because its
 * tests asked whether a violation was recorded and the build asked whether
 * one was blocking. Those are different questions and only the second one
 * stops anything. The cases that read a message are the exception, and
 * they assert on text rather than on refusal.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSurfaceLock,
  compareToSurfaceLock,
  blockingViolations,
  describeSurfaceViolation,
  hashSurface,
  type PackageSurface,
  type SurfaceLock,
} from "./published-surface.js";
import { readPublishedSurfaces } from "./read-surfaces.js";

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGES_DIR = resolve(SERVER_ROOT, "..");
const LOCK_PATH = resolve(SERVER_ROOT, "published-surface-lock.json");

const ALPHA = { name: "alpha", declaration: "type alpha = 1 | 2;" };
const BETA = { name: "beta", declaration: "declare function beta(): void;" };
/** `alpha`, same name, one more member in the union. */
const ALPHA_WIDENED = { name: "alpha", declaration: "type alpha = 1 | 2 | 3;" };

function surface(over: Partial<PackageSurface> = {}): PackageSurface {
  return {
    name: "@withmarfa/example",
    version: "1.0.0",
    exports: [ALPHA, BETA],
    ...over,
  };
}

describe("hashSurface", () => {
  it("depends on the set of exports, not their order", () => {
    expect(hashSurface([BETA, ALPHA])).toBe(hashSurface([ALPHA, BETA]));
  });

  it("moves when a name is removed", () => {
    expect(hashSurface([ALPHA, BETA])).not.toBe(hashSurface([ALPHA]));
  });

  it("moves when a name is added", () => {
    expect(hashSurface([ALPHA])).not.toBe(hashSurface([ALPHA, BETA]));
  });

  it("moves when an existing name changes shape", () => {
    // A widened union is the case that moves no name at all, and it is
    // what a hash over names alone could never see.
    expect(hashSurface([ALPHA])).not.toBe(hashSurface([ALPHA_WIDENED]));
  });

  it("orders by code unit rather than by the host collation", () => {
    // These two names sort in opposite orders under code-unit and locale
    // comparison. The lock is written on one machine and verified on
    // another, so a digest that read collation tables would disagree
    // across a Node upgrade and report every package as changed on a day
    // none of them were. The digest is pinned rather than recomputed,
    // because recomputing it here would restate the implementation and
    // agree with it however it sorted.
    const under = { name: "_internal", declaration: "type _internal = 1;" };
    const over = { name: "Alpha", declaration: "type Alpha = 2;" };
    expect(hashSurface([under, over])).toBe(
      "bc91eee452d840adea6a182acd00b49d86b68ed5c437d20c14713c795dd3377e",
    );
  });
});

describe("compareToSurfaceLock", () => {
  it("is quiet when the tree matches the lock", () => {
    const s = [surface()];
    // Both, and neither is redundant. The second says nothing was recorded
    // at all; the first says nothing would block a build. A guard that
    // records a violation it never blocks on is exactly how this one came
    // to be inert, so the blocking set is asserted in its own right rather
    // than inferred from the full list being empty.
    expect(
      blockingViolations(compareToSurfaceLock(s, buildSurfaceLock(s))),
    ).toEqual([]);
    expect(compareToSurfaceLock(s, buildSurfaceLock(s))).toEqual([]);
  });

  it("blocks a surface that moved under a standing version", () => {
    // The defect this whole file exists for: shared published at 4.0.0,
    // then lost exports with the version left alone.
    const locked = buildSurfaceLock([surface()]);
    const now = [surface({ exports: [ALPHA] })];

    const blocking = blockingViolations(compareToSurfaceLock(now, locked));

    expect(blocking).toHaveLength(1);
    expect(blocking[0]).toMatchObject({
      kind: "surface-moved",
      name: "@withmarfa/example",
      lockedVersion: "1.0.0",
      version: "1.0.0",
      lockedExports: 2,
      currentExports: 1,
    });
  });

  it("blocks a surface that moved under a version that moved too", () => {
    // Bumping the version used to be the bypass: the comparison read the
    // version first and returned before the hash was ever looked at, so
    // the one change most likely to move a surface switched the check off.
    const locked = buildSurfaceLock([surface()]);
    const now = [surface({ version: "2.0.0", exports: [ALPHA] })];

    const blocking = blockingViolations(compareToSurfaceLock(now, locked));

    expect(blocking).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "surface-moved", version: "2.0.0" }),
      ]),
    );
  });

  it("blocks a shape change to an already-exported name", () => {
    // No name added, none removed, and the count is identical.
    const locked = buildSurfaceLock([surface()]);
    const now = [surface({ exports: [ALPHA_WIDENED, BETA] })];

    const blocking = blockingViolations(compareToSurfaceLock(now, locked));

    expect(blocking).toHaveLength(1);
    expect(blocking[0]).toMatchObject({
      kind: "surface-moved",
      lockedExports: 2,
      currentExports: 2,
    });
  });

  it("is quiet when a version moves with the lock regenerated for it", () => {
    // The normal, correct flow, and the one that has to stay silent:
    // move the version, regenerate, commit both.
    const now = [surface({ version: "2.0.0", exports: [ALPHA] })];
    const regenerated = buildSurfaceLock(now);
    expect(blockingViolations(compareToSurfaceLock(now, regenerated))).toEqual(
      [],
    );
  });

  it("blocks a version that moved and left the lock behind", () => {
    // The surface is untouched, so nothing here is unsafe yet. It is
    // refused because the recorded hash now describes a version nothing
    // builds, which makes the next comparison meaningless rather than
    // merely stale.
    const locked = buildSurfaceLock([surface()]);
    const now = [surface({ version: "1.0.1" })];

    const blocking = blockingViolations(compareToSurfaceLock(now, locked));

    expect(blocking).toHaveLength(1);
    expect(blocking[0]).toMatchObject({
      kind: "version-moved",
      from: "1.0.0",
      to: "1.0.1",
    });
  });

  it("blocks both when a surface and its version moved together", () => {
    const locked = buildSurfaceLock([surface()]);
    const now = [surface({ version: "2.0.0", exports: [ALPHA] })];
    expect(
      blockingViolations(compareToSurfaceLock(now, locked)).map((v) => v.kind),
    ).toEqual(["surface-moved", "version-moved"]);
  });

  it("blocks a publishable package the lock has never seen", () => {
    const blocking = blockingViolations(compareToSurfaceLock([surface()], {}));
    expect(blocking).toHaveLength(1);
    expect(blocking[0]).toMatchObject({ kind: "unlocked" });
  });

  it("blocks a locked package that has gone", () => {
    const locked = buildSurfaceLock([surface()]);
    const blocking = blockingViolations(compareToSurfaceLock([], locked));
    expect(blocking).toHaveLength(1);
    expect(blocking[0]).toMatchObject({ kind: "removed" });
  });
});

describe("describeSurfaceViolation", () => {
  it("names the package and both counts when a name is lost", () => {
    const locked = buildSurfaceLock([surface()]);
    const now = [surface({ exports: [ALPHA] })];
    const text = describeSurfaceViolation(
      compareToSurfaceLock(now, locked)[0]!,
    );
    expect(text).toContain("@withmarfa/example");
    expect(text).toContain("1.0.0");
    expect(text).toContain("Removing an export is a major");
  });

  it("does not claim the names held when only the count did", () => {
    // A rename keeps the count and is a removal plus an addition, so a
    // message promising the names are the same would send the reader
    // hunting for a widened union that is not there.
    const locked = buildSurfaceLock([surface()]);
    const renamed = [surface({ exports: [{ ...ALPHA, name: "gamma" }, BETA] })];
    const text = describeSurfaceViolation(
      compareToSurfaceLock(renamed, locked)[0]!,
    );
    expect(text).toContain("Still 2 exported names");
    expect(text).toContain("a name was swapped");
  });
});

describe("readPublishedSurfaces", () => {
  const roots: string[] = [];

  afterEach(() => {
    // A test that abandons a directory per run is a defect in the test.
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  const HELPER = "export interface Helper { a: string; }\n";
  const INDEX = [
    'import { Helper } from "./helper.js";',
    "export interface Thing {",
    "  helper: Helper;",
    "}",
    "",
  ].join("\n");

  /**
   * A one-package tree, written to a temp directory and read back.
   *
   * The root exports an interface typed by a helper the package declares
   * and never exports. That helper is invisible to a hash of export names,
   * and invisible again to a hash of only the exported declaration, so it
   * is the case the transitive walk exists for.
   */
  function readFixture(
    exportsMap: unknown,
    helper = HELPER,
    index = INDEX,
  ): PackageSurface[] {
    const root = mkdtempSync(join(tmpdir(), "published-surface-"));
    roots.push(root);
    const pkg = join(root, "example");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "@withmarfa/fixture",
        version: "1.0.0",
        exports: exportsMap,
      }),
    );
    writeFileSync(join(pkg, "dist", "helper.d.ts"), helper);
    writeFileSync(join(pkg, "dist", "index.d.ts"), index);
    return readPublishedSurfaces(root);
  }

  const ROOT_ONLY = { ".": { types: "./dist/index.d.ts" } };

  it("reads only what the entry point exports", () => {
    const [s] = readFixture(ROOT_ONLY);
    expect(s!.exports.map((e) => e.name)).toEqual(["Thing"]);
  });

  it("records the shape behind a re-exported name, not the specifier", () => {
    // The ticket's own defect, one level down. Every root export of two
    // published packages arrives through `export { X } from "./y.js"`, and
    // if an alias is not resolved the printer emits the specifier —
    // `Inner as Outer` — which is non-empty, hashes consistently, and
    // records nothing about the shape. That is the names-only surface this
    // guard was repaired to stop being.
    //
    // No fixture exercised a re-export at all, so collapsing the alias
    // resolution passed every case here.
    const [s] = readFixture(
      ROOT_ONLY,
      "export interface Inner { a: string }\n",
      'export { Inner as Outer } from "./helper.js";\n',
    );
    const outer = s!.exports.find((e) => e.name === "Outer");
    expect(outer, "the re-exported name is not in the surface").toBeDefined();
    expect(outer!.declaration).toContain("a: string");
    expect(outer!.declaration).not.toContain("Inner as Outer");
  });

  it("moves when an exported constant becomes reassignable", () => {
    // `const` and `let` live on the enclosing declaration list rather than
    // on the declaration a symbol points at, so the printer rendered both
    // as `X: string` and widening a binding moved no hash. It compiles
    // everywhere and breaks any consumer relying on the value being fixed,
    // which makes it the quiet direction and the one worth catching.
    const asConst = readFixture(
      ROOT_ONLY,
      "export {};\n",
      "export declare const X: string;\n",
    );
    const asLet = readFixture(
      ROOT_ONLY,
      "export {};\n",
      "export declare let X: string;\n",
    );
    expect(hashSurface(asConst[0]!.exports)).not.toBe(
      hashSurface(asLet[0]!.exports),
    );
  });

  it("moves when a name changes which subpath exports it", () => {
    // A name is only importable through the subpath that exports it, so
    // moving one between entry points, or renaming an entry point, breaks
    // consumers while leaving the file, the names and the declarations
    // untouched. Recording the file alone hashed that to nothing.
    const twoEntryPoints = {
      ".": { types: "./dist/index.d.ts" },
      "./helper": { types: "./dist/helper.d.ts" },
    };
    const renamed = {
      ".": { types: "./dist/index.d.ts" },
      "./assistant": { types: "./dist/helper.d.ts" },
    };
    const before = readFixture(twoEntryPoints);
    const after = readFixture(renamed);
    expect(before[0]!.exports.map((e) => e.name).sort()).toEqual(
      after[0]!.exports.map((e) => e.name).sort(),
    );
    expect(hashSurface(before[0]!.exports)).not.toBe(
      hashSurface(after[0]!.exports),
    );
  });

  it("moves when a helper the package never exports changes shape", () => {
    const before = readFixture(ROOT_ONLY);
    const after = readFixture(
      ROOT_ONLY,
      "export interface Helper { a: string; b: number; }\n",
    );
    expect(hashSurface(after[0]!.exports)).not.toBe(
      hashSurface(before[0]!.exports),
    );
  });

  it("stands still when a doc comment inside a declaration is reworded", () => {
    // `getText` drops only the trivia in FRONT of a node, so a comment on
    // an interface field sits inside the declaration. Hashing it would
    // demand a regenerated lock for a typo fix, and reflexive
    // regeneration is how this guard was hollowed out the first time.
    const plain = readFixture(
      ROOT_ONLY,
      "export interface Helper {\n  /** first wording */\n  a: string;\n}\n",
    );
    const reworded = readFixture(
      ROOT_ONLY,
      "export interface Helper {\n  /** second wording, entirely */\n  a: string;\n}\n",
    );
    expect(hashSurface(reworded[0]!.exports)).toBe(
      hashSurface(plain[0]!.exports),
    );
  });

  it("reads an entry point whose types sit under a nested condition", () => {
    const surfaces = readFixture({
      ".": { import: { types: "./dist/index.d.ts", default: "./x.js" } },
    });
    expect(surfaces[0]!.exports.map((e) => e.name)).toEqual(["Thing"]);
  });

  it("refuses an entry point that offers a module and no declarations", () => {
    // Dropping it silently would leave a smaller surface that still
    // hashed consistently and passed forever.
    expect(() =>
      readFixture({ ...ROOT_ONLY, "./extra": { import: "./dist/extra.js" } }),
    ).toThrow(/"\.\/extra"/);
  });

  it("passes over a blocked subpath and a JSON target", () => {
    // `null` blocks a subpath and offers nothing; a JSON file has no type
    // surface to record. Neither is a package forgetting its types.
    const surfaces = readFixture({
      ...ROOT_ONLY,
      "./internal/*": null,
      "./package.json": "./package.json",
    });
    expect(surfaces[0]!.exports.map((e) => e.name)).toEqual(["Thing"]);
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
      expect(s.exports.length, `${s.name} exports nothing`).toBeGreaterThan(0);
    }
  });

  it("reads a declaration for every exported name", () => {
    // An empty declaration list hashes consistently, so a reader that
    // stopped resolving them would pass every case above.
    //
    // The emptiness has to be READ rather than string-matched, and two
    // earlier versions of this test did not manage it. The first asserted
    // `not.toBe("[]")` against a value that cannot be `"[]"`, because
    // `declaration` is encoded twice. The second parsed the outer layer
    // and asserted its length, which is structurally at least one for
    // every key that exists at all — a key is only present because
    // something was added to its set. Both could pass under any mutation.
    //
    // What is asserted here instead is content: every entry carries a
    // subpath a consumer can import and at least one declaration text,
    // and that text is not empty. Arity alone is what let the last two
    // versions through.
    for (const s of surfaces) {
      for (const e of s.exports) {
        for (const pair of JSON.parse(e.declaration) as string[]) {
          const [subpath, contract] = JSON.parse(pair) as [string, string];
          expect(
            subpath,
            `${s.name} exports ${e.name} from an unnamed entry point`,
          ).toMatch(/^\./);
          const texts = JSON.parse(contract) as string[];
          expect(
            texts.length,
            `${s.name} exports ${e.name} with no declaration`,
          ).toBeGreaterThan(0);
          for (const text of texts) {
            expect(
              text.trim(),
              `${s.name} exports ${e.name} with an empty declaration`,
            ).not.toBe("");
          }
        }
      }
    }
  });

  it("locks every publishable package and nothing else", () => {
    expect(Object.keys(lock).sort()).toEqual(
      surfaces.map((s) => s.name).sort(),
    );
  });

  it("no package's surface has moved away from the lock", () => {
    const blocking = blockingViolations(compareToSurfaceLock(surfaces, lock));
    expect(blocking.map(describeSurfaceViolation)).toEqual([]);
  });
});
