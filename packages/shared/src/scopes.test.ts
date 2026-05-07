import { describe, it, expect } from "vitest";
import {
  parseScope,
  isValidScope,
  expandWildcardScopes,
  scopesToTypePermissions,
  scopesToEdgePermissions,
  scopesToMetadataPermissions,
  scopesToOidcScopes,
  scopeCovers,
} from "./scopes.js";

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
// T-074: OIDC scope literals (openid / profile / email).
//
// These don't carry a verb suffix — they're the standard OIDC scopes
// consumed only by `/oauth/userinfo` to gate field visibility. The
// guarantees this section locks down:
//
//   1. parseScope returns kind="oidc", operation="none" for each.
//   2. scopesToOidcScopes is the only projection that surfaces them.
//   3. They MUST NOT bleed into type / edge / metadata permission maps —
//      a sloppy projection elsewhere could give an OAuth bearer
//      unintended write access.
// ---------------------------------------------------------------------------

describe("OIDC scope literals (T-074)", () => {
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

  it("scopesToOidcScopes returns the granted set", () => {
    const out = scopesToOidcScopes([
      "openid",
      "profile",
      "email",
      "core.note:read", // ignored
      "metadata:write", // ignored
      "edge.parent-of:read", // ignored
    ]);
    expect(out.has("openid")).toBe(true);
    expect(out.has("profile")).toBe(true);
    expect(out.has("email")).toBe(true);
    expect(out.size).toBe(3);
  });

  it("scopesToOidcScopes ignores unknown literals", () => {
    const out = scopesToOidcScopes(["address", "phone", "openid"]);
    expect(Array.from(out)).toEqual(["openid"]);
  });

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
