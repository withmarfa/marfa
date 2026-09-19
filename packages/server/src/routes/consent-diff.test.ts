import { describe, it, expect } from "vitest";
import { computeConsentDiff } from "./consent-diff.js";

/**
 * Pure-function tests for the re-consent diff helper. The classification is
 * the load-bearing bit; the rendering side is exercised in
 * `consent-render.test.ts`.
 *
 * The cases below the first block are the ones that used to be wrong. None
 * of the original eight named a wildcard, so all eight kept passing when the
 * comparison changed from text to coverage — which is exactly why a suite
 * that stays green through a behaviour change proves nothing on its own.
 */

describe("computeConsentDiff", () => {
  it("classifies scopes into kept / added / removed", () => {
    const diff = computeConsentDiff(
      ["core.note:read", "core.task:read"],
      ["core.note:read", "core.task:read", "core.task:write"],
    );
    expect(diff).toEqual({
      kept: ["core.note:read", "core.task:read"],
      added: ["core.task:write"],
      removed: [],
    });
  });

  it("flags removed scopes", () => {
    const diff = computeConsentDiff(
      ["core.note:read", "core.note:write"],
      ["core.note:read"],
    );
    expect(diff).toEqual({
      kept: ["core.note:read"],
      added: [],
      removed: ["core.note:write"],
    });
  });

  it("handles a fully-replaced scope set", () => {
    const diff = computeConsentDiff(["core.note:read"], ["core.task:write"]);
    expect(diff).toEqual({
      kept: [],
      added: ["core.task:write"],
      removed: ["core.note:read"],
    });
  });

  it("returns empty arrays when prev and next are identical", () => {
    const diff = computeConsentDiff(
      ["core.note:read", "core.task:read"],
      ["core.note:read", "core.task:read"],
    );
    expect(diff).toEqual({
      kept: ["core.note:read", "core.task:read"],
      added: [],
      removed: [],
    });
  });

  it("treats empty prev as all-added", () => {
    const diff = computeConsentDiff([], ["core.note:read", "core.task:read"]);
    expect(diff).toEqual({
      kept: [],
      added: ["core.note:read", "core.task:read"],
      removed: [],
    });
  });

  it("treats empty next as all-removed", () => {
    const diff = computeConsentDiff(["core.note:read", "core.task:read"], []);
    expect(diff).toEqual({
      kept: [],
      added: [],
      removed: ["core.note:read", "core.task:read"],
    });
  });

  it("preserves input ordering of `next` for kept + added", () => {
    const diff = computeConsentDiff(
      ["core.task:read", "core.note:read"],
      ["core.note:write", "core.note:read", "core.task:read"],
    );
    // Ordering follows `next` for kept + added.
    expect(diff.added).toEqual(["core.note:write"]);
    expect(diff.kept).toEqual(["core.note:read", "core.task:read"]);
  });

  it("de-duplicates inputs", () => {
    const diff = computeConsentDiff(
      ["core.note:read", "core.note:read"],
      ["core.note:read", "core.note:read", "core.task:read"],
    );
    expect(diff).toEqual({
      kept: ["core.note:read"],
      added: ["core.task:read"],
      removed: [],
    });
  });
});

/**
 * Coverage, which is what this screen is actually asking.
 *
 * A grant is not a list of strings a request has to match; it is a
 * statement about what the app may reach. Comparing the two as text told a
 * person they were gaining access they already had, and losing access they
 * were keeping.
 */
describe("computeConsentDiff, against a grant broader than the request", () => {
  it("keeps a named type the standing wildcard already covers", () => {
    const diff = computeConsentDiff(["core.*:read"], ["core.note:read"]);
    // Kept, not added: the person granted this the first time they said yes
    // to everything under `core`, and "New" is a lie about what changes.
    expect(diff.kept).toEqual(["core.note:read"]);
    expect(diff.added).toEqual([]);
    // Still removed, and honestly so — the request really is narrower than
    // the standing grant, and the screen has to say what it is dropping.
    expect(diff.removed).toEqual(["core.*:read"]);
  });

  it("removes nothing when the request widens", () => {
    const diff = computeConsentDiff(["core.note:read"], ["core.*:read"]);
    expect(diff.added).toEqual(["core.*:read"]);
    // The half that mattered most. Read as a set difference this said the
    // user was giving up `core.note:read` while granting everything that
    // contains it, and downstream a narrowing is a promise that revokes the
    // client's live tokens.
    expect(diff.removed).toEqual([]);
  });

  it("keeps everything under a standing global wildcard", () => {
    const diff = computeConsentDiff(
      ["*:write"],
      ["core.note:read", "core.task:write", "jonah.reading_item:read"],
    );
    expect(diff.added).toEqual([]);
    expect(diff.kept).toEqual([
      "core.note:read",
      "core.task:write",
      "jonah.reading_item:read",
    ]);
  });

  it("does not let a wildcard grant cover a permission", () => {
    // The one arm where a wrong answer hands over authority rather than
    // showing a redundant tile. A permission is reached by naming it.
    const diff = computeConsentDiff(["*:write"], ["keys.mint"]);
    expect(diff.added).toEqual(["keys.mint"]);
    expect(diff.kept).toEqual([]);
  });

  it("keeps the session mechanisms that ride along unchanged", () => {
    const diff = computeConsentDiff(
      ["openid", "offline_access", "core.*:read"],
      ["openid", "offline_access", "core.note:read"],
    );
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual(["core.*:read"]);
  });
});
