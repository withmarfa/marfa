/**
 * The namespace predicate, held to its breadth.
 *
 * `announcesMetadataChange` decides two things at once: whether a write
 * publishes `metadata.changed`, and whether it moves the item's
 * modification time. Both callers ask it and neither carries its own
 * list, so what this function means is the whole contract.
 *
 * **Written in literals, deliberately.** Every other test that touches
 * this reaches for the `RUNTIME_NAMESPACE` constant, which makes those
 * tests agree with the constant however it is defined and blind to a
 * change in what it means. The strings below are what a caller actually
 * passes.
 */
import { describe, it, expect } from "vitest";
import { announcesMetadataChange } from "./metadata-namespaces.js";

describe("announcesMetadataChange", () => {
  it("stays silent on the reserved runtime namespace", () => {
    expect(announcesMetadataChange("connection.runtime")).toBe(false);
  });

  it("stays silent on a sibling under the reserved root", () => {
    // The check is a prefix match rather than an equality, and this is
    // the case that says so. Narrowed to `!== "connection.runtime"` it
    // would start announcing the inbound-delivery idempotency window —
    // a write per delivery, to every subscription without a type filter.
    expect(announcesMetadataChange("connection.runtime.idempotency")).toBe(
      false,
    );
  });

  it("announces a namespace that merely starts with the same letters", () => {
    // The reserved root carries a trailing dot so it names a subtree
    // rather than a spelling. Without it this namespace is captured by a
    // root it has nothing to do with, and an app's writes go silent.
    expect(announcesMetadataChange("connectionfoo")).toBe(true);
  });

  it("announces an ordinary app namespace", () => {
    expect(announcesMetadataChange("reader.progress")).toBe(true);
  });
});
