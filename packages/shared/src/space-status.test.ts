/**
 * The published half of the space-status guard.
 *
 * This ships to npm and the SDK consumes it, so what it accepts is a
 * contract rather than an implementation detail. The server-side policy
 * for meeting a bad value lives in `storedSpaceStatus` and is tested
 * beside it.
 */
import { describe, it, expect } from "vitest";
import { SPACE_STATUSES, isSpaceStatus } from "./types.js";

describe("SPACE_STATUSES", () => {
  it("is exactly the set the union describes", () => {
    // Pinned rather than derived from the type, because the whole point
    // of the tuple is that the union is generated from it. A test that
    // asked the type would agree with any change, including a wrong one.
    expect([...SPACE_STATUSES]).toEqual(["active", "suspended"]);
  });
});

describe("isSpaceStatus", () => {
  it("accepts every declared status", () => {
    for (const status of SPACE_STATUSES) {
      expect(isSpaceStatus(status)).toBe(true);
    }
  });

  it("refuses a value differing only in case", () => {
    // The motivating defect. Enforcement is one equality against
    // "suspended", so a hand-repair typing "Suspended" read as a space in
    // good standing and kept accepting writes.
    expect(isSpaceStatus("Suspended")).toBe(false);
    expect(isSpaceStatus("ACTIVE")).toBe(false);
  });

  it("refuses a status this build does not ship", () => {
    // A newer build's value met by an older one after a rollback is the
    // realistic source of these, and recognizing one here would let it
    // through every gate that compares against the union.
    expect(isSpaceStatus("archived")).toBe(false);
    expect(isSpaceStatus("pending_deletion")).toBe(false);
  });

  it("refuses non-strings without throwing", () => {
    expect(isSpaceStatus(null)).toBe(false);
    expect(isSpaceStatus(undefined)).toBe(false);
    expect(isSpaceStatus(1)).toBe(false);
    expect(isSpaceStatus({})).toBe(false);
    expect(isSpaceStatus(["active"])).toBe(false);
  });
});
