/**
 * Field-level conflict detection against the ancestor snapshot.
 *
 * The write contract asks clients to send only the fields they changed,
 * but detection must not depend on every client's honesty: a client that
 * echoes an unchanged field back would otherwise manufacture a conflict
 * against an edit nobody made, and under a keep-both merge policy that
 * surfaces as a duplicate item holding text the user never typed. These
 * pin that an echo neither conflicts nor reverts, while a genuine
 * collision still surfaces.
 *
 * The same rules hold for the three fields of an item that are not
 * properties — `tier`, `occurred_at` and `source_id` — which go through
 * the same comparison and appear in the same conflicting-field list, and
 * for a key a replace clears, which is a change to absent.
 */
import { describe, expect, it } from "vitest";
import {
  conflictedSiblingProperties,
  detectConflict,
  planAutoMerge,
} from "./conflict.js";
import type { ItemFieldValues } from "./conflict.js";

/** A row's three item fields, for a case that is about properties. */
const fields = (values: ItemFieldValues = {}): ItemFieldValues => values;

describe("detectConflict", () => {
  it("does not count an echoed unchanged field as a client change", () => {
    // The client read v1 { title, body }, edited nothing but the title,
    // yet sent both. Another device changed the body in between. The
    // echoed body must neither conflict nor revert the other edit.
    const result = detectConflict({
      clientProperties: { title: "new title", body: "original body" },
      currentProperties: { title: "original title", body: "edited elsewhere" },
      ancestorProperties: { title: "original title", body: "original body" },
      clientFields: fields(),
      currentFields: fields({ tier: "library" }),
      ancestorFields: fields({ tier: "library" }),
    });
    expect(result).toEqual({
      type: "no_conflict",
      merged: { title: "new title", body: "edited elsewhere" },
      changedFields: {},
    });
  });

  it("still surfaces a genuine same-field collision", () => {
    const result = detectConflict({
      clientProperties: { body: "my edit" },
      currentProperties: { body: "their edit" },
      ancestorProperties: { body: "original" },
      clientFields: fields(),
      currentFields: fields({ tier: "library" }),
      ancestorFields: fields({ tier: "library" }),
    });
    expect(result).toEqual({
      type: "conflict",
      conflicting_fields: ["body"],
      changedFields: {},
      collidingItemFields: [],
    });
  });

  it("merges non-overlapping edits from both sides", () => {
    const result = detectConflict({
      clientProperties: { title: "client title" },
      currentProperties: { title: "old", body: "server body" },
      ancestorProperties: { title: "old", body: "old body" },
      clientFields: fields(),
      currentFields: fields({ tier: "library" }),
      ancestorFields: fields({ tier: "library" }),
    });
    expect(result).toEqual({
      type: "no_conflict",
      merged: { title: "client title", body: "server body" },
      changedFields: {},
    });
  });

  it("treats a patch that changes nothing as a clean no-op", () => {
    const result = detectConflict({
      clientProperties: { title: "same", body: "same body" },
      currentProperties: { title: "same", body: "server moved on" },
      ancestorProperties: { title: "same", body: "same body" },
      clientFields: fields(),
      currentFields: fields({ tier: "library" }),
      ancestorFields: fields({ tier: "library" }),
    });
    expect(result).toEqual({
      type: "no_conflict",
      merged: { title: "same", body: "server moved on" },
      changedFields: {},
    });
  });

  it("compares echoes structurally, not by reference", () => {
    const result = detectConflict({
      clientProperties: { tags: ["a", "b"] },
      currentProperties: { tags: ["a", "b", "c"] },
      ancestorProperties: { tags: ["a", "b"] },
      clientFields: fields(),
      currentFields: fields({ tier: "library" }),
      ancestorFields: fields({ tier: "library" }),
    });
    expect(result).toEqual({
      type: "no_conflict",
      merged: { tags: ["a", "b", "c"] },
      changedFields: {},
    });
  });

  it("conflicts on an item field both sides moved", () => {
    // The case the properties-only check could not see: neither write
    // carries a property, so there was nothing to compare and the stale
    // writer's value was taken.
    const result = detectConflict({
      clientProperties: {},
      currentProperties: { body: "unchanged" },
      ancestorProperties: { body: "unchanged" },
      clientFields: fields({ occurred_at: "2026-04-01T00:00:00.000Z" }),
      currentFields: fields({ occurred_at: "2026-05-01T00:00:00.000Z" }),
      ancestorFields: fields({ occurred_at: "2026-03-01T00:00:00.000Z" }),
    });
    expect(result).toEqual({
      type: "conflict",
      conflicting_fields: ["occurred_at"],
      changedFields: { occurred_at: "2026-04-01T00:00:00.000Z" },
      collidingItemFields: ["occurred_at"],
    });
  });

  it("conflicts on a tier both sides flipped, even to the same value", () => {
    // A tier has two values, so two writers moving it always agree on the
    // destination. It is still a collision: the second writer read a row
    // the first has already moved, and letting the agreement through would
    // make the check depend on how many values a field happens to have.
    const result = detectConflict({
      clientProperties: {},
      currentProperties: { body: "unchanged" },
      ancestorProperties: { body: "unchanged" },
      clientFields: fields({ tier: "feed" }),
      currentFields: fields({ tier: "feed" }),
      ancestorFields: fields({ tier: "library" }),
    });
    expect(result).toEqual({
      type: "conflict",
      conflicting_fields: ["tier"],
      changedFields: { tier: "feed" },
      collidingItemFields: ["tier"],
    });
  });

  it("merges an item field the server did not move", () => {
    const result = detectConflict({
      clientProperties: {},
      currentProperties: { body: "server moved on" },
      ancestorProperties: { body: "original" },
      clientFields: fields({ occurred_at: "2026-04-01T00:00:00.000Z" }),
      currentFields: fields({ occurred_at: "2026-03-01T00:00:00.000Z" }),
      ancestorFields: fields({ occurred_at: "2026-03-01T00:00:00.000Z" }),
    });
    expect(result).toEqual({
      type: "no_conflict",
      merged: { body: "server moved on" },
      changedFields: { occurred_at: "2026-04-01T00:00:00.000Z" },
    });
  });

  it("does not revert an item field the client echoed back", () => {
    // The item-field half of the first case. A device that sends the tier
    // it read alongside a property edit must not undo a tier written
    // since, and must not be refused for a change it did not make.
    const result = detectConflict({
      clientProperties: { title: "client title" },
      currentProperties: { title: "old", body: "unchanged" },
      ancestorProperties: { title: "old", body: "unchanged" },
      clientFields: fields({ tier: "library" }),
      currentFields: fields({ tier: "feed" }),
      ancestorFields: fields({ tier: "library" }),
    });
    expect(result).toEqual({
      type: "no_conflict",
      merged: { title: "client title", body: "unchanged" },
      changedFields: {},
    });
  });

  it("sorts an item field into the list beside a property", () => {
    const result = detectConflict({
      clientProperties: { body: "my edit" },
      currentProperties: { body: "their edit" },
      ancestorProperties: { body: "original" },
      clientFields: fields({ source_id: "mine" }),
      currentFields: fields({ source_id: "theirs" }),
      ancestorFields: fields({ source_id: "original" }),
    });
    expect(result).toEqual({
      type: "conflict",
      conflicting_fields: ["body", "source_id"],
      changedFields: { source_id: "mine" },
      collidingItemFields: ["source_id"],
    });
  });

  it("keeps an echoed item field out of a resolution that collides elsewhere", () => {
    // The case that makes `changedFields` belong on the conflict branch too.
    // The write collides on a property and echoes the tier it read; a
    // resolution that reapplied everything the write named would revert a
    // tier written since, which is the clobber this whole file is about,
    // arriving through the resolution rather than through the merge.
    const result = detectConflict({
      clientProperties: { body: "my edit" },
      currentProperties: { body: "their edit" },
      ancestorProperties: { body: "original" },
      clientFields: fields({ tier: "library" }),
      currentFields: fields({ tier: "feed" }),
      ancestorFields: fields({ tier: "library" }),
    });
    expect(result).toEqual({
      type: "conflict",
      conflicting_fields: ["body"],
      changedFields: {},
      collidingItemFields: [],
    });
  });

  it("clears a key a replace left out, where the server did not touch it", () => {
    // The client read v1 { title, body, notes } and replaced it with
    // { title, body }: the notes are a change to "absent". The server moved
    // the title since, which does not collide with a clear of the notes.
    const result = detectConflict({
      clientProperties: { title: "original title", body: "original body" },
      currentProperties: {
        title: "server title",
        body: "original body",
        notes: "to clear",
      },
      ancestorProperties: {
        title: "original title",
        body: "original body",
        notes: "to clear",
      },
      clientFields: fields(),
      currentFields: fields({ tier: "library" }),
      ancestorFields: fields({ tier: "library" }),
      clearedProperties: ["notes"],
    });
    expect(result).toEqual({
      type: "no_conflict",
      merged: { title: "server title", body: "original body" },
      changedFields: {},
    });
  });

  it("conflicts on a key a replace left out that the server changed since", () => {
    const result = detectConflict({
      clientProperties: { title: "original title", body: "original body" },
      currentProperties: {
        title: "original title",
        body: "original body",
        notes: "changed since",
      },
      ancestorProperties: {
        title: "original title",
        body: "original body",
        notes: "mine",
      },
      clientFields: fields(),
      currentFields: fields({ tier: "library" }),
      ancestorFields: fields({ tier: "library" }),
      clearedProperties: ["notes"],
    });
    expect(result).toEqual({
      type: "conflict",
      conflicting_fields: ["notes"],
      changedFields: {},
      collidingItemFields: [],
    });
  });

  it("keeps a key the other writer added since, which a replace could not have known", () => {
    const result = detectConflict({
      clientProperties: { title: "original title", body: "original body" },
      currentProperties: {
        title: "original title",
        body: "original body",
        notes: "added since",
      },
      ancestorProperties: { title: "original title", body: "original body" },
      clientFields: fields(),
      currentFields: fields({ tier: "library" }),
      ancestorFields: fields({ tier: "library" }),
      // Listed as cleared, since the body lacks it; not in the ancestor, so
      // not a clear.
      clearedProperties: ["notes"],
    });
    expect(result).toEqual({
      type: "no_conflict",
      merged: {
        title: "original title",
        body: "original body",
        notes: "added since",
      },
      changedFields: {},
    });
  });

  it("never clears a key the body carries, whatever the list says", () => {
    const result = detectConflict({
      clientProperties: { title: "new title", body: "original body" },
      currentProperties: { title: "original title", body: "original body" },
      ancestorProperties: { title: "original title", body: "original body" },
      clientFields: fields(),
      currentFields: fields({ tier: "library" }),
      ancestorFields: fields({ tier: "library" }),
      clearedProperties: ["title", "body"],
    });
    expect(result).toEqual({
      type: "no_conflict",
      merged: { title: "new title", body: "original body" },
      changedFields: {},
    });
  });

  it("takes a key both sides cleared as an echo, not a change", () => {
    // The witness for the two above: the same clear against a row the
    // server has already cleared neither conflicts nor counts.
    const result = detectConflict({
      clientProperties: { title: "original title", body: "original body" },
      currentProperties: { title: "original title", body: "original body" },
      ancestorProperties: {
        title: "original title",
        body: "original body",
        notes: "gone on both sides",
      },
      clientFields: fields(),
      currentFields: fields({ tier: "library" }),
      ancestorFields: fields({ tier: "library" }),
      clearedProperties: ["notes"],
    });
    expect(result).toEqual({
      type: "no_conflict",
      merged: { title: "original title", body: "original body" },
      changedFields: {},
    });
  });
});

