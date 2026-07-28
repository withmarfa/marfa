import { describe, expect, it } from "vitest";
import {
  ALL_TYPES,
  ALL_CONNECTOR_TYPES,
  ALL_SYSTEM_TYPES,
  CONNECTOR_TYPE_IDS,
  SYSTEM_TYPE_IDS,
  TYPE_REGISTRY,
} from "./type-registry.js";

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
  "core.media.film",
  "core.media.podcast",
  "core.media.series",
  "core.media.song",
  "core.media.tv_episode",
  "core.message",
  "core.note",
  "core.task",
];

const CONNECTOR_TYPE_IDENTIFIERS = [
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
  "readwise.highlight",
  "todoist.task",
  "withmarfa.captured_email",
];

const SYSTEM_TYPE_IDENTIFIERS = [
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
  ...CONNECTOR_TYPE_IDENTIFIERS,
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

  it("keeps the connector family exact", () => {
    expect(sortedIds(ALL_CONNECTOR_TYPES)).toEqual(
      [...CONNECTOR_TYPE_IDENTIFIERS].sort(),
    );
  });

  it("keeps the system family exact", () => {
    expect(sortedIds(ALL_SYSTEM_TYPES)).toEqual(
      [...SYSTEM_TYPE_IDENTIFIERS].sort(),
    );
  });

  it("partitions the registry into three disjoint families", () => {
    const total =
      ALL_TYPES.length + ALL_CONNECTOR_TYPES.length + ALL_SYSTEM_TYPES.length;
    expect(TYPE_REGISTRY.size).toBe(total);
  });

  it("resolves connector types exactly like core types", () => {
    // The families differ in provenance only. A connector type that stopped
    // resolving, or that picked up a system-type restriction, would strand
    // every item a connector has written.
    for (const id of CONNECTOR_TYPE_IDENTIFIERS) {
      expect(TYPE_REGISTRY.get(id)?.id, `missing ${id}`).toBe(id);
      expect(CONNECTOR_TYPE_IDS.has(id), `not classified: ${id}`).toBe(true);
      expect(SYSTEM_TYPE_IDS.has(id), `wrongly system: ${id}`).toBe(false);
    }
  });
});
