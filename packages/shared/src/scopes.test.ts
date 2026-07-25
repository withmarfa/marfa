import { describe, it, expect } from "vitest";
import {
  parseScope,
  isValidScope,
  expandWildcardScopes,
  expandBundlesToScopes,
  scopesToTypePermissions,
  scopesToEdgePermissions,
  scopesToMetadataPermissions,
  scopeCovers,
} from "./scopes.js";
import type { PermissionBundle } from "./scopes.js";

describe("parseScope", () => {
  it("parses a simple read scope", () => {
    expect(parseScope("core.note:read")).toEqual({
      typePattern: "core.note",
      operation: "read",
    });
  });

  it("parses a write scope", () => {
    expect(parseScope("core.media.book:write")).toEqual({
      typePattern: "core.media.book",
      operation: "write",
    });
  });

  it("parses wildcard scope", () => {
    expect(parseScope("core.media.*:read")).toEqual({
      typePattern: "core.media.*",
      operation: "read",
    });
  });

  it("parses metadata scope", () => {
    expect(parseScope("metadata:read")).toEqual({
      typePattern: "metadata",
      operation: "read",
      kind: "metadata",
    });
  });

  it("parses metadata sub-resource scope", () => {
    expect(parseScope("metadata.types:write")).toEqual({
      typePattern: "metadata.types",
      operation: "write",
      kind: "metadata",
      subresource: "types",
    });
  });

  it("returns null for invalid scopes", () => {
    expect(parseScope("")).toBeNull();
    expect(parseScope("just-a-string")).toBeNull();
    expect(parseScope("core.note:delete")).toBeNull();
    expect(parseScope(":read")).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Adversarial input — defense-in-depth tripwires. parseScope's contract is
// "returns null on invalid input"; these lock that down for shapes a future
// regex relaxation might accidentally accept.
// -----------------------------------------------------------------------------
describe("parseScope — adversarial input", () => {
  it("rejects empty type pattern", () => {
    expect(parseScope(":read")).toBeNull();
  });

  it("rejects empty operation", () => {
    expect(parseScope("core.note:")).toBeNull();
  });

  it("rejects double colon", () => {
    expect(parseScope("core.note::read")).toBeNull();
  });

  it("rejects leading whitespace", () => {
    expect(parseScope(" core.note:read")).toBeNull();
  });

  it("rejects whitespace before colon", () => {
    expect(parseScope("core.note :read")).toBeNull();
  });

  it("rejects whitespace after colon", () => {
    expect(parseScope("core.note: read")).toBeNull();
  });

  it("rejects unknown verb 'execute'", () => {
    expect(parseScope("core.note:execute")).toBeNull();
  });

  it("rejects unknown verb 'delete'", () => {
    expect(parseScope("core.note:delete")).toBeNull();
  });

  it("rejects unknown verb 'admin'", () => {
    expect(parseScope("core.note:admin")).toBeNull();
  });
});

describe("isValidScope", () => {
  it("accepts valid scopes", () => {
    expect(isValidScope("core.note:read")).toBe(true);
    expect(isValidScope("core.media.*:write")).toBe(true);
    expect(isValidScope("metadata:read")).toBe(true);
  });

  it("rejects invalid scopes", () => {
    expect(isValidScope("bad")).toBe(false);
    expect(isValidScope("")).toBe(false);
  });
});

describe("expandWildcardScopes", () => {
  const knownTypes = [
    "core.media",
    "core.media.book",
    "core.media.article",
    "core.note",
    "core.bookmark",
  ];

  it("expands wildcard to matching types", () => {
    const result = expandWildcardScopes(["core.media.*:read"], knownTypes);
    expect(result).toContain("core.media:read");
    expect(result).toContain("core.media.book:read");
    expect(result).toContain("core.media.article:read");
    expect(result).not.toContain("core.note:read");
  });

  it("passes non-wildcard scopes through", () => {
    const result = expandWildcardScopes(["core.note:write"], knownTypes);
    expect(result).toEqual(["core.note:write"]);
  });

  it("deduplicates", () => {
    const result = expandWildcardScopes(
      ["core.note:read", "core.note:read"],
      knownTypes,
    );
    expect(result).toEqual(["core.note:read"]);
  });

  it("skips invalid scopes", () => {
    const result = expandWildcardScopes(
      ["invalid", "core.note:read"],
      knownTypes,
    );
    expect(result).toEqual(["core.note:read"]);
  });
});

describe("scopesToTypePermissions", () => {
  it("converts read scopes to read permissions", () => {
    const perms = scopesToTypePermissions([
      "core.note:read",
      "core.bookmark:read",
    ]);
    expect(perms).toEqual({
      "core.note": "read",
      "core.bookmark": "read",
    });
  });

  it("write trumps read for same type", () => {
    const perms = scopesToTypePermissions([
      "core.note:read",
      "core.note:write",
    ]);
    expect(perms).toEqual({ "core.note": "write" });
  });

  it("skips metadata scopes", () => {
    const perms = scopesToTypePermissions(["metadata:read", "core.note:read"]);
    expect(perms).toEqual({ "core.note": "read" });
  });

  it("returns empty object for no scopes", () => {
    expect(scopesToTypePermissions([])).toEqual({});
  });
});

describe("scopeCovers", () => {
  it("read scope covers read requirement", () => {
    expect(scopeCovers(["core.note:read"], "core.note", "read")).toBe(true);
  });

  it("write scope covers read requirement", () => {
    expect(scopeCovers(["core.note:write"], "core.note", "read")).toBe(true);
  });

  it("read scope does not cover write requirement", () => {
    expect(scopeCovers(["core.note:read"], "core.note", "write")).toBe(false);
  });

  it("wrong type returns false", () => {
    expect(scopeCovers(["core.bookmark:write"], "core.note", "read")).toBe(
      false,
    );
  });

  it("empty scopes returns false", () => {
    expect(scopeCovers([], "core.note", "read")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OIDC scope literals (openid / profile / email).
//
// These don't carry a verb suffix — they're the standard OIDC scopes the
// OAuth provider reads directly off the grant when building userinfo and
// id_token claims. The guarantees this section locks down:
//
//   1. parseScope returns kind="oidc", operation="none" for each, so the
//      consent route accepts them as valid scopes.
//   2. They MUST NOT bleed into type / edge / metadata permission maps —
//      a sloppy projection elsewhere could give an OAuth bearer
//      unintended write access.
// ---------------------------------------------------------------------------

describe("OIDC scope literals", () => {
  for (const literal of ["openid", "profile", "email"] as const) {
    it(`parses ${literal} as kind=oidc with operation=none`, () => {
      expect(parseScope(literal)).toEqual({
        typePattern: literal,
        operation: "none",
        kind: "oidc",
        oidcScope: literal,
      });
      expect(isValidScope(literal)).toBe(true);
    });
  }

  it("OIDC scopes do not project into type_permissions", () => {
    const perms = scopesToTypePermissions([
      "openid",
      "profile",
      "email",
      "core.note:read",
    ]);
    expect(perms).toEqual({ "core.note": "read" });
    expect(perms.openid).toBeUndefined();
    expect(perms.profile).toBeUndefined();
    expect(perms.email).toBeUndefined();
  });

  it("OIDC scopes do not project into edge_permissions", () => {
    const perms = scopesToEdgePermissions([
      "openid",
      "profile",
      "email",
      "edge.parent-of:write",
    ]);
    expect(perms).toEqual({ "parent-of": "write" });
  });

  it("OIDC scopes do not project into metadata_permissions", () => {
    const perms = scopesToMetadataPermissions([
      "openid",
      "profile",
      "email",
      "metadata.types:write",
    ]);
    expect(perms).toEqual({ types: "write" });
  });
});

// ---------------------------------------------------------------------------
// Global type wildcard (`*:read` / `*:write`).
//
// The generous default permission bundle grants `*:write`, which must parse,
// project to a `{ "*": <verb> }` type-permission, and thereby match runtime
// `user.*` types that never appear in the static scope allowlist.
// ---------------------------------------------------------------------------

describe("global type wildcard scope", () => {
  it("parses *:read and *:write", () => {
    expect(parseScope("*:read")).toEqual({
      typePattern: "*",
      operation: "read",
    });
    expect(parseScope("*:write")).toEqual({
      typePattern: "*",
      operation: "write",
    });
    expect(isValidScope("*:read")).toBe(true);
    expect(isValidScope("*:write")).toBe(true);
  });

  it("projects *:write into a wildcard type-permission (write trumps read)", () => {
    expect(scopesToTypePermissions(["*:write"])).toEqual({ "*": "write" });
    expect(scopesToTypePermissions(["*:read", "*:write"])).toEqual({
      "*": "write",
    });
  });

  it("rejects malformed wildcard scopes", () => {
    expect(parseScope("**:read")).toBeNull();
    expect(parseScope("*.foo:read")).toBeNull();
    expect(parseScope("*")).toBeNull();
  });
});

// The scope regex is a splitter, not the authority: its character class is
// deliberately loose, and `isValidTypePattern` is what holds the scope grammar
// and the type-identifier grammar together. Each of these clears the regex and
// has to be refused by the pattern check, or a token is minted carrying a
// permission-map key no real type can ever match.
describe("parseScope defers to the type-pattern grammar", () => {
  const REGEX_CLEARS_GRAMMAR_REJECTS = [
    "core..note:read", // empty segment
    "core.:read", // trailing dot
    "note:read", // single segment
    "core.no*te:read", // wildcard mid-identifier
    "core.note.*.more:read", // wildcard mid-path
    `core.${"n".repeat(200)}:read`, // over the length cap
  ];

  for (const scope of REGEX_CLEARS_GRAMMAR_REJECTS) {
    it(`rejects ${scope}`, () => {
      expect(parseScope(scope)).toBeNull();
      expect(isValidScope(scope)).toBe(false);
    });
  }

  it("still accepts the shapes the grammar allows", () => {
    expect(parseScope("core.note:read")?.typePattern).toBe("core.note");
    expect(parseScope("core.media.*:read")?.typePattern).toBe("core.media.*");
    expect(parseScope("*:read")?.typePattern).toBe("*");
  });
});

describe("metadata.edge_types sub-resource scope", () => {
  it("parses as a metadata sub-resource", () => {
    expect(parseScope("metadata.edge_types:write")).toEqual({
      typePattern: "metadata.edge_types",
      operation: "write",
      kind: "metadata",
      subresource: "edge_types",
    });
  });

  it("projects into metadata_permissions under the edge_types key", () => {
    expect(scopesToMetadataPermissions(["metadata.edge_types:write"])).toEqual({
      edge_types: "write",
    });
  });
});

describe("expandBundlesToScopes", () => {
  const bundles: PermissionBundle[] = [
    {
      id: "read",
      label: "Read your stuff",
      description: "",
      scopes: ["*:read", "edge.*:read", "metadata:read"],
      default_on: true,
    },
    {
      id: "write",
      label: "Write your stuff",
      description: "",
      scopes: ["*:read", "*:write", "metadata.types:write"],
      default_on: true,
    },
  ];

  it("returns the de-duplicated, sorted union of bundle scopes", () => {
    expect(expandBundlesToScopes(bundles)).toEqual([
      "*:read",
      "*:write",
      "edge.*:read",
      "metadata.types:write",
      "metadata:read",
    ]);
  });

  it("returns empty for no bundles", () => {
    expect(expandBundlesToScopes([])).toEqual([]);
  });
});