describe("planAutoMerge with a cleared key", () => {
  const ancestor = { title: "t", body: "b", notes: "n" };
  const current = { title: "T2", body: "b", notes: "N2" };
  const client = { body: "b" };
  const policy = {
    fields: { notes: "keep_both_copies" as const },
    default: "last_writer_wins" as const,
  };

  it("clears a colliding key under last-writer-wins and keeps it under keep-both", () => {
    const plan = planAutoMerge({
      clientProperties: client,
      currentProperties: current,
      ancestorProperties: ancestor,
      conflictingFields: ["notes", "title"],
      collidingItemFields: [],
      policy,
      clearedProperties: ["title", "notes"],
    });
    expect(plan).toEqual({
      merged: { body: "b", notes: "N2" },
      keepBothFields: ["notes"],
      strategyByField: { notes: "keep_both_copies", title: "last_writer_wins" },
    });
  });

  it("clears a key that did not collide, whatever the policy says", () => {
    const plan = planAutoMerge({
      clientProperties: client,
      currentProperties: { title: "t", body: "b", notes: "n" },
      ancestorProperties: ancestor,
      conflictingFields: [],
      collidingItemFields: [],
      policy,
      clearedProperties: ["title", "notes"],
    });
    expect(plan).toEqual({
      merged: { body: "b" },
      keepBothFields: [],
      strategyByField: {},
    });
  });

  it("leaves a cleared keep-both key off the sibling", () => {
    expect(
      conflictedSiblingProperties({
        clientProperties: client,
        currentProperties: current,
        keepBothFields: ["notes"],
        clearedProperties: ["title", "notes"],
      }),
    ).toEqual({ title: "T2", body: "b" });
  });
});
