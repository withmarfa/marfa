/**
 * The merge rule three write paths depend on. The cases below pin the parts
 * that differ by more than style: what a null means, and what a replace
 * leaves out.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { registerTypeSchema, unregisterTypeSchema } from "@withmarfa/shared";
import {
  mergeUpdateProperties,
  resolveIncomingProperties,
} from "./merge-properties.js";

const CUSTOM_TYPE = "acme.widget";

beforeAll(() => {
  registerTypeSchema({
    id: CUSTOM_TYPE,
    version: 1,
    fields: {
      name: { type: "string", description: "Name", required: true },
      note: { type: "string", description: "Note" },
    },
  });
});

afterAll(() => {
  unregisterTypeSchema(CUSTOM_TYPE);
});

describe("an ordinary update", () => {
  it("treats a null on an optional field as leaving it unset", () => {
    // `body` is what `core.note` requires; `title` is optional.
    const incoming = resolveIncomingProperties("core.note", {
      body: "kept",
      title: null,
    });
    expect(incoming).toEqual({ body: "kept" });
    expect(
      mergeUpdateProperties({ body: "old", title: "kept too" }, incoming),
    ).toEqual({ body: "kept", title: "kept too" });
  });

  it("keeps a null on a required field so validation can still refuse it", () => {
    const incoming = resolveIncomingProperties("core.note", { body: null });
    expect(incoming).toEqual({ body: null });
  });

  it("resolves a type registered at runtime, not only a shipped one", () => {
    expect(resolveIncomingProperties(CUSTOM_TYPE, { note: null })).toEqual({});
    expect(resolveIncomingProperties(CUSTOM_TYPE, { name: null })).toEqual({
      name: null,
    });
  });
});

describe("a replace", () => {
  it("clears the keys the body leaves out, and only those", () => {
    const incoming = resolveIncomingProperties("core.note", {
      body: "new",
      notes: "kept",
    });
    expect(
      mergeUpdateProperties(
        { body: "old", title: "gone", notes: "kept" },
        incoming,
        "replace",
      ),
    ).toEqual({ body: "new", notes: "kept" });
  });

  it("reads a null as a key left out, so the two ways of clearing agree", () => {
    expect(
      mergeUpdateProperties(
        { body: "old", title: "gone" },
        { body: "new", title: null },
        "replace",
      ),
    ).toEqual({ body: "new" });
  });

  it("leaves the row alone when the update names no properties", () => {
    const current = { title: "unchanged" };
    expect(
      mergeUpdateProperties(
        current,
        resolveIncomingProperties("core.note", undefined),
        "replace",
      ),
    ).toEqual(current);
  });
});
