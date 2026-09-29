import { describe, it, expect } from "vitest";
import type { Item } from "@withmarfa/shared";
import { frameFor, storedFrame } from "./pubsub.js";

const item = (id: string) =>
  ({
    id,
    type: "core.note",
    state: "trashed",
    properties: {},
  }) as unknown as Item;
const root = { id: "01HROOT", type: "core.task" };
const readsNotes = (type: string) => type === "core.note";

describe("frameFor", () => {
  it("answers each mark to a reader of the named row's type, and never the type itself", () => {
    const deleted = storedFrame({
      type: "deleted",
      item: item("01HCHILD"),
      trashedWith: root,
    });
    const restored = storedFrame({
      type: "restored",
      item: item("01HCHILD"),
      restoredWith: root,
    });

    const full = frameFor(deleted, () => true);
    expect(full.item).toMatchObject({
      trashed_by_cascade: true,
      trashed_with: root.id,
    });
    expect(full).not.toHaveProperty("trashed_with_type");
    expect(frameFor(restored, () => true)).toMatchObject({
      restored_with: root.id,
    });

    const narrow = frameFor(deleted, readsNotes);
    expect(narrow.item).toMatchObject({ trashed_by_cascade: true });
    expect(narrow.item).not.toHaveProperty("trashed_with");
    expect(narrow).not.toHaveProperty("trashed_with_type");
    const narrowRestored = frameFor(restored, readsNotes);
    expect(narrowRestored).not.toHaveProperty("restored_with");
    expect(narrowRestored).not.toHaveProperty("restored_with_type");
  });

  it("withholds a stored mark whose type is missing", () => {
    const stored = storedFrame({
      type: "deleted",
      item: item("01HCHILD"),
      trashedWith: root,
    });
    expect(frameFor(stored, () => true).item).toHaveProperty("trashed_with");
    delete stored.trashed_with_type;
    const frame = frameFor(stored, () => true);
    expect(frame.item).toMatchObject({ trashed_by_cascade: true });
    expect(frame.item).not.toHaveProperty("trashed_with");
  });
});
