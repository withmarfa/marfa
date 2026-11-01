import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { registerTypeSchema, unregisterTypeSchema } from "@withmarfa/shared";
import {
  reportTypeShapeConflicts,
  shapeConflictsOf,
} from "./type-shape-conflicts.js";

const unreadable = new Set<string>();
vi.mock("@withmarfa/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@withmarfa/shared")>();
  return {
    ...actual,
    inheritedShapeConflicts: (typeId: string) => {
      if (unreadable.has(typeId)) throw new TypeError("cannot compare");
      return actual.inheritedShapeConflicts(typeId);
    },
  };
});
import * as logger from "../middleware/logger.js";

let logSpy: MockInstance<typeof logger.log>;

beforeEach(() => {
  logSpy = vi.spyOn(logger, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  unregisterTypeSchema("boot.issue");
  unregisterTypeSchema("boot.unreadable");
  unreadable.clear();
  vi.restoreAllMocks();
});

describe("reportTypeShapeConflicts", () => {
  it("names a registered type and field that the shipped type above declares differently, and says nothing when they agree", () => {
    registerTypeSchema({
      id: "boot.issue",
      version: 1,
      parent: "core.task",
      fields: { labels: { type: "array", items_type: "string" } },
    });
    reportTypeShapeConflicts();
    // The witness: a type that adds a field of its own is not reported.
    expect(logSpy).not.toHaveBeenCalled();

    registerTypeSchema({
      id: "boot.issue",
      version: 2,
      parent: "core.task",
      fields: { assignees: { type: "array", items_type: "string" } },
    });
    reportTypeShapeConflicts();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [level, , fields] = logSpy.mock.calls[0] ?? [];
    expect(level).toBe("warn");
    expect(fields).toMatchObject({
      count: 1,
      conflicts: [
        {
          type: "boot.issue",
          field: "assignees",
          attribute: "items_type",
          owner: "core.task",
        },
      ],
    });
  });
});

describe("a type that cannot be compared", () => {
  it("is skipped and named without its definition, and the other types are still reported", () => {
    registerTypeSchema({
      id: "boot.issue",
      version: 1,
      parent: "core.task",
      fields: { assignees: { type: "array", items_type: "string" } },
    });
    registerTypeSchema({
      id: "boot.unreadable",
      version: 1,
      parent: "core.task",
      fields: { note_text: { type: "string" } },
    });
    // The witness: without the failure, nothing is skipped.
    expect(shapeConflictsOf("boot.unreadable")).toEqual([]);
    expect(logSpy).not.toHaveBeenCalled();

    unreadable.add("boot.unreadable");
    expect(shapeConflictsOf("boot.unreadable")).toEqual([]);
    reportTypeShapeConflicts();

    const skipped = logSpy.mock.calls.filter(([, message]) =>
      message.includes("could not be checked"),
    );
    expect(skipped).toHaveLength(2);
    expect(skipped[0]?.[2]).toEqual({
      type: "boot.unreadable",
      error: "TypeError",
      effect: "the type is left out of the conflict check",
    });
    const reportLine = logSpy.mock.calls.find(([, message]) =>
      message.includes("declare fields in a shape"),
    );
    expect(reportLine?.[2]).toMatchObject({
      conflicts: [{ type: "boot.issue", field: "assignees" }],
    });
  });
});
