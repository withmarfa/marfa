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
  edgePermissionCovers,
  metadataPermissionCovers,
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

  // Every case above uses an exact type, which is why the wildcard defect
  // survived: a grant of `core.*:read` reported as covering nothing.
  it("a subtree wildcard grant covers a concrete type beneath it", () => {
    expect(scopeCovers(["core.*:read"], "core.bookmark", "read")).toBe(true);
  });

  it("a subtree wildcard write grant covers a read requirement beneath it", () => {
    expect(scopeCovers(["core.*:write"], "core.bookmark", "read")).toBe(true);
  });

  it("the global wildcard covers any type", () => {
    expect(scopeCovers(["*:read"], "marfa.podcast.show", "read")).toBe(true);
  });

  it("a wildcard read grant still does not cover a write requirement", () => {
    expect(scopeCovers(["core.*:read"], "core.bookmark", "write")).toBe(false);
  });

  it("a wildcard does not reach outside its own subtree", () => {
    expect(scopeCovers(["core.*:write"], "marfa.podcast.show", "read")).toBe(
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

// ---------------------------------------------------------------------------
// The two admission checks the auth middleware calls directly.
//
// `scopeCovers` had both directions pinned; these two did not, and the gap
// was measurable rather than theoretical: making either one grant when the
// permission map is absent left all 494 tests here green and the server's
// edge, type and scope-enforcement suites green too. The mainline is well
// covered by those integration suites — making `edgePermissionCovers`
// return true unconditionally fails eight of them — so what was missing is
// specifically the deny direction, which is the half a permission check
// exists for.
// ---------------------------------------------------------------------------

describe("edgePermissionCovers", () => {
  it("denies when the map is absent, rather than defaulting open", () => {
    expect(edgePermissionCovers(undefined, "about", "read")).toBe(false);
    expect(edgePermissionCovers(undefined, "about", "write")).toBe(false);
  });

  it("denies when the map is empty — edge access is opt-in", () => {
    expect(edgePermissionCovers({}, "about", "read")).toBe(false);
  });

  it("denies an edge type the map does not name", () => {
    expect(edgePermissionCovers({ about: "write" }, "parent-of", "read")).toBe(
      false,
    );
  });

  it("grants the named edge type, and write implies read", () => {
    expect(edgePermissionCovers({ about: "read" }, "about", "read")).toBe(true);
    expect(edgePermissionCovers({ about: "write" }, "about", "read")).toBe(
      true,
    );
    expect(edgePermissionCovers({ about: "write" }, "about", "write")).toBe(
      true,
    );
  });

  it("refuses to let read satisfy write", () => {
    expect(edgePermissionCovers({ about: "read" }, "about", "write")).toBe(
      false,
    );
  });

  it("honors the wildcard, on the same read/write terms", () => {
    expect(edgePermissionCovers({ "*": "read" }, "anything", "read")).toBe(
      true,
    );
    expect(edgePermissionCovers({ "*": "read" }, "anything", "write")).toBe(
      false,
    );
    expect(edgePermissionCovers({ "*": "write" }, "anything", "write")).toBe(
      true,
    );
  });

  // A namespace wildcard is the only way to name a custom edge type, which
  // is registered per space at runtime and so cannot appear in any scope
  // list built ahead of the request. Resolving exact ids and the bare `*`
  // alone means the map can hold a pattern that never matches anything: the
  // grant is issued, the token reports it, and the write is still refused.
  it("resolves a namespace wildcard the way item-type patterns do", () => {
    expect(
      edgePermissionCovers({ "user.*": "write" }, "user.blocks", "write"),
    ).toBe(true);
    expect(
      edgePermissionCovers({ "user.*": "read" }, "user.blocks", "read"),
    ).toBe(true);
    expect(
      edgePermissionCovers({ "user.*": "read" }, "user.blocks", "write"),
    ).toBe(false);
  });

  it("keeps a namespace wildcard inside its namespace", () => {
    expect(
      edgePermissionCovers({ "user.*": "write" }, "app.blocks", "read"),
    ).toBe(false);
    // Not a prefix match on the raw string: `users.blocks` is a different
    // namespace that merely starts with the same letters.
    expect(
      edgePermissionCovers({ "user.*": "write" }, "users.blocks", "read"),
    ).toBe(false);
  });

  it("covers the namespace root itself, matching parent-inclusive patterns", () => {
    // `core.media.*` covers `core.media` on the item side, and a grant list
    // that disagreed with the permission map about the root would admit a
    // token whose own reported scopes say otherwise.
    expect(edgePermissionCovers({ "user.*": "write" }, "user", "write")).toBe(
      true,
    );
  });

  // The three stages are individually covered above, and each was green
  // while the whole chain was broken: parsing accepted `edge.user.*:write`,
  // projection stored it, and matching then failed to resolve it, so a
  // token that reported the scope was refused the write. Only a test
  // spanning all three sees that.
  it("carries a granted namespace scope through to the write decision", () => {
    const granted = ["edge.user.*:write", "edge.parent-of:write"];
    const perms = scopesToEdgePermissions(granted);
    expect(perms).toEqual({ "user.*": "write", "parent-of": "write" });
    // A relation edge type this space registered at runtime.
    expect(edgePermissionCovers(perms, "user.blocks", "write")).toBe(true);
    expect(edgePermissionCovers(perms, "parent-of", "write")).toBe(true);
    // And nothing wider came along for the ride.
    expect(edgePermissionCovers(perms, "in-collection", "read")).toBe(false);
  });

  it("lets the more specific pattern win, so a narrow entry can pin a wide one", () => {
    // Longest-prefix precedence, as `resolveTypePermission` applies it: an
    // author writing these two together means "write everywhere except the
    // user namespace, which is read-only".
    const perms = { "*": "write", "user.*": "read" } as const;
    expect(edgePermissionCovers(perms, "user.blocks", "write")).toBe(false);
    expect(edgePermissionCovers(perms, "user.blocks", "read")).toBe(true);
    expect(edgePermissionCovers(perms, "about", "write")).toBe(true);
    // An exact id outranks every pattern, in either direction.
    expect(
      edgePermissionCovers(
        { "user.*": "read", "user.blocks": "write" },
        "user.blocks",
        "write",
      ),
    ).toBe(true);
  });
});

describe("metadataPermissionCovers", () => {
  it("denies when the map is absent, rather than defaulting open", () => {
    expect(metadataPermissionCovers(undefined, "types", "write")).toBe(false);
    expect(metadataPermissionCovers(undefined, "types", "read")).toBe(false);
  });

  it("denies a sub-resource the map does not name", () => {
    expect(
      metadataPermissionCovers({ types: "write" }, "edge_types", "write"),
    ).toBe(false);
  });

  it("grants the named sub-resource, and write implies read", () => {
    expect(metadataPermissionCovers({ types: "write" }, "types", "write")).toBe(
      true,
    );
    expect(metadataPermissionCovers({ types: "write" }, "types", "read")).toBe(
      true,
    );
    expect(metadataPermissionCovers({ types: "read" }, "types", "write")).toBe(
      false,
    );
  });

  it("honors the bare `metadata:<verb>` wildcard across sub-resources", () => {
    expect(metadataPermissionCovers({ "*": "write" }, "types", "write")).toBe(
      true,
    );
    expect(
      metadataPermissionCovers({ "*": "write" }, "edge_types", "write"),
    ).toBe(true);
    expect(metadataPermissionCovers({ "*": "read" }, "types", "write")).toBe(
      false,
    );
  });
});

describe("the global type wildcard stays in its own map", () => {
  // `*:write` is the widest scope in the grammar. The OIDC literals already
  // have their non-bleed pinned; this is the same guarantee for the scope
  // that actually carries data-plane authority — it must not silently
  // become edge or metadata authority too.
  it("does not project into edge permissions", () => {
    expect(scopesToEdgePermissions(["*:write"])).toEqual({});
    expect(scopesToEdgePermissions(["*:read"])).toEqual({});
  });

  it("does not project into metadata permissions", () => {
    expect(scopesToMetadataPermissions(["*:write"])).toEqual({});
    expect(scopesToMetadataPermissions(["*:read"])).toEqual({});
  });
});
