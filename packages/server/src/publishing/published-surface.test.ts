/**
 * The published surface lock's own tests, plus the check that gates a merge.
 *
 * The gating test lives here, in the ordinary suite, because a plain test
 * cannot be merged past, and `release.yml` builds nothing without a green
 * `ci.yml` run on the same commit, so a surface that moved under a stale
 * lock cannot reach a registry either.
 *
 * Every case that asks whether something is REFUSED asserts on
 * `blockingViolations`, never on the raw list: a violation that is recorded
 * and not blocking stops nothing, and only the blocking set is what the
 * build asks. The cases that read a message are the exception, and they
 * assert on text rather than on refusal.
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
  assertLockShape,
  buildSurfaceLock,
  compareToSurfaceLock,
  blockingViolations,
  describeSurfaceDelta,
  describeSurfaceViolation,
  hashSurface,
  surfaceDelta,
  type PackageSurface,
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

  it("blocks a surface that lost a name, and names it", () => {
    const locked = buildSurfaceLock([surface()]);
    const now = [surface({ exports: [ALPHA] })];

    const blocking = blockingViolations(compareToSurfaceLock(now, locked));

    expect(blocking).toHaveLength(1);
    expect(blocking[0]).toEqual({
      kind: "surface-moved",
      name: "@withmarfa/example",
      delta: { added: [], removed: ["beta"], changed: [] },
    });
  });

  it("blocks a shape change to an already-exported name, and names it", () => {
    // No name added, none removed, and the count is identical.
    const locked = buildSurfaceLock([surface()]);
    const now = [surface({ exports: [ALPHA_WIDENED, BETA] })];

    const blocking = blockingViolations(compareToSurfaceLock(now, locked));

    expect(blocking).toHaveLength(1);
    expect(blocking[0]).toMatchObject({
      kind: "surface-moved",
      delta: { added: [], removed: [], changed: ["alpha"] },
    });
  });

  it("blocks an added name too, because the lock must describe the tree", () => {
    const locked = buildSurfaceLock([surface({ exports: [ALPHA] })]);
    const now = [surface()];

    const blocking = blockingViolations(compareToSurfaceLock(now, locked));

    expect(blocking).toHaveLength(1);
    expect(blocking[0]).toMatchObject({
      kind: "surface-moved",
      delta: { added: ["beta"], removed: [], changed: [] },
    });
  });

  it("blocks a lock whose names were edited under a standing hash", () => {
    // The hash gates and the names are what a reader diffs; a map that no
    // longer describes the hash would name the wrong moves.
    const locked = buildSurfaceLock([surface()]);
    const edited = {
      "@withmarfa/example": {
        hash: locked["@withmarfa/example"]!.hash,
        exports: { alpha: locked["@withmarfa/example"]!.exports.alpha! },
      },
    };
    const blocking = blockingViolations(
      compareToSurfaceLock([surface()], edited),
    );
    expect(blocking).toHaveLength(1);
    expect(blocking[0]).toMatchObject({
      kind: "names-stale",
      delta: { added: ["beta"], removed: [], changed: [] },
    });
    expect(describeSurfaceViolation(blocking[0]!)).toContain("edited by hand");
  });

  it("is quiet once the lock is regenerated for the moved surface", () => {
    // The normal, correct flow, and the one that has to stay silent:
    // change the surface, regenerate, commit both.
    const now = [surface({ exports: [ALPHA] })];
    const regenerated = buildSurfaceLock(now);
    expect(blockingViolations(compareToSurfaceLock(now, regenerated))).toEqual(
      [],
    );
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
  it("names the package and the name that was lost", () => {
    const locked = buildSurfaceLock([surface()]);
    const now = [surface({ exports: [ALPHA] })];
    const text = describeSurfaceViolation(
      compareToSurfaceLock(now, locked)[0]!,
    );
    expect(text).toContain("@withmarfa/example");
    expect(text).toContain("removed beta");
    // The verdict is the policy, so it is asserted as the policy.
    expect(text).toContain("a break for a consumer");
  });

  it("says a rename is a removal and an addition, not a held name", () => {
    // A rename keeps the count, so a message about counts would send the
    // reader hunting for a widened union that is not there.
    const locked = buildSurfaceLock([surface()]);
    const renamed = [surface({ exports: [{ ...ALPHA, name: "gamma" }, BETA] })];
    const text = describeSurfaceViolation(
      compareToSurfaceLock(renamed, locked)[0]!,
    );
    expect(text).toContain("added gamma");
    expect(text).toContain("removed alpha");
  });
});

describe("assertLockShape", () => {
  it("refuses what a comparison would skip", () => {
    for (const bad of [
      {},
      [],
      { "@withmarfa/example": { hash: "x" } },
      { "@withmarfa/example": { hash: "x", exports: {} } },
      { "@withmarfa/example": { hash: "x", exports: [] } },
    ]) {
      expect(() => assertLockShape(bad, "a lock")).toThrow();
    }
  });

  it("accepts what the generator writes", () => {
    const lock = buildSurfaceLock([surface()]);
    expect(assertLockShape(lock, "a lock")).toBe(lock);
  });
});

describe("surfaceDelta", () => {
  it("reads added, removed and changed names off two entries", () => {
    const before = buildSurfaceLock([surface()])["@withmarfa/example"]!;
    const after = buildSurfaceLock([
      surface({
        exports: [
          ALPHA_WIDENED,
          { name: "gamma", declaration: "type gamma = 1;" },
        ],
      }),
    ])["@withmarfa/example"]!;
    expect(surfaceDelta(before, after)).toEqual({
      added: ["gamma"],
      removed: ["beta"],
      changed: ["alpha"],
    });
  });

  it("reports nothing when the recordings agree", () => {
    const entry = buildSurfaceLock([surface()])["@withmarfa/example"]!;
    expect(surfaceDelta(entry, entry)).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
    expect(describeSurfaceDelta(surfaceDelta(entry, entry))).toBe(
      "no name moved",
    );
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
    // A root export that arrives through `export { X } from "./y.js"` is
    // an alias, and unresolved the printer emits the specifier, `Inner as
    // Outer`, which is non-empty, hashes consistently and records nothing
    // about the shape: a names-only surface wearing a declaration.
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
    // on the declaration a symbol points at, so the printer renders both
    // as `X: string`. Widening a binding compiles everywhere and breaks any
    // consumer relying on the value being fixed, which makes it the quiet
    // direction and the one worth catching.
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
    // untouched; only the subpath in the hash can see it.
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
    // demand a regenerated lock for a typo fix, and a lock regenerated by
    // reflex is one nobody reads.
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
  const lock = assertLockShape(
    JSON.parse(readFileSync(LOCK_PATH, "utf8")),
    "the committed lock",
  );

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
    // stopped resolving them would pass every case above. `declaration` is
    // encoded twice, and the outer layer has at least one entry for every
    // key that exists at all, so neither a string match nor the outer
    // length can see emptiness: what is asserted is content, a subpath a
    // consumer can import and a non-empty declaration text behind it.
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

  it("locks every publishable workspace package and nothing else", () => {
    expect(Object.keys(lock).sort()).toEqual(
      surfaces.map((s) => s.name).sort(),
    );
  });

  it("no package's surface has moved away from the lock", () => {
    const blocking = blockingViolations(compareToSurfaceLock(surfaces, lock));
    expect(blocking.map(describeSurfaceViolation)).toEqual([]);
  });
});
