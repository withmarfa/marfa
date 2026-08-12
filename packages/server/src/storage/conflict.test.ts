/**
 * Field-level conflict detection against the ancestor snapshot.
 *
 * The write contract asks clients to send only the fields they changed,
 * but detection must not depend on every client's honesty: a client that
 * echoes an unchanged field back used to manufacture a conflict against
 * an edit nobody made, and under a keep-both merge policy that surfaced
 * as a duplicate item holding text the user never typed. These pin that
 * an echo neither conflicts nor reverts, while a genuine collision still
 * surfaces.
 */
import { describe, expect, it } from "vitest";
import { detectConflict } from "./conflict.js";

describe("detectConflict", () => {
  it("does not count an echoed unchanged field as a client change", () => {
    // The client read v1 { title, body }, edited nothing but the title,
    // yet sent both. Another device changed the body in between. The
    // echoed body must neither conflict nor revert the other edit.
    const result = detectConflict({
      clientProperties: { title: "new title", body: "original body" },
      currentProperties: { title: "original title", body: "edited elsewhere" },
      ancestorProperties: { title: "original title", body: "original body" },
    });
    expect(result).toEqual({
      type: "no_conflict",
      merged: { title: "new title", body: "edited elsewhere" },
    });
  });

  it("still surfaces a genuine same-field collision", () => {
    const result = detectConflict({
      clientProperties: { body: "my edit" },
      currentProperties: { body: "their edit" },
      ancestorProperties: { body: "original" },
    });
    expect(result).toEqual({
      type: "conflict",
      conflicting_fields: ["body"],
    });
  });

  it("merges non-overlapping edits from both sides", () => {
    const result = detectConflict({
      clientProperties: { title: "client title" },
      currentProperties: { title: "old", body: "server body" },
      ancestorProperties: { title: "old", body: "old body" },
    });
    expect(result).toEqual({
      type: "no_conflict",
      merged: { title: "client title", body: "server body" },
    });
  });

  it("treats a patch that changes nothing as a clean no-op", () => {
    const result = detectConflict({
      clientProperties: { title: "same", body: "same body" },
      currentProperties: { title: "same", body: "server moved on" },
      ancestorProperties: { title: "same", body: "same body" },
    });
    expect(result).toEqual({
      type: "no_conflict",
      merged: { title: "same", body: "server moved on" },
    });
  });

  it("compares echoes structurally, not by reference", () => {
    const result = detectConflict({
      clientProperties: { tags: ["a", "b"] },
      currentProperties: { tags: ["a", "b", "c"] },
      ancestorProperties: { tags: ["a", "b"] },
    });
    expect(result).toEqual({
      type: "no_conflict",
      merged: { tags: ["a", "b", "c"] },
    });
  });
});
