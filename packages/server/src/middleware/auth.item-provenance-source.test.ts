/**
 * The source a create is keyed by and stamped with, given the one it names.
 *
 * Both create doors resolve a row's source through `itemProvenanceSource`, so
 * the rule is pinned here once, beside the function, and the doors are held
 * to it by their own tests and by the conformance fixtures.
 */
import type { ApiKey } from "@withmarfa/shared";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import { describe, expect, it } from "vitest";
import { itemProvenanceSource } from "./auth.js";

function key(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "key-test",
    label: "test",
    source: "laptop",
    sources: ["notes-folder"],

    default_tier: "library",
    type_permissions: {},
    created_at: new Date().toISOString(),
    last_used_at: null,
    ...overrides,
  };
}

/** The refusal `resolve` throws, or a failure naming what it did instead. */
function refusal(resolve: () => unknown): MarfaError {
  try {
    const answered = resolve();
    throw new Error(
      `resolved to ${JSON.stringify(answered)} where a refusal was expected`,
    );
  } catch (err) {
    if (err instanceof MarfaError) return err;
    throw err;
  }
}

describe("itemProvenanceSource", () => {
  it("takes the credential's own source when the write names none", () => {
    expect(itemProvenanceSource(key())).toBe("laptop");
  });

  it("takes the credential's own source when the write names it", () => {
    expect(itemProvenanceSource(key(), "laptop")).toBe("laptop");
  });

  it("takes a source the credential claims when the write names it", () => {
    expect(itemProvenanceSource(key(), "notes-folder")).toBe("notes-folder");
  });

  it("refuses a source the credential does not claim, naming it", () => {
    const refused = refusal(() => itemProvenanceSource(key(), "elsewhere"));
    expect(refused.code).toBe(ErrorCode.FORBIDDEN);
    expect(refused.status).toBe(403);
    expect(refused.details).toEqual({ source: "elsewhere" });
  });

  it("matches a claim exactly, so a near miss is refused rather than read as the claim", () => {
    // The witness is the case above that resolves the claim as written; a
    // case-folded or trimmed match here would put a row under a source
    // nobody claims byte for byte.
    expect(
      refusal(() => itemProvenanceSource(key(), "Notes-Folder")).code,
    ).toBe(ErrorCode.FORBIDDEN);
    expect(
      refusal(() => itemProvenanceSource(key(), " notes-folder")).code,
    ).toBe(ErrorCode.FORBIDDEN);
  });

  it("refuses any named source to a credential that claims nothing", () => {
    // An absent `sources` reads as none, as `ApiKey` documents it, and the
    // own source still resolves, so the refusal is the claim and not the key.
    const bare = key({ sources: undefined });
    expect(itemProvenanceSource(bare)).toBe("laptop");
    expect(refusal(() => itemProvenanceSource(bare, "notes-folder")).code).toBe(
      ErrorCode.FORBIDDEN,
    );
  });
});
