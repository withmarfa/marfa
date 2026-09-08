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
import { reportReservedRootRows } from "./reserved-root-rows.js";
import type { LoadedType } from "./interface.js";
import * as logger from "../middleware/logger.js";

function row(part: Partial<LoadedType> & { id: string }): LoadedType {
  const { id, ...rest } = part;
  const schema: TypeSchema = { id, version: 1, fields: {} };
  return { space_id: "", schema, origin: "user", ...rest };
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
        row({ id: "space.webhooks" }),
      ]),
    ).toEqual(["content.note", "space.webhooks"]);
    expect(logSpy).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("reserved root"),
      expect.objectContaining({
        table: "custom_types",
        row_id: "content.note",
        reserved_root: "content",
      }),
    );
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
        row({ id: "marfa.podcast.show", origin: "platform" }),
        row({ id: "readwise.highlight", origin: "integration" }),
        row({ id: "jonah.reading_item" }),
      ]),
    ).toEqual([]);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("is not fooled by a publisher handle that merely starts the same way", () => {
    expect(reportReservedRootRows([row({ id: "contented.note" })])).toEqual([]);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
