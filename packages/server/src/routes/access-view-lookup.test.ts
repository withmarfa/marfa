import { describe, expect, it } from "vitest";
import { visibleText } from "../pages/reading.js";
import { createTestContext } from "../test-utils.js";
import { AccessView, readAccessWords } from "./access-view.js";

describe("readAccessWords", () => {
  it("looks up the label of a type this instance registered, and leaves the shipped ones to the registry", async () => {
    const ctx = await createTestContext({});
    try {
      await ctx.storage.types.create({
        id: "app.inkwell.draft",
        label: "Reading summary",
        version: 1,
        fields: {},
      });
      const words = await readAccessWords(ctx.storage, [
        "app.inkwell.draft:write",
        "core.note:read",
        "edge.parent-of:read",
      ]);
      expect(words.typeLabels).toEqual({
        "app.inkwell.draft": "Reading summary",
        "core.note": "Note",
      });
      expect(words.descriptions?.["edge.parent-of"]).toBe(
        "Which items sit inside others.",
      );
      expect(
        visibleText(
          String(
            AccessView({
              scopes: ["app.inkwell.draft:write", "edge.parent-of:read"],
              ...words,
            }),
          ),
        ),
      ).toContain("Reading summary Read and edit");
    } finally {
      await ctx.cleanup();
    }
  });
});
