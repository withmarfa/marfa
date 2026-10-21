/**
 * The retired set is a pure function of the build and the rows, so most of this is a
 * unit test. The one case that is not asks the real storage layer, because
 * the derivation is only worth anything if it is fed by the query the boot
 * actually runs.
 */
import { describe, expect, it } from "vitest";
import { shippedPlatformTypes } from "@withmarfa/shared";
import {
  computeRetiredPlatformTypes,
  forgetRetiredPlatformType,
  retiredPlatformTypes,
  setRetiredPlatformTypes,
} from "./retired-platform-types.js";
import { createTestContext } from "../test-utils.js";
import type { LoadedType } from "./interface.js";

function row(id: string, origin: LoadedType["origin"]): LoadedType {
  return {
    origin,
    schema: {
      id,
      version: 1,
      fields: { name: { type: "string", required: true } },
    },
  };
}

describe("which shipped types an instance carries that the build does not", () => {
  it("reports a platform row the build has stopped shipping", () => {
    const found = computeRetiredPlatformTypes(
      [{ schema: row("core.note", "platform").schema, family: "core" }],
      [row("core.note", "platform"), row("core.retired", "platform")],
    );
    expect(found).toEqual(["core.retired"]);
  });

  it("reports nothing when the rows and the build agree", () => {
    const shipped = [
      { schema: row("core.note", "platform").schema, family: "core" as const },
    ];
    expect(
      computeRetiredPlatformTypes(shipped, [row("core.note", "platform")]),
    ).toEqual([]);
  });

  it("never reports a row that is not the platform's", () => {
    // A runtime registration and a restored row nobody recorded are not
    // the build's to have an opinion about. Scoping on origin is what keeps
    // a prune built on this from reaching either.
    const found = computeRetiredPlatformTypes(
      [],
      [row("jonah.recipe", "user"), row("salvage.thing", "unknown")],
    );
    expect(found).toEqual([]);
  });

  it("is sorted and free of duplicates", () => {
    const found = computeRetiredPlatformTypes(
      [],
      [
        row("core.zebra", "platform"),
        row("core.apple", "platform"),
        row("core.apple", "platform"),
      ],
    );
    expect(found).toEqual(["core.apple", "core.zebra"]);
  });

  it("finds a real row through the query the boot uses", async () => {
    // The unit cases above prove the comparison. This proves the two
    // things fed into it line up in practice: the shipped set and the
    // stored rows, read the way the boot reads them.
    const ctx = await createTestContext();
    try {
      const retired = `core.retired_${Math.random().toString(36).slice(2, 8)}`;
      await ctx.storage.types.create(
        {
          id: retired,
          version: 1,
          fields: { name: { type: "string", required: true } },
        },
        { origin: "platform" },
      );

      const found = computeRetiredPlatformTypes(
        shippedPlatformTypes(),
        await ctx.storage.types.loadAll(),
      );
      expect(found).toContain(retired);
      // And every type the build does ship is absent, which is the half
      // that would make this dangerous if it were wrong.
      for (const shipped of shippedPlatformTypes()) {
        expect(found).not.toContain(shipped.schema.id);
      }
    } finally {
      await ctx.cleanup();
    }
  });

  it("reports what the last boot recorded, and nothing until one has", () => {
    setRetiredPlatformTypes(["core.retired"]);
    expect(retiredPlatformTypes()).toEqual(["core.retired"]);
    setRetiredPlatformTypes([]);
    expect(retiredPlatformTypes()).toEqual([]);
  });

  it("forgets one identifier and leaves the rest", () => {
    setRetiredPlatformTypes(["core.a", "core.b"]);
    forgetRetiredPlatformType("core.a");
    expect(retiredPlatformTypes()).toEqual(["core.b"]);
    forgetRetiredPlatformType("core.unknown");
    expect(retiredPlatformTypes()).toEqual(["core.b"]);
    setRetiredPlatformTypes([]);
  });
});
