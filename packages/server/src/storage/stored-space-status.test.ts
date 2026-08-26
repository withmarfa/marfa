/**
 * What the store does with a space status it cannot read.
 *
 * The property worth testing hardest is the direction of the fallback.
 * The defect this closes was permissive: enforcement is a single equality
 * against `"suspended"`, so every unreadable value read as a space in
 * good standing and the writes the suspension exists to stop were
 * accepted. A test that only asserted "returns a valid status" would pass
 * just as happily on the broken behaviour.
 *
 * These cover the helper in isolation. That the eight store reads
 * actually call it is a separate property and is pinned in
 * `space-status-projection.test.ts`, which drives a real route against a
 * bad value written straight into the database. Neither file is
 * sufficient alone: this one would pass with the helper wired to nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";
import { storedSpaceStatus, spaceFromRow } from "./stored-space-status.js";
import * as logger from "../middleware/logger.js";

let logSpy: MockInstance<typeof logger.log>;

beforeEach(() => {
  logSpy = vi.spyOn(logger, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("storedSpaceStatus", () => {
  it("carries a recognized status through without comment", () => {
    // Both arms, because a guard that returned "suspended" for everything
    // would satisfy every refusal test in this file while suspending every
    // space on the instance.
    expect(storedSpaceStatus("active", "sp_1")).toBe("active");
    expect(storedSpaceStatus("suspended", "sp_2")).toBe("suspended");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("does not read a capitalized status as active", () => {
    // The exact defect. Only `setStatus` writes this column and it takes a
    // typed status, so the realistic source is a hand-written UPDATE
    // against the database. `"Suspended"` failed the one equality that
    // enforces suspension, and the space kept accepting writes.
    expect(storedSpaceStatus("Suspended", "sp_3")).toBe("suspended");
  });

  it("leans restrictive on a status a later build introduced", () => {
    // The rollback case: a newer build wrote a value an older one now
    // meets. The lean is not that later statuses are always restrictions —
    // `trial` would not be — but that honouring a value this build cannot
    // interpret is worse than refusing writes it can announce.
    expect(storedSpaceStatus("pending_deletion", "sp_4")).toBe("suspended");
  });

  it("names the row and the value it found, and says what it did", () => {
    // The log is the only place the true stored string survives: once
    // projected, every API response reports "suspended".
    storedSpaceStatus("Suspended", "sp_5");
    expect(logSpy).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("space status"),
      expect.objectContaining({
        table: "spaces",
        column: "status",
        row_id: "sp_5",
        stored_status: "Suspended",
        projected_as: "suspended",
      }),
    );
  });

  it("reports a non-string legibly rather than as its typeof", () => {
    // The column is NOT NULL DEFAULT 'active' in both dialects, so none of
    // these should be reachable. That is the reason to report them
    // legibly if they ever are, rather than a reason to skip them: a bare
    // `typeof null` logs "object", which tells the reader nothing.
    expect(storedSpaceStatus(null, "sp_6")).toBe("suspended");
    expect(logSpy).toHaveBeenLastCalledWith(
      "error",
      expect.any(String),
      expect.objectContaining({ stored_status: "null" }),
    );

    expect(storedSpaceStatus(1, "sp_7")).toBe("suspended");
    expect(logSpy).toHaveBeenLastCalledWith(
      "error",
      expect.any(String),
      expect.objectContaining({ stored_status: "number" }),
    );
  });
});

describe("spaceFromRow", () => {
  it("guards the status while passing the rest of the row through", () => {
    const space = spaceFromRow({
      id: "sp_8",
      name: "a space",
      created_at: "2026-08-26T00:00:00.000Z",
      status: "Active",
    });
    expect(space).toEqual({
      id: "sp_8",
      name: "a space",
      created_at: "2026-08-26T00:00:00.000Z",
      status: "suspended",
    });
  });

  it("does not disturb a row whose status is fine", () => {
    const space = spaceFromRow({
      id: "sp_9",
      name: null,
      created_at: "2026-08-26T00:00:00.000Z",
      status: "active",
    });
    expect(space.status).toBe("active");
    expect(space.name).toBeNull();
    expect(logSpy).not.toHaveBeenCalled();
  });
});
