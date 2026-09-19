/**
 * A platform row this build cannot read is placed at the restrictive end.
 *
 * Two properties, and they pull against each other, which is why both are
 * pinned here. The projection must not be `core`, because `core` is the
 * family that joins neither id set and so carries the three-state
 * lifecycle and an open `tier` — the permissive answer, chosen by default
 * for a row nobody could read. And it must not stop the boot, because the
 * rows that can reach it are retired types, archive rows, and rows written
 * by a newer build met by an older one after a rollback. Refusing there
 * would make the rollback impossible to finish from a server that cannot
 * start.
 *
 * The scope is the third. "A row with no family is wrong" is how the rule
 * sounds stated in the abstract and it is not the rule: a `user` row has
 * no platform family and never had one, and an instance a person has
 * registered types on holds many.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";
import type { TypeSchema } from "@withmarfa/shared";
import { projectPlatformRows } from "./platform-family.js";
import type { LoadedType } from "./interface.js";
import * as logger from "../middleware/logger.js";

function schema(id: string): TypeSchema {
  // No laundering cast: this is a real `TypeSchema`, and it is worth
  // keeping that way. A cast here would have hidden `version: "1.0.0"`,
  // which is what an earlier draft carried and the type rejects.
  return { id, version: 1, fields: {} };
}

function row(part: Partial<LoadedType> & { id: string }): LoadedType {
  const { id, ...rest } = part;
  return { schema: schema(id), origin: "platform", ...rest };
}

function families(rows: ReturnType<typeof projectPlatformRows>) {
  return rows.map((r) => [r.schema.id, r.family]);
}

let logSpy: MockInstance<typeof logger.log>;

beforeEach(() => {
  logSpy = vi.spyOn(logger, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("projectPlatformRows", () => {
  it("carries a recognized family through untouched", () => {
    expect(
      families(
        projectPlatformRows([
          row({ id: "core.note", family: "core" }),
          row({ id: "system.connection", family: "system" }),
          row({ id: "readwise.document", family: "integration" }),
        ]),
      ),
    ).toEqual([
      ["core.note", "core"],
      ["system.connection", "system"],
      ["readwise.document", "integration"],
    ]);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("places a row carrying no family at the restrictive end, not core", () => {
    // `core` is what this used to default to, and it is the family that
    // joins neither id set: three-state lifecycle, caller-settable tier.
    // Asserting "not core" as well as "is system" because the first is
    // the property that matters and the second is only today's spelling
    // of it.
    const rows = projectPlatformRows([row({ id: "system.device" })]);
    expect(rows[0]?.family).toBe("system");
    expect(rows[0]?.family).not.toBe("core");
  });

  it("does the same for a family a newer build wrote, and does not throw", () => {
    // The rollback case. An older build meeting a value it does not know
    // must still start: the alternative is a server that cannot come up to
    // be repaired, over a type nothing is using.
    const rows = projectPlatformRows([
      row({ id: "core.note", family: "core" }),
      row({
        id: "marfa.something",
        family: "nonesuch" as LoadedType["family"],
      }),
    ]);
    expect(families(rows)).toEqual([
      ["core.note", "core"],
      ["marfa.something", "system"],
    ]);
  });

  it("says so, naming the row and what it did", () => {
    // A projection nobody can see is the same silence this replaces.
    projectPlatformRows([
      row({ id: "system.webhook", family: "" as LoadedType["family"] }),
    ]);
    expect(logSpy).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("family"),
      expect.objectContaining({
        table: "types",
        column: "family",
        row_id: "system.webhook",
        projected_as: "system",
      }),
    );
  });

  it("is unmoved by a user type carrying no family", () => {
    // The case that would have pinned every type a person registered to a
    // lifecycle they did not choose, on any instance with more than a
    // handful. A user type is not unplaceable, it is simply not a platform
    // row, and this function has nothing to say about it.
    const rows = projectPlatformRows([
      row({ id: "core.note", family: "core" }),
      row({ id: "jonah.reading_item", origin: "user" }),
      row({ id: "acme.widget", origin: "integration" }),
    ]);
    expect(rows.map((r) => r.schema.id)).toEqual(["core.note"]);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
