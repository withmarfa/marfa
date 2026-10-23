/**
 * The slices of a type predicate cover exactly the types the predicate
 * admits, and no type falls in two of them.
 *
 * Membership here is restated in JavaScript over UTF-8 bytes, the order
 * SQLite's binary collation compares in, and checked against the predicates
 * the server answers by (`typeAnswersSubtreeFilter`, `matchesTypeFilter`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  matchesTypeFilter,
  registerTypeSchema,
  typeAnswersSubtreeFilter,
  unregisterTypeSchema,
  type TypeSchema,
} from "@withmarfa/shared";
import {
  MAX_REPEATED_TERMS,
  MAX_TYPE_SLICES,
  typeSlices,
  type TypeSlice,
} from "./type-slices.js";

const REGISTERED: [string, string | undefined][] = [
  ["probe.root", undefined],
  ["probe.root.a", "probe.root"],
  ["probe.root.b", "probe.root"],
  ["probe.root.b.deep", "probe.root.b"],
  // Reaches `probe.root` by declaration, from outside its namespace.
  ["probe.declared", "probe.root"],
  ["probe.other", undefined],
];

const PROBES = [
  "probe.root",
  "probe.root.",
  "probe.root.a",
  "probe.root.a.x",
  "probe.root.a-x",
  "probe.root.b",
  "probe.root.b.deep",
  "probe.root.b.deep.deeper",
  "probe.root.c",
  "probe.root.ghost.leaf",
  "probe.root.é",
  "probe.root.～",
  "probe.root.\u{1f600}",
  "probe.root/",
  "probe.root0",
  "probe.rooted",
  "probe.roo",
  "probe.declared",
  "probe.declared.child",
  "probe.other",
  "probe.other.x",
  "Probe.root",
  "probe",
  "",
];

function bytes(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

function inSlice(type: string, slice: TypeSlice): boolean {
  if ("point" in slice) return type === slice.point;
  const lower = Buffer.compare(bytes(type), bytes(slice.from));
  return (
    (slice.exclusiveFrom ? lower > 0 : lower >= 0) &&
    Buffer.compare(bytes(type), bytes(slice.before)) < 0
  );
}

function slicesHolding(slices: TypeSlice[], type: string): number {
  return slices.filter((slice) => inSlice(type, slice)).length;
}

beforeEach(() => {
  for (const [id, parent] of REGISTERED) {
    registerTypeSchema({
      id,
      name: id,
      description: "test",
      parent,
      version: 1,
      fields: {},
    } as unknown as TypeSchema);
  }
});

afterEach(() => {
  for (const [id] of REGISTERED) unregisterTypeSchema(id);
});

describe("the slices of a type filter", () => {
  it.each(["probe.root", "probe.root.*", "probe.root.b", "probe.declared"])(
    "hold each type the filter %s answers once, and no other",
    (filter) => {
      const slices = typeSlices({ type: filter })!;
      expect(slices).toBeDefined();
      for (const probe of PROBES) {
        expect({
          probe,
          held: slicesHolding(slices, probe),
        }).toEqual({
          probe,
          held: typeAnswersSubtreeFilter(probe, filter) ? 1 : 0,
        });
      }
    },
  );

  it("make a point of each registered type under the root and of each declared descendant", () => {
    const slices = typeSlices({ type: "probe.root" })!;
    const points = slices.flatMap((slice) =>
      "point" in slice ? [slice.point] : [],
    );
    expect(points.sort()).toEqual([
      "probe.declared",
      "probe.root",
      "probe.root.a",
      "probe.root.b",
      "probe.root.b.deep",
    ]);
  });

  it("make a range of the types between the registered ones, so a type nothing registers is still read", () => {
    const slices = typeSlices({ type: "probe.root" })!;
    expect(slicesHolding(slices, "probe.root.ghost.leaf")).toBe(1);
    const range = slices.find((slice) =>
      inSlice("probe.root.ghost.leaf", slice),
    );
    expect(range).toBeDefined();
    expect("from" in range!).toBe(true);
  });

  it("order a name with a multibyte character by its bytes", () => {
    const slices = typeSlices({ type: "probe.root" })!;
    for (const probe of [
      "probe.root.é",
      "probe.root.～",
      "probe.root.\u{1f600}",
    ]) {
      expect(slicesHolding(slices, probe)).toBe(1);
    }
  });
});

describe("the slices of a permission map", () => {
  const CASES: Record<string, string[]> = {
    "a subtree and a name": ["probe.root.*", "probe.other"],
    "names only": ["probe.root.a", "probe.other", "probe.unregistered"],
    "nested subtrees": ["probe.root.*", "probe.root.b.*"],
    "a name inside a subtree": ["probe.root.*", "probe.root.a"],
    "a subtree and a registered descendant by declaration": [
      "probe.root.*",
      "probe.declared",
    ],
  };

  it.each(Object.keys(CASES))("hold what %s admits once", (name) => {
    const allowed = CASES[name]!;
    const slices = typeSlices({ allowed_types: allowed })!;
    expect(slices).toBeDefined();
    for (const probe of PROBES) {
      expect({ probe, held: slicesHolding(slices, probe) }).toEqual({
        probe,
        held: matchesTypeFilter(probe, { allowed, excluded: [] }) ? 1 : 0,
      });
    }
  });

  it("hold a type both the filter and the grants name no more than once", () => {
    const slices = typeSlices({
      type: "probe.root",
      allowed_types: ["probe.root.b.*"],
    })!;
    for (const probe of PROBES) {
      expect(slicesHolding(slices, probe)).toBeLessThanOrEqual(1);
    }
    // The slices cover the filter; the grants narrow each slice's rows.
    expect(slicesHolding(slices, "probe.root.a")).toBe(1);
  });
});

describe("a type filter that is not sliced", () => {
  it("is every type, for no restriction, the global wildcard or a global grant", () => {
    expect(typeSlices({})).toBeUndefined();
    expect(typeSlices({ type: "*" })).toBeUndefined();
    expect(typeSlices({ allowed_types: ["*"] })).toBeUndefined();
    expect(
      typeSlices({ allowed_types: ["probe.root.*", "*"] }),
    ).toBeUndefined();
  });

  it("is nothing for an empty grant", () => {
    expect(typeSlices({ allowed_types: [] })).toBeUndefined();
  });

  it("is a subtree that needs more slices than a statement carries", () => {
    const ids: string[] = [];
    try {
      for (let i = 0; i < MAX_TYPE_SLICES; i++) {
        const id = `probe.root.wide${String(i).padStart(3, "0")}`;
        ids.push(id);
        registerTypeSchema({
          id,
          name: id,
          description: "test",
          version: 1,
          fields: {},
        } as unknown as TypeSchema);
      }
      expect(typeSlices({ type: "probe.root" })).toBeUndefined();
    } finally {
      for (const id of ids) unregisterTypeSchema(id);
    }
  });

  it("is a subtree whose other conditions would repeat past the parameter limit", () => {
    const wide = Math.ceil(MAX_REPEATED_TERMS / 5);
    expect(typeSlices({ type: "probe.root", repeatedTerms: 1 })).toBeDefined();
    expect(
      typeSlices({ type: "probe.root", repeatedTerms: wide }),
    ).toBeUndefined();
  });
});
