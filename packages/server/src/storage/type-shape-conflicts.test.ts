import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { registerTypeSchema, unregisterTypeSchema } from "@withmarfa/shared";
import { reportTypeShapeConflicts } from "./type-shape-conflicts.js";
import * as logger from "../middleware/logger.js";

let logSpy: MockInstance<typeof logger.log>;

beforeEach(() => {
  logSpy = vi.spyOn(logger, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  unregisterTypeSchema("boot.issue");
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
