import { describe, expect, it } from "vitest";
import { matchArrivals } from "./arrivals.js";

describe("matching a change to where it showed up", () => {
  it("times each change from its own write to the first reading that holds its marker", () => {
    const result = matchArrivals(
      [
        { marker: "edit-a", wroteAt: 1_000 },
        { marker: "edit-b", wroteAt: 2_000 },
      ],
      [
        { text: "body edit-a", seenAt: 1_400 },
        { text: "body edit-b", seenAt: 2_900 },
      ],
    );
    expect(result.latenciesMs).toEqual([400, 900]);
    expect(result.missing).toEqual([]);
  });

  it("matches by content when the server shows the changes in another order", () => {
    // b was written second and showed first; a showed late.
    const result = matchArrivals(
      [
        { marker: "edit-a", wroteAt: 1_000 },
        { marker: "edit-b", wroteAt: 1_100 },
      ],
      [
        { text: "edit-b", seenAt: 1_300 },
        { text: "edit-a", seenAt: 4_000 },
      ],
    );
    expect(result.latenciesMs).toEqual([3_000, 200]);
  });

  it("takes the earliest reading when a version is read again and again", () => {
    const result = matchArrivals(
      [{ marker: "edit-a", wroteAt: 0 }],
      [
        { text: "edit-a", seenAt: 900 },
        { text: "edit-a", seenAt: 500 },
        { text: "edit-a", seenAt: 700 },
      ],
    );
    expect(result.latenciesMs).toEqual([500]);
  });

  it("counts a change that never showed up as missing, never drops it", () => {
    const result = matchArrivals(
      [
        { marker: "edit-a", wroteAt: 0 },
        { marker: "edit-b", wroteAt: 0 },
      ],
      [{ text: "edit-a", seenAt: 10 }],
    );
    expect(result.latenciesMs).toEqual([10]);
    expect(result.missing).toEqual(["edit-b"]);
  });

  it("does not match a reading taken before the write", () => {
    // A stale reading with the marker cannot belong to a later write of it.
    const result = matchArrivals(
      [{ marker: "edit-a", wroteAt: 1_000 }],
      [{ text: "edit-a", seenAt: 900 }],
    );
    expect(result.latenciesMs).toEqual([]);
    expect(result.missing).toEqual(["edit-a"]);
  });

  it("does not take a marker that is only the start of another", () => {
    const result = matchArrivals(
      [{ marker: "edit-1", wroteAt: 0 }],
      [{ text: "edit-10", seenAt: 5 }],
    );
    expect(result.missing).toEqual(["edit-1"]);
  });
});
