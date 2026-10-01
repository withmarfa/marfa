import { describe, expect, it } from "vitest";
import {
  ALL_TYPES,
  ALL_SYSTEM_TYPES,
  ALL_TYPE_IDS,
  TYPE_REGISTRY,
} from "./type-registry.js";
import { ALL_EDGE_TYPES } from "./edge-registry.js";

// -----------------------------------------------------------------------------
// The identifier set is a data contract, not an implementation detail.
//
// Every item already written on a live instance carries its type identifier as
// a plain string in `items.type`. Nothing rewrites that column. If a shipped
// identifier changes, disappears, or is re-homed under a different spelling,
// the rows that used it stop resolving to a schema — the data is still there
// and no longer readable as anything.
//
// So the identifiers are pinned literally, below. Splitting the source tree,
// re-partitioning the emitted registries, renaming a file: none of those may
// move this list. A change here strands every item stored under the
// identifier it drops, so it is a decision about stored data and never the
// side effect of a refactor.
// -----------------------------------------------------------------------------

const CORE_TYPE_IDENTIFIERS = [
  "core.bookmark",
  "core.entity",
  "core.entity.person",
  "core.entity.place",
  "core.event",
  "core.file",
  "core.file.audio",
  "core.file.image",
  "core.file.video",
  "core.highlight",
  "core.media",
  "core.media.album",
  "core.media.article",
  "core.media.book",
  "core.media.episode",
  "core.media.film",
  "core.media.series",
  "core.media.song",
  "core.message",
  "core.note",
  "core.task",
];

const SYSTEM_TYPE_IDENTIFIERS = ["system.connection", "system.folder"];

const ALL_SHIPPED_IDENTIFIERS = [
  ...CORE_TYPE_IDENTIFIERS,
  ...SYSTEM_TYPE_IDENTIFIERS,
].sort();

const sortedIds = (schemas: { id: string }[]): string[] =>
  schemas.map((s) => s.id).sort();

describe("shipped type identifiers", () => {
  it("registers exactly the identifiers already written to stored items", () => {
    expect([...TYPE_REGISTRY.keys()].sort()).toEqual(ALL_SHIPPED_IDENTIFIERS);
  });

  it("keeps the core family exact", () => {
    expect(sortedIds(ALL_TYPES)).toEqual([...CORE_TYPE_IDENTIFIERS].sort());
  });

  it("keeps the system family exact", () => {
    expect(sortedIds(ALL_SYSTEM_TYPES)).toEqual(
      [...SYSTEM_TYPE_IDENTIFIERS].sort(),
    );
  });

  it("partitions the registry into two disjoint families", () => {
    expect(TYPE_REGISTRY.size).toBe(ALL_TYPES.length + ALL_SYSTEM_TYPES.length);
  });

  it("exposes the same identifiers to the compiler as to the runtime", () => {
    // `ALL_TYPE_IDS` is what sibling repositories will pin their type maps
    // against, so it has to be the registry rather than a second list beside
    // it. A literal list that drifted would type-check a map naming types
    // this package no longer ships — the exact failure it exists to stop.
    expect([...ALL_TYPE_IDS].sort()).toEqual(ALL_SHIPPED_IDENTIFIERS);
    for (const id of ALL_TYPE_IDS) {
      expect(TYPE_REGISTRY.has(id), `not registered: ${id}`).toBe(true);
    }
  });
});

// Edge identifiers are the same kind of contract: every stored edge carries
// its edge type as a plain string in `edges.edge_type`, and nothing rewrites
// that column. Adding or removing a core edge is a deliberate act that
// changes this list in the same commit.
const CORE_EDGE_TYPE_IDENTIFIERS = [
  "about",
  "attached-to",
  "authored-by",
  "derived-from",
  "in-collection",
  "in-folder",
  "in-thread",
  "parent-of",
  "references",
  "supersedes",
];

describe("shipped edge type identifiers", () => {
  it("registers exactly the identifiers already written to stored edges", () => {
    expect(sortedIds(ALL_EDGE_TYPES)).toEqual(
      [...CORE_EDGE_TYPE_IDENTIFIERS].sort(),
    );
  });
});
