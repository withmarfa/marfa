import { describe, it, expect } from "vitest";
import { computeConsentDiff } from "./consent-diff.js";

/**
 * Wave C PR5 / T-032 — pure-function tests for the re-consent diff
 * helper. The set-difference logic is the load-bearing bit; the
 * rendering side is exercised in `consent-render.test.ts`.
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
