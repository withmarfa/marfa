/**
 * The realtime type filter resolves a subtree, like every other read.
 *
 * `GET /events?type=core.media` is a read surface, and the other three —
 * `/items`, `/search`, `/export` — resolve the requested type to its
 * subtree, so a `core.media.song` row answers a `core.media` query. The
 * published realtime guide says the stream does the same in as many words:
 * the filter "covers the type's subtypes as well".
 *
 * It did not. The subscription compared the event's type to the requested
 * one with string equality, so a subscriber narrowing to a parent type
 * received nothing at all for its children — and nothing anywhere asserted
 * the behavior in either direction. The documentation, three sibling read
 * surfaces and the type registry all agreed with each other and not with
 * this one comparison.
 */

import { describe, expect, it } from "vitest";
import { eventMatchesTypeFilter } from "./pubsub.js";

describe("the realtime type filter", () => {
  it("answers a parent-type subscription with its subtypes", () => {
    // The registry ships core.media with core.media.song beneath it.
    expect(eventMatchesTypeFilter("core.media.song", "core.media")).toBe(true);
    expect(eventMatchesTypeFilter("core.media.book", "core.media")).toBe(true);
  });

  it("still answers an exact match", () => {
    expect(eventMatchesTypeFilter("core.note", "core.note")).toBe(true);
    expect(eventMatchesTypeFilter("core.media", "core.media")).toBe(true);
  });

  it("refuses an unrelated type", () => {
    expect(eventMatchesTypeFilter("core.task", "core.note")).toBe(false);
    expect(eventMatchesTypeFilter("core.note", "core.media")).toBe(false);
  });

  it("resolves downward only — a child subscription does not catch the parent", () => {
    // Narrowing has to still narrow, or the parameter stops meaning
    // anything for the callers who ask for the most specific type.
    expect(eventMatchesTypeFilter("core.media", "core.media.song")).toBe(false);
  });

  it("passes everything through when no filter is set", () => {
    expect(eventMatchesTypeFilter("core.note", undefined)).toBe(true);
    expect(eventMatchesTypeFilter("anything.at.all", undefined)).toBe(true);
  });

  it("reads an empty list as no filter rather than as a filter admitting nothing", () => {
    // No route builds this today: the parameter parser collapses an empty
    // list to `undefined` before it ever reaches here. That is exactly why
    // the case is asserted directly rather than through a request. The
    // guard inside the function is the second half of a pair, and only one
    // half is reachable from outside — so deleting the guard as
    // unreachable-by-any-caller passes every other test in the repository,
    // and the failure it re-opens is a subscriber silently receiving
    // nothing forever rather than an error anyone sees.
    expect(eventMatchesTypeFilter("core.note", [])).toBe(true);
    expect(eventMatchesTypeFilter("anything.at.all", [])).toBe(true);
  });

  it("answers a list when any entry answers, subtree included", () => {
    // The list arm resolves per entry, so the subtree rule above applies to
    // each one rather than to the list as a whole.
    expect(
      eventMatchesTypeFilter("core.note", ["core.note", "core.task"]),
    ).toBe(true);
    expect(
      eventMatchesTypeFilter("core.media.song", ["core.note", "core.media"]),
    ).toBe(true);
    expect(
      eventMatchesTypeFilter("core.contact", ["core.note", "core.task"]),
    ).toBe(false);
  });
});
