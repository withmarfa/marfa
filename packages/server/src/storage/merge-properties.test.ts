/**
 * The merge rule three write paths depend on. The cases below pin the parts
 * that differ by more than style: what a null means, and what a replace
 * leaves out.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { registerTypeSchema, unregisterTypeSchema } from "@withmarfa/shared";
import {
  inAnswerOrder,
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

describe("inAnswerOrder", () => {
  it("puts the declared fields first, in their order, then the rest as sent", () => {
    const sent = JSON.parse(
      '{"links":["l"],"beta":"b","__proto__":"p","alpha":"a","zz":1}',
    ) as Record<string, unknown>;
    // Validation answers a field every type takes first, as here.
    const validated = JSON.parse(
      '{"links":["l"],"alpha":"a","beta":"b","__proto__":"p","zz":1}',
    ) as Record<string, unknown>;
    const ordered = inAnswerOrder(["alpha", "beta", "gamma"], validated, sent);
    expect(Object.keys(ordered)).toEqual([
      "alpha",
      "beta",
      "links",
      "__proto__",
      "zz",
    ]);
    expect(Object.getPrototypeOf(ordered)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(ordered, "__proto__")?.value).toBe(
      "p",
    );
  });

  it("keeps a property validation added that the write did not send", () => {
    expect(
      Object.keys(
        inAnswerOrder(["alpha"], { kept: 1, alpha: 2 }, { alpha: 2 }),
      ),
    ).toEqual(["alpha", "kept"]);
  });
});
