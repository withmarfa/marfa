import { describe, expect, it } from "vitest";
import {
  ALL_TYPES,
  ALL_INTEGRATION_TYPES,
  ALL_SYSTEM_TYPES,
  ALL_TYPE_IDS,
  INTEGRATION_TYPE_IDS,
  SYSTEM_TYPE_IDS,
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
// move this list. A change here is only ever correct alongside a migration
// that rewrites the stored values, and there is no such migration.
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

const INTEGRATION_TYPE_IDENTIFIERS = [
  "google.calendar.event",
  "google.contacts.contact",
  "google.drive.file",
  "google.tasks.task",
  "google.youtube.channel",
  "google.youtube.playlist",
  "google.youtube.video",
  "raindrop.collection",
  "raindrop.raindrop",
  "readwise.book",
  "readwise.document",
  "readwise.highlight",
  "todoist.task",
  "withmarfa.captured_email",
];

const SYSTEM_TYPE_IDENTIFIERS = [
  "system.account_holder",
  "system.activity",
  "system.app",
  "system.connection",
  "system.credential",
  "system.device",
  "system.integration",
  "system.webhook",
];

const ALL_SHIPPED_IDENTIFIERS = [
  ...CORE_TYPE_IDENTIFIERS,
  ...INTEGRATION_TYPE_IDENTIFIERS,
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

  it("keeps the integration family exact", () => {
    expect(sortedIds(ALL_INTEGRATION_TYPES)).toEqual(
      [...INTEGRATION_TYPE_IDENTIFIERS].sort(),
    );
  });

  it("keeps the system family exact", () => {
    expect(sortedIds(ALL_SYSTEM_TYPES)).toEqual(
      [...SYSTEM_TYPE_IDENTIFIERS].sort(),
    );
  });

  it("partitions the registry into three disjoint families", () => {
    const total =
      ALL_TYPES.length + ALL_INTEGRATION_TYPES.length + ALL_SYSTEM_TYPES.length;
    expect(TYPE_REGISTRY.size).toBe(total);
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

  it("resolves integration types exactly like core types", () => {
    // The families differ in provenance only. An integration type that stopped
    // resolving, or that picked up a system-type restriction, would strand
    // every item an integration has written.
    for (const id of INTEGRATION_TYPE_IDENTIFIERS) {
      expect(TYPE_REGISTRY.get(id)?.id, `missing ${id}`).toBe(id);
      expect(INTEGRATION_TYPE_IDS.has(id), `not classified: ${id}`).toBe(true);
      expect(SYSTEM_TYPE_IDS.has(id), `wrongly system: ${id}`).toBe(false);
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
