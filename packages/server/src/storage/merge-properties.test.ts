/**
 * The merge rule three write paths depend on. Two of them had already drifted
 * apart, so the cases below pin the parts that differ by more than style: what
 * a null means with and without faithful-mirror semantics, and whether the
 * type resolves in the space that registered it.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { registerTypeSchema, unregisterTypeSchema } from "@withmarfa/shared";
import {
  mergeUpdateProperties,
  resolveIncomingProperties,
} from "./merge-properties.js";

const SPACE = "space-merge-test";
const CUSTOM_TYPE = "acme.widget";

beforeAll(() => {
  registerTypeSchema(
    {
      id: CUSTOM_TYPE,
      version: 1,
      fields: {
        name: { type: "string", description: "Name", required: true },
        note: { type: "string", description: "Note" },
      },
    },
    SPACE,
  );
});

afterAll(() => {
  unregisterTypeSchema(CUSTOM_TYPE, SPACE);
});

describe("an ordinary update", () => {
  it("treats a null on an optional field as leaving it unset", () => {
    // `body` is what `core.note` requires; `title` is optional.
    const incoming = resolveIncomingProperties(
      "core.note",
      { body: "kept", title: null },
      false,
    );
    expect(incoming).toEqual({ body: "kept" });
    expect(
      mergeUpdateProperties(
        { body: "old", title: "kept too" },
        incoming,
        false,
      ),
    ).toEqual({ body: "kept", title: "kept too" });
  });

  it("keeps a null on a required field so validation can still refuse it", () => {
    const incoming = resolveIncomingProperties(
      "core.note",
      { body: null },
      false,
    );
    expect(incoming).toEqual({ body: null });
  });

  it("resolves a type registered by a space, not only a shipped one", () => {
    // The store once resolved the type without the space, so the same
    // null was written as null on a space-registered type.
    expect(
      resolveIncomingProperties(CUSTOM_TYPE, { note: null }, false, SPACE),
    ).toEqual({});
    expect(
      resolveIncomingProperties(CUSTOM_TYPE, { name: null }, false, SPACE),
    ).toEqual({ name: null });
  });
});

describe("an owning integration's re-sync", () => {
  it("clears the keys the upstream cleared, and only those", () => {
    const incoming = resolveIncomingProperties(
      "core.note",
      { body: "new", title: null },
      true,
    );
    expect(
      mergeUpdateProperties(
        { body: "old", title: "gone", notes: "kept" },
        incoming,
        true,
      ),
    ).toEqual({ body: "new", notes: "kept" });
  });

  it("leaves the row alone when the update names no properties", () => {
    const current = { title: "unchanged" };
    expect(
      mergeUpdateProperties(
        current,
        resolveIncomingProperties("core.note", undefined, true),
        true,
      ),
    ).toEqual(current);
  });
});
