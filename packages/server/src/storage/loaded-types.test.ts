/**
 * One mapping from a stored row to a `LoadedType`, and what it does with
 * a column it cannot read.
 *
 * `origin` is the one worth testing hardest, and the property is that
 * nothing is substituted for a value this build cannot read. A stored
 * `'Platform'` matches neither `platform` nor `user`, so the row is
 * excluded from the shipped vocabulary and from a person's own
 * registrations alike. Substituting a member of the union would pick one
 * of those doors and open it — which an earlier draft did, choosing the
 * one the consent screen offers a read-and-write wildcard over.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";
import { toLoadedTypes, type CustomTypeRow } from "./loaded-types.js";
import * as logger from "../middleware/logger.js";

function row(part: Partial<CustomTypeRow> & { id: string }): CustomTypeRow {
  return {
    schema: JSON.stringify({ id: part.id, version: 1, fields: {} }),
    origin: "user",
    family: null,
    owner_integration: null,
    ...part,
  };
}

let logSpy: MockInstance<typeof logger.log>;

beforeEach(() => {
  logSpy = vi.spyOn(logger, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("toLoadedTypes", () => {
  it("carries recognized provenance through", () => {
    const [loaded] = toLoadedTypes([
      row({
        id: "acme.widget",
        origin: "integration",
        family: "integration",
        owner_integration: "acme/widgets",
      }),
    ]);
    expect(loaded?.origin).toBe("integration");
    expect(loaded?.family).toBe("integration");
    expect(loaded?.owner_integration).toBe("acme/widgets");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("reports an origin it does not recognize without substituting one", () => {
    // The value is handed back unchanged, and that is the property worth
    // asserting rather than an incidental one. A stored `"Platform"`
    // fails `=== "platform"` and `=== "user"` alike, so the row is
    // excluded from the shipped vocabulary and from the person's own
    // registrations both.
    //
    // An earlier draft projected it to `user`, which reads as the
    // cautious answer and is the permissive one: `user` is exactly what
    // the consent screen offers a read-and-write wildcard over.
    const [loaded] = toLoadedTypes([
      row({ id: "acme.widget", origin: "Platform" }),
    ]);
    expect(loaded?.origin).toBe("Platform");
    expect(loaded?.origin).not.toBe("user");
    expect(logSpy).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("origin"),
      expect.objectContaining({
        table: "custom_types",
        column: "origin",
        row_id: "acme.widget",
        stored_origin: "Platform",
        projected_as: null,
      }),
    );
  });

  it("passes an unrecognized family through rather than narrowing it away", () => {
    // The boot projection is what decides where an unplaceable platform
    // row goes, and it logs the value it found. Narrowing here to
    // recognized-or-absent would leave that log reporting `undefined` for
    // every case, including the one it exists for: an older build meeting
    // a family a newer build wrote.
    const [unknown] = toLoadedTypes([
      row({ id: "core.note", family: "nonesuch" }),
    ]);
    expect(unknown?.family).toBe("nonesuch");

    // A genuinely absent column stays absent.
    const [absent] = toLoadedTypes([row({ id: "core.task", family: null })]);
    expect(absent?.family).toBeUndefined();
  });

  it("drops a row whose schema will not parse rather than throwing", () => {
    // One unreadable row must not take out every list query that touches
    // the table, which is the reason a store read is the wrong place to
    // throw at all.
    const rows = toLoadedTypes([
      row({ id: "core.note" }),
      { ...row({ id: "core.broken" }), schema: "{not json" },
    ]);
    expect(rows.map((r) => r.schema.id)).toEqual(["core.note"]);
  });
});
