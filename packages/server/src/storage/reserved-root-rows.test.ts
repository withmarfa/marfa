/**
 * A stored type under a reserved root that names no tier is reported.
 *
 * The property that matters is the discrimination, not the log line: `user.*`
 * and `app.*` sit inside `RESERVED_ROOTS` and are exactly what a person
 * registers, so a check reading "reserved root" as "wrong" would report every
 * custom type on every instance and be turned off within a day.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";
import type { TypeSchema } from "@withmarfa/shared";
import { PERMISSION_FAMILY_ROOTS } from "@withmarfa/shared";
import { reportReservedRootRows } from "./reserved-root-rows.js";
import type { LoadedType } from "./interface.js";
import * as logger from "../middleware/logger.js";

function row(part: Partial<LoadedType> & { id: string }): LoadedType {
  const { id, ...rest } = part;
  const schema: TypeSchema = { id, version: 1, fields: {} };
  return { schema, origin: "user", ...rest };
}

let logSpy: MockInstance<typeof logger.log>;

beforeEach(() => {
  logSpy = vi.spyOn(logger, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reportReservedRootRows", () => {
  it("reports a row under a tierless reserved root, naming it", () => {
    expect(
      reportReservedRootRows([
        row({ id: "content.note" }),
        row({ id: "webhooks.manage" }),
      ]),
    ).toEqual(["content.note", "webhooks.manage"]);
    expect(logSpy).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("reserved root"),
      expect.objectContaining({
        table: "types",
        row_id: "content.note",
        reserved_root: "content",
      }),
    );
  });

  /**
   * The check runs once per permission root, not once for the family.
   *
   * Seven roots were reserved together, and a scan that recognized six of
   * them would leave one word claimable and one stored row unreported — the
   * failure that reads as coverage, because the six that work are the ones
   * anybody spot-checks. Driven off `PERMISSION_FAMILY_ROOTS` so a root added
   * there arrives here without a second edit remembering to add it.
   */
  it("reports a row under every permission root, one per root", () => {
    const rows = PERMISSION_FAMILY_ROOTS.map((r) => row({ id: `${r}.stored` }));
    expect(reportReservedRootRows(rows)).toEqual(
      PERMISSION_FAMILY_ROOTS.map((r) => `${r}.stored`),
    );
    for (const root of PERMISSION_FAMILY_ROOTS) {
      expect(logSpy).toHaveBeenCalledWith(
        "error",
        expect.stringContaining("reserved root"),
        expect.objectContaining({
          row_id: `${root}.stored`,
          reserved_root: root,
        }),
      );
    }
    // The control. Without it this case passes against a scan that reports
    // every row it is handed, which is the other way to be wrong seven times.
    expect(reportReservedRootRows([row({ id: "jonah.stored" })])).toEqual([]);
  });

  it("is unmoved by the reserved roots that name a tier", () => {
    // The case that decides whether this check survives contact with a real
    // instance. `user` and `app` are reserved AND are where every custom type
    // a person registers lives.
    expect(
      reportReservedRootRows([
        row({ id: "user.reading_item" }),
        row({ id: "app.tickets.ticket" }),
        row({ id: "core.note", origin: "platform" }),
        row({ id: "system.connection", origin: "platform" }),
        row({ id: "marfa.relic", origin: "platform" }),
        row({ id: "salvage.record", origin: "unknown" }),
        row({ id: "jonah.reading_item" }),
      ]),
    ).toEqual([]);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("is not fooled by a publisher handle that merely starts the same way", () => {
    expect(
      reportReservedRootRows([
        row({ id: "contented.note" }),
        row({ id: "keysmith.blank" }),
        row({ id: "configurator.preset" }),
      ]),
    ).toEqual([]);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
