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
  isTypeScope,
  SPACE_ROOT,
  SPACE_PERMISSIONS,
  hasSpacePermission,
  requiresExplicitConsent,
  scopesOfferedOffByDefaultOnly,
  grantCoversScope,
} from "./scopes.js";
import type { ParsedScope, PermissionBundle } from "./scopes.js";
import {
  isValidHandle,
  isValidTypeIdentifier,
  isValidTypePattern,
} from "./validation.js";
import {
  INTEGRATION_TYPE_IDS,
  SYSTEM_TYPE_IDS,
  TYPE_REGISTRY,
  isReservedRoot,
} from "./type-registry.js";
import { resolveTypePermission } from "./validation.js";

describe("parseScope", () => {
  it("parses a simple read scope", () => {
    expect(parseScope("core.note:read")).toEqual({
      typePattern: "core.note",
      operation: "read",
      kind: "type",
    });
  });

  it("parses a write scope", () => {
    expect(parseScope("core.media.book:write")).toEqual({
      typePattern: "core.media.book",
      operation: "write",
      kind: "type",
    });
  });

  it("parses wildcard scope", () => {
    expect(parseScope("core.media.*:read")).toEqual({
      typePattern: "core.media.*",
      operation: "read",
      kind: "type",
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

  // Kind confusion. `edge` and `metadata` are not reserved roots, so
  // `edge.foo` is a registrable item type, and `edge.*:write` is a scope the
  // server both advertises and issues. The exact comparison this replaced
  // happened to contain that; a pattern match does not, so the guard is
  // explicit and these pin it.
  it("an edge grant does not satisfy an item-type requirement", () => {
    expect(scopeCovers(["edge.*:write"], "edge.foo", "write")).toBe(false);
  });

  it("an edge grant does not satisfy a concrete edge-named item type", () => {
    expect(scopeCovers(["edge.parent-of:read"], "edge.parent-of", "read")).toBe(
      false,
    );
  });

  it("an oidc scope satisfies nothing", () => {
    expect(scopeCovers(["openid"], "openid", "read")).toBe(false);
  });

  // The load-bearing non-regression for the new matcher: a bare identifier is
  // exact, not a subtree. A later swap to subtree semantics has to fail here.
  it("a bare identifier does not reach its descendants", () => {
    expect(scopeCovers(["core.note:read"], "core.note.private", "read")).toBe(
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
      kind: "type",
    });
    expect(parseScope("*:write")).toEqual({
      typePattern: "*",
      operation: "write",
      kind: "type",
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

// ---------------------------------------------------------------------------
// Space permissions
// ---------------------------------------------------------------------------

describe("space permissions", () => {
  for (const literal of SPACE_PERMISSIONS) {
    it(`parses ${literal}`, () => {
      expect(parseScope(literal)).toEqual({
        typePattern: literal,
        operation: "none",
        kind: "space",
        spacePermission: literal,
      });
      expect(isValidScope(literal)).toBe(true);
    });
  }

  it("carries no verb, and that is pinned rather than incidental", () => {
    // Verb-lessness is a property of the literal, not of the parser: the
    // prefix claim in `parseScope` is what refuses `space.webhooks:read`,
    // and it would go on refusing it if a member of this set grew a colon.
    // The member would then be unparseable and the grant silently dead, so
    // the shape of the set is the thing to hold.
    for (const literal of SPACE_PERMISSIONS) {
      expect(literal).not.toContain(":");
      expect(parseScope(literal)?.operation).toBe("none");
    }
  });

  it("is granted by naming it, and by nothing else", () => {
    // `hasSpacePermission` exists because the neighboring helper answered this
    // question backwards. `*:write` is the full-access path the consent
    // screen offers under Customize, and a pattern match admitted it against
    // anything type-shaped, so the wrong tool said yes to a token holding no
    // capability at all. These two assertions are the pair that catches it.
    expect(hasSpacePermission(["*:write"], "space.item_purge")).toBe(false);
    expect(hasSpacePermission(["*:read"], "space.webhooks")).toBe(false);
    expect(hasSpacePermission(["space.webhooks"], "space.webhooks")).toBe(true);
    // Holding every other capability implies nothing about this one.
    const others = SPACE_PERMISSIONS.filter((c) => c !== "space.keys");
    expect(hasSpacePermission(others, "space.keys")).toBe(false);
    expect(hasSpacePermission([], "space.keys")).toBe(false);
  });

  it("refuses to answer a capability question through scopeCovers", () => {
    // The wrong tool must not answer yes. A capability is never a point on
    // the item-type axis, so the category error answers false rather than
    // matching a wildcard.
    expect(scopeCovers(["*:read"], "space.webhooks", "read")).toBe(false);
    expect(scopeCovers(["*:write"], "space.item_purge", "write")).toBe(false);
    expect(scopeCovers(["*:write"], "space", "write")).toBe(false);
    // And it still answers ordinary type questions the same way.
    expect(scopeCovers(["*:write"], "core.note", "write")).toBe(true);
  });

  it("keeps every capability out of the one that would escalate it", () => {
    // The two boundaries in the set that a reader is most likely to want to
    // collapse, pinned so collapsing one is a test failure rather than a
    // judgement call made again from scratch. Managing this app's own keys
    // must not carry the power to revoke every other app's access, and
    // configuring a connection must not carry the credential behind it.
    const keys = ["space.keys"];
    expect(hasSpacePermission(keys, "space.app_grants")).toBe(false);
    const connections = ["space.connections"];
    expect(hasSpacePermission(connections, "space.credentials")).toBe(false);
    // Installing a connection must not carry the power to spend its live
    // upstream token against the third-party account behind it.
    expect(hasSpacePermission(connections, "space.upstream_access")).toBe(
      false,
    );
    // And reading how full a space is must not carry rewriting its policy.
    const usage = ["space.usage"];
    expect(hasSpacePermission(usage, "space.settings")).toBe(false);
  });

  it("names one surface per admin gate, so consent reads as sentences", () => {
    // A set that has quietly become one entry is the failure this guards:
    // the whole point is that a person grants webhooks without granting
    // credentials. The count is the cheapest statement of that.
    expect(new Set(SPACE_PERMISSIONS).size).toBe(SPACE_PERMISSIONS.length);
    expect(SPACE_PERMISSIONS.length).toBe(11);
  });

  it("claims its whole namespace, members or nothing", () => {
    // A near-miss must not degrade into some other family's grant. Each of
    // these is refused for a different reason worth pinning:
    // an unknown surface, a verb the grammar does not carry here, the bare
    // root, and the wildcard that `isValidTypePattern` would otherwise
    // accept as an item-type pattern.
    expect(parseScope("space.everything")).toBeNull();
    // The name the previous draft of this set used. A retired member has to
    // fail rather than linger as a literal nothing enforces.
    expect(parseScope("space.types")).toBeNull();
    expect(parseScope("space.webhooks:read")).toBeNull();
    expect(parseScope("space.webhooks:write")).toBeNull();
    expect(parseScope("space")).toBeNull();
    expect(parseScope("space.*")).toBeNull();
    expect(parseScope("space.*:read")).toBeNull();
    expect(parseScope("space.")).toBeNull();
    expect(parseScope("Space.webhooks")).toBeNull();
    expect(parseScope("space.web hooks")).toBeNull();
  });

  it("does not admit a near-miss on the item-type axis either", () => {
    // The refusal above is only worth anything if nothing downstream
    // reinstates the literal. `space.*:read` is the one that matters:
    // parsed as an item-type pattern it would resolve against the live
    // registry rather than naming a capability at all.
    expect(scopesToTypePermissions(["space.*:read"])).toEqual({});
    expect(scopeCovers(["space.*:read"], "space.webhooks", "read")).toBe(false);
  });

  for (const literal of SPACE_PERMISSIONS) {
    it(`${literal} reaches none of the three permission maps`, () => {
      expect(scopesToTypePermissions([literal])).toEqual({});
      expect(scopesToEdgePermissions([literal])).toEqual({});
      expect(scopesToMetadataPermissions([literal])).toEqual({});
    });
  }

  it("carries no authority alongside a grant that has some", () => {
    // The realistic shape: a capability arrives in the same token as the
    // data-plane scopes an app actually uses, so the projections have to
    // stay exact rather than merely non-empty.
    const held = [
      "core.note:read",
      "edge.parent-of:write",
      "metadata.types:write",
      "space.webhooks",
      "space.keys",
    ];
    expect(scopesToTypePermissions(held)).toEqual({ "core.note": "read" });
    expect(scopesToEdgePermissions(held)).toEqual({ "parent-of": "write" });
    expect(scopesToMetadataPermissions(held)).toEqual({ types: "write" });
  });

  it("passes through wildcard expansion unchanged", () => {
    // The set holds no wildcard, so expansion has nothing to do here and
    // must not drop the literal on its way to the consent screen.
    expect(
      expandWildcardScopes(
        ["space.webhooks", "core.media.*:read"],
        ["core.media", "core.media.book"],
      ),
    ).toEqual(["space.webhooks", "core.media:read", "core.media.book:read"]);
  });

  it("keeps the root out of the type grammar", () => {
    // The reservation is what stops a publisher registering a type whose
    // identifier is a capability literal. Without it the grant and the type
    // would be the same string with two meanings.
    expect(isReservedRoot(SPACE_ROOT)).toBe(true);
    for (const literal of SPACE_PERMISSIONS) {
      expect(isValidTypeIdentifier(literal)).toBe(false);
      expect(isValidTypePattern(literal)).toBe(false);
    }
    expect(isValidTypeIdentifier("space.anything")).toBe(false);
    expect(isValidHandle(SPACE_ROOT)).toBe(false);
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
// The deny direction on these two is what needs pinning here, and the gap
// is measurable rather than theoretical: making either one grant when the
// permission map is absent leaves every test in this file green and the
// server's edge, type and scope-enforcement suites green too. The mainline
// is well covered by those integration suites (making `edgePermissionCovers`
// return true unconditionally fails eight of them), so what these cases add
// is specifically the deny direction, which is the half a permission check
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

// ---------------------------------------------------------------------------
// A scope reaches the item-type axis because it was identified as a type
// scope, never because it was not identified as anything else.
//
// Naming the families they skip reads the same as the rule on today's union
// and inverts on tomorrow's: a family nobody adds to the list falls through
// to "must be an item type", and being treated as one means having the
// pattern matched against the live type registry, where a `*` anywhere in it
// reaches every registered type.
//
// These cases are written against the union itself rather than against a
// hand-kept list of families, so a kind that does not exist yet is measured
// by them the day it is added.
// ---------------------------------------------------------------------------

describe("only type scopes reach the item-type axis", () => {
  // One literal per family the grammar recognizes, as a total record: adding
  // a member to `ParsedScope["kind"]` stops this file compiling until the new
  // family has a literal here and is run through everything below.
  const LITERAL_BY_KIND: Record<ParsedScope["kind"], string> = {
    type: "core.note:read",
    edge: "edge.parent-of:write",
    metadata: "metadata.types:write",
    oidc: "openid",
    space: "space.webhooks",
    content: "content:read",
    profile: "profile.name:write",
  };

  // Which families reach `type_permissions` at all, as a second total record
  // so the two facts cannot be confused. `type` reaches it through
  // `isTypeScope`, with its own pattern as the key. `content` reaches it
  // through an arm of its own, projecting a complement — its pattern never
  // becomes a key, which is the property the standalone case below pins. The
  // other five must not reach it by any route — `profile` included, and it is
  // the one most worth stating: Category 2 is a separate category from
  // Category 1, and a grant in one never implies access in the other.
  const REACHES_TYPE_AXIS: Record<ParsedScope["kind"], boolean> = {
    type: true,
    edge: false,
    metadata: false,
    oidc: false,
    space: false,
    content: true,
    profile: false,
  };

  const kinds = Object.keys(LITERAL_BY_KIND) as ParsedScope["kind"][];

  for (const kind of kinds) {
    const literal = LITERAL_BY_KIND[kind];
    const isType = kind === "type";
    const reachesAxis = REACHES_TYPE_AXIS[kind];

    it(`parses ${literal} as kind=${kind}`, () => {
      // The fixture has to be honest or the two cases below prove nothing.
      expect(parseScope(literal)?.kind).toBe(kind);
    });

    it(`${reachesAxis ? "admits" : "refuses"} ${literal} in type_permissions`, () => {
      const admitted = Object.keys(scopesToTypePermissions([literal]));
      expect(admitted.length > 0).toBe(reachesAxis);
    });

    it(`${isType ? "lets" : "stops"} ${literal} satisfy an item-type requirement`, () => {
      // The requirement is the scope's own pattern, so a bare
      // `typeMatchesPattern` would match it. Whether it is refused is then
      // down to the kind and nothing else, which is the property under test.
      const pattern = parseScope(literal)?.typePattern ?? "";
      expect(scopeCovers([literal], pattern, "read")).toBe(isType);
    });

    // `content` is deliberately outside this pairing and has a case of its
    // own below: it is the one family where the two projections give
    // different answers by construction, because it reaches the axis without
    // being an item-type scope.
    if (kind === "content") continue;

    it(`the two projections agree about ${kind} scopes`, () => {
      // One predicate answers for both, so they cannot drift apart the way
      // two hand-maintained skip lists could.
      const pattern = parseScope(literal)?.typePattern ?? "";
      expect(scopeCovers([literal], pattern, "read")).toBe(
        Object.keys(scopesToTypePermissions([literal])).length > 0,
      );
    });
  }

  it("lets the content category reach the axis without its pattern becoming a key", () => {
    // The one family the paired assertion above cannot cover, stated rather
    // than skipped. `content` is not an item-type scope — `isTypeScope`
    // refuses it, so `scopeCovers` never matches it — and it still projects,
    // because the category is a complement over the axis rather than a
    // pattern on it.
    //
    // What must never happen is the pattern itself becoming a map key.
    // `content` matches no registered type and never will, so an entry under
    // it would read as a grant on a consent screen and resolve to nothing at
    // the point of use.
    const perms = scopesToTypePermissions(["content:read"]);
    expect(Object.keys(perms)).not.toContain("content");
    expect(perms["*"]).toBe("read");
    expect(scopeCovers(["content:read"], "content", "read")).toBe(false);
  });

  it("keeps a wildcard-bearing non-type scope off the registry match", () => {
    // The shape that makes the exclusion list dangerous rather than untidy:
    // admitted to `type_permissions`, `edge.*` is a pattern the storage layer
    // and every permission check resolve against real registered types.
    expect(scopesToTypePermissions(["edge.*:write"])).toEqual({});
    expect(scopeCovers(["edge.*:write"], "edge.anything", "write")).toBe(false);
  });

  it("refuses a kind this build does not know", () => {
    // The compile-time check cannot see a value that crossed a package
    // boundary from a build compiled against a wider union, so the runtime
    // arm has to deny as well. It is the same answer either way: unclassified
    // is not an item-type grant.
    const fromANewerBuild = {
      kind: "future",
      typePattern: "*",
      operation: "write",
    } as unknown as ParsedScope;
    expect(isTypeScope(fromANewerBuild)).toBe(false);
  });

  it("classifies every family the parser can emit", () => {
    for (const kind of kinds) {
      const parsed = parseScope(LITERAL_BY_KIND[kind]);
      expect(parsed).not.toBeNull();
      expect(isTypeScope(parsed!)).toBe(kind === "type");
    }
  });
});

describe("scopesOfferedOffByDefaultOnly", () => {
  const bundle = (
    id: string,
    default_on: boolean,
    scopes: string[],
  ): PermissionBundle => ({
    id,
    label: id,
    description: "",
    scopes,
    default_on,
  });

  it("withholds a scope only an off-by-default bundle offers", () => {
    const out = scopesOfferedOffByDefaultOnly([
      bundle("read", true, ["core.note:read"]),
      bundle("manage", false, ["core.task:write"]),
    ]);
    expect([...out]).toEqual(["core.task:write"]);
  });

  it("does not withhold a scope an on-by-default bundle also offers", () => {
    // The overlap case, and the one the consent screen has to agree with:
    // any on-by-default bundle claiming a scope makes it on-by-default. A
    // renderer resolving the same overlap first-bundle-wins would show this
    // unticked while the device flow granted it in one click.
    const out = scopesOfferedOffByDefaultOnly([
      bundle("manage", false, ["core.task:write"]),
      bundle("read", true, ["core.task:write"]),
    ]);
    expect(out.size).toBe(0);
  });

  it("does not withhold a scope an on-by-default wildcard reaches", () => {
    // The overlap case again, one step wider. `core.*:write` is what the
    // user gets by leaving the ticked bundle alone, and it reaches
    // `core.task:write`, so withholding that literal withholds nothing while
    // unticking it on a device flow the consent screen would have ticked.
    const out = scopesOfferedOffByDefaultOnly([
      bundle("write", true, ["core.*:write"]),
      bundle("manage", false, ["core.task:write"]),
    ]);
    expect(out.size).toBe(0);
  });

  it("still withholds a scope the on-by-default wildcard does not reach", () => {
    // The control. A wildcard covers its own subtree and nothing else, so
    // breadth here must not read as the withholding quietly ceasing to
    // apply: a sibling root and a capability are both still withheld.
    const out = scopesOfferedOffByDefaultOnly([
      bundle("write", true, ["core.*:write"]),
      bundle("manage", false, ["user.secret:write", "space.keys"]),
    ]);
    expect([...out].sort()).toEqual(["space.keys", "user.secret:write"]);
  });

  it("keeps a scope an on-by-default bundle names outright", () => {
    // Coverage is asked of the whole on-by-default union, and a union is not
    // monotone: a narrower entry outranks a wildcard, so this union does not
    // cover the `*:write` one of its own bundles names. Asking coverage
    // alone would start withholding it, which is a refusal in the direction
    // nobody would think to look.
    const out = scopesOfferedOffByDefaultOnly([
      bundle("all", true, ["*:write"]),
      bundle("read", true, ["core.*:read"]),
      bundle("manage", false, ["*:write"]),
    ]);
    expect(out.size).toBe(0);
  });

  it("never withholds a hidden mechanism", () => {
    // `offline_access` is what a client names to get a refresh token, and
    // every SDK device flow requests it. Withholding it would refuse them
    // all at initiation over an operator's bundle layout.
    const out = scopesOfferedOffByDefaultOnly([
      bundle("odd", false, ["openid", "offline_access", "core.task:write"]),
    ]);
    expect([...out]).toEqual(["core.task:write"]);
  });

  it("ignores a scope no bundle mentions", () => {
    const out = scopesOfferedOffByDefaultOnly([
      bundle("manage", false, ["core.task:write"]),
    ]);
    expect(out.has("core.bookmark:read")).toBe(false);
  });
});

/**
 * Coverage, which is the question every consent comparison was asking and
 * none of them was answering.
 *
 * These pin behaviour that partly already held — exact membership always
 * worked — so there is no red phase to notice and each guard is worth
 * breaking on purpose. The capability arm is the one to break first: it is
 * the only one whose failure is a fail-open rather than a re-prompt.
 */
describe("grantCoversScope", () => {
  describe("item types, where breadth is the whole point", () => {
    it("covers a named type from a namespace wildcard", () => {
      // The fix, in one line. A person who granted "all your core content"
      // has already answered the question a later request for `core.note`
      // asks, and the string comparison this replaces asked it again on
      // every launch.
      expect(grantCoversScope(["core.*:read"], "core.note:read")).toBe(true);
    });

    it("covers anything from the global wildcard", () => {
      expect(grantCoversScope(["*:read"], "core.note:read")).toBe(true);
      expect(grantCoversScope(["*:read"], "jonah.reading_item:read")).toBe(
        true,
      );
    });

    it("covers a read requirement from a write grant", () => {
      expect(grantCoversScope(["core.*:write"], "core.note:read")).toBe(true);
    });

    it("does not cover a write requirement from a read grant", () => {
      expect(grantCoversScope(["core.*:read"], "core.note:write")).toBe(false);
    });

    it("does not let a narrow grant cover a broad requirement", () => {
      // The asymmetry is the point: this direction is how a widening is
      // told apart from a narrowing, and reading it the other way revokes
      // a client's live tokens.
      expect(grantCoversScope(["core.note:read"], "core.*:read")).toBe(false);
    });

    /**
     * Precedence, which is the half a pattern matcher does not have.
     *
     * A grant may hold a broad pattern and a narrower one at a lower verb,
     * because a client may request both. The bearer middleware resolves that
     * by precedence — exact, then the longest matching subtree wildcard, then
     * the global one — so the narrower pattern genuinely holds the broader one
     * down. A helper that returns on the first pattern to match with a
     * sufficient verb answers the opposite way, and this function delegated to
     * one until a review found it.
     *
     * The direction matters: answering yes here skips a consent screen, and
     * the token minted from the request then carries the concrete literal,
     * which projects to an exact entry and outranks the wildcard that had been
     * holding it down. The grant gains write access nobody agreed to.
     */
    it("lets a narrower pattern hold a broader one down", () => {
      const held = ["*:write", "core.*:read"];
      expect(grantCoversScope(held, "core.note:write")).toBe(false);
      // The same grant still covers the read, and still covers a write
      // outside the namespace the narrower pattern speaks for.
      expect(grantCoversScope(held, "core.note:read")).toBe(true);
      expect(grantCoversScope(held, "jonah.reading_item:write")).toBe(true);
    });

    it("lets a narrower pattern raise the verb as well as lower it", () => {
      expect(
        grantCoversScope(["*:read", "core.*:write"], "core.note:write"),
      ).toBe(true);
    });

    it("lets an exact grant outrank a wildcard above it", () => {
      expect(
        grantCoversScope(["core.*:write", "core.note:read"], "core.note:write"),
      ).toBe(false);
    });

    it("resolves a subtree wildcard as parent-inclusive", () => {
      // `core.media.*` speaks for `core.media` itself, matching the
      // resolver the request path runs.
      expect(grantCoversScope(["core.media.*:read"], "core.media:read")).toBe(
        true,
      );
    });

    /**
     * A wildcard requirement is not a point question, and answering it as one
     * is fail-open.
     *
     * Every resolver on every axis takes a concrete identifier and looks at
     * the entries at or above it. Handed a pattern, it therefore never sees a
     * held entry BENEATH that pattern — and an entry beneath is exactly what
     * narrows a grant. The first version of this function asked the resolver
     * anyway, and a review caught it.
     */
    it("refuses a wildcard requirement that something under it narrows", () => {
      // `*:write` sits above `core`, so the resolver finds it and says yes,
      // having never looked at the `core.note` that is the reason to say no.
      expect(
        grantCoversScope(["*:write", "core.note:read"], "core.*:write"),
      ).toBe(false);
    });

    it("refuses a global requirement that any entry narrows", () => {
      // The same shape one level up, and the case that also made a verbatim
      // membership test unsafe: `*:write` is literally in the held set.
      expect(grantCoversScope(["*:write", "core.*:read"], "*:write")).toBe(
        false,
      );
    });

    it("refuses a global requirement nothing grants at the top", () => {
      expect(grantCoversScope(["core.*:write"], "*:write")).toBe(false);
    });

    it("still covers a wildcard requirement nothing narrows", () => {
      // The other direction matters just as much. Too strict here means a
      // widening read as a narrowing, and a narrowing revokes live tokens.
      expect(grantCoversScope(["*:write"], "core.*:write")).toBe(true);
      expect(grantCoversScope(["*:write", "core.*:write"], "*:write")).toBe(
        true,
      );
      // A deeper entry that is narrower in BREADTH but not in verb does not
      // narrow anything.
      expect(
        grantCoversScope(["core.*:write", "core.media.*:read"], "core.*:read"),
      ).toBe(true);
    });

    it("covers a type by naming it exactly", () => {
      expect(grantCoversScope(["core.note:read"], "core.note:read")).toBe(true);
    });

    it("does not cover a sibling namespace", () => {
      expect(grantCoversScope(["core.*:write"], "jonah.note:read")).toBe(false);
    });
  });

  /**
   * A capability names an administrative surface — issuing credentials,
   * reading the audit log — and the kind exists precisely so that no breadth
   * expression reaches one.
   *
   * **These pin the intent; they are not what stops a regression, and an
   * earlier version of this comment claimed otherwise.** The property is
   * guarded three times over in the code — the verb-less arm, the operation
   * refusal behind it, and the exhaustiveness binding — so deleting any one
   * of them leaves every assertion here green, and deleting the arm itself
   * fails the build rather than a test. That is the right amount of guard
   * and the wrong thing to describe as a test.
   *
   * What they are worth is saying, in one place a person will read, what the
   * answer has to be. Nothing gates on a capability yet: no route consults
   * one and no bundle offers one. So a wrong answer today skips a consent
   * screen for a literal that reaches nothing, and the reason to hold the
   * line now is that the gates arrive later and will inherit whatever this
   * says.
   */
  describe("capabilities, reachable only by name", () => {
    it("covers a capability the grant names", () => {
      expect(grantCoversScope(["space.keys"], "space.keys")).toBe(true);
    });

    it("is not reached by the global write wildcard", () => {
      for (const capability of SPACE_PERMISSIONS) {
        expect(
          grantCoversScope(["*:write", "*:read"], capability),
          capability,
        ).toBe(false);
      }
    });

    it("is not reached by a wildcard shaped like the capability root", () => {
      // Two independent refusals sit behind this, and the assertion cannot
      // tell them apart: the requirement parses as a capability and is turned
      // down before any held scope is read, AND the held literals do not
      // parse at all, so they contribute nothing on any axis either. The
      // second is the one worth stating, because it is not obvious:
      // `space.*:read` satisfies the type-pattern grammar, so without
      // `parseScope` claiming the whole root it would parse as an item-type
      // grant that reads like a capability grant and is neither.
      expect(
        grantCoversScope(["space.*:read", "space.*:write"], "space.keys"),
      ).toBe(false);
    });

    it("does not let one capability cover another", () => {
      expect(grantCoversScope(["space.webhooks"], "space.keys")).toBe(false);
    });

    it("refuses a capability-shaped literal that names no capability", () => {
      // Also a parser property rather than an arm property: the whole root is
      // claimed, so a non-member under it is unparseable and refused before
      // any axis is consulted. Stated because the alternative reading — that
      // the capability arm turned it down — would be wrong about where the
      // guarantee lives.

      expect(grantCoversScope(["*:write"], "space.not_a_thing")).toBe(false);
      expect(grantCoversScope(["space.keys"], "space.not_a_thing")).toBe(false);
    });
  });

  describe("OIDC literals, which have no breadth to compare", () => {
    it("covers a literal the grant names", () => {
      expect(grantCoversScope(["openid", "email"], "openid")).toBe(true);
    });

    it("does not let one literal cover another", () => {
      expect(grantCoversScope(["profile"], "email")).toBe(false);
    });

    it("is not reached by a type wildcard", () => {
      for (const literal of ["openid", "profile", "email", "offline_access"]) {
        expect(grantCoversScope(["*:write"], literal), literal).toBe(false);
      }
    });
  });

  describe("edges, which have their own wildcard axis", () => {
    it("covers a named edge from the edge wildcard", () => {
      expect(grantCoversScope(["edge.*:write"], "edge.parent-of:read")).toBe(
        true,
      );
    });

    it("covers a runtime edge from its namespace wildcard", () => {
      expect(
        grantCoversScope(["edge.user.*:read"], "edge.user.blocks:read"),
      ).toBe(true);
    });

    it("refuses a wildcard requirement that something under it narrows", () => {
      // `resolveEdgePermission` is longest-match precedence, exactly like the
      // item-type resolver, so the edge axis has the same downward blind spot
      // and needs the same answer.
      expect(
        grantCoversScope(
          ["edge.*:write", "edge.user.blocks:read"],
          "edge.user.*:write",
        ),
      ).toBe(false);
    });

    it("does not cross from the item-type axis", () => {
      // `edge` is a claimable publisher handle, so `edge.foo` is a
      // registrable item type — but the scope grammar resolves everything
      // under `edge.` to the edge axis, so the crossing can only be stated
      // from the grant side. A type wildcard reaches no edge, and an edge
      // grant reaches no item type.
      //
      // The first draft asserted the second half with `parent-of:read`,
      // which is not a scope at all: a bare single-segment identifier is
      // not a valid type, so the requirement was refused for being
      // unparseable and the test passed without exercising the axis split.
      expect(grantCoversScope(["*:write"], "edge.parent-of:read")).toBe(false);
      expect(grantCoversScope(["edge.*:write"], "core.note:read")).toBe(false);
    });

    it("covers a read requirement from a write grant on the same edge", () => {
      expect(
        grantCoversScope(["edge.parent-of:write"], "edge.parent-of:read"),
      ).toBe(true);
    });

    it("does not cover a write requirement from a read grant", () => {
      expect(grantCoversScope(["edge.*:read"], "edge.parent-of:write")).toBe(
        false,
      );
    });
  });

  describe("metadata, where the bare form is the wildcard", () => {
    it("covers a sub-resource from the bare namespace grant", () => {
      expect(grantCoversScope(["metadata:write"], "metadata.types:read")).toBe(
        true,
      );
    });

    it("does not reach back up from a sub-resource to the namespace", () => {
      expect(grantCoversScope(["metadata.types:write"], "metadata:read")).toBe(
        false,
      );
    });

    it("does not cross from the item-type axis", () => {
      expect(grantCoversScope(["*:write"], "metadata.types:read")).toBe(false);
      expect(grantCoversScope(["metadata:write"], "core.note:read")).toBe(
        false,
      );
    });

    it("covers a read requirement from a write grant on the same sub-resource", () => {
      expect(
        grantCoversScope(["metadata.types:write"], "metadata.types:read"),
      ).toBe(true);
    });

    it("does not let one sub-resource cover another", () => {
      expect(
        grantCoversScope(["metadata.types:write"], "metadata.edge_types:read"),
      ).toBe(false);
    });
  });

  describe("what it does with a literal it cannot read", () => {
    it("covers an unparseable requirement the grant names verbatim", () => {
      // Both sides carrying a scope this build has stopped understanding is
      // not a narrowing, and reading it as one would revoke live tokens
      // over a grammar change.
      expect(
        grantCoversScope(["from-a-later-build"], "from-a-later-build"),
      ).toBe(true);
    });

    it("refuses an unparseable requirement nothing names", () => {
      // Fail closed: an unrecognized literal waved through here is a
      // consent skip for something nobody granted.
      expect(grantCoversScope(["*:write"], "from-a-later-build")).toBe(false);
    });

    it("ignores an unparseable grant entry rather than throwing", () => {
      expect(
        grantCoversScope(["", "  ", "::", "core.*:read"], "core.note:read"),
      ).toBe(true);
      expect(grantCoversScope(["::"], "core.note:read")).toBe(false);
    });

    it("covers nothing when the grant is empty", () => {
      for (const required of [
        "core.note:read",
        "openid",
        "space.keys",
        "edge.parent-of:read",
        "metadata.types:read",
      ]) {
        expect(grantCoversScope([], required), required).toBe(false);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// The content category
//
// A parent grant over everything whose stored family is not `system`. These
// cases pin the four properties the grammar and the projection have to hold
// on their own, before any screen or bundle offers the literal.
// ---------------------------------------------------------------------------

describe("the content root is claimed whole", () => {
  it("parses the two members and nothing else under the root", () => {
    expect(parseScope("content:read")).toEqual({
      typePattern: "content",
      operation: "read",
      kind: "content",
    });
    expect(parseScope("content:write")).toEqual({
      typePattern: "content",
      operation: "write",
      kind: "content",
    });
  });

  it("refuses a wildcard under the root, which would otherwise be an item-type grant", () => {
    // The shape that carries two readings, and the reason the root is
    // claimed rather than shape-checked. `isValidTypePattern`'s
    // subtree-wildcard branch checks the prefix grammar and never consults
    // the reserved roots — which is why `core.*:read` is a scope the server
    // issues — so the fixture is honest: these patterns are well-formed, and
    // the root claim is the only thing refusing them. Remove it and they
    // parse as `kind: "type"`.
    for (const literal of ["content.*:read", "content.*:write"]) {
      expect(isValidTypePattern(literal.split(":")[0] ?? ""), literal).toBe(
        true,
      );
      expect(parseScope(literal), literal).toBeNull();
    }
  });

  it("refuses a concrete identifier under the root, twice over", () => {
    // Refused by the identifier grammar as well as by the root claim,
    // because `content` is in `RESERVED_ROOTS`. Both gates are asserted
    // rather than only the outcome, so removing either one is visible here.
    for (const literal of ["content.anything:read", "content.note:write"]) {
      expect(isValidTypePattern(literal.split(":")[0] ?? ""), literal).toBe(
        false,
      );
      expect(parseScope(literal), literal).toBeNull();
    }
  });

  it("refuses the bare root and any verb that is not read or write", () => {
    for (const literal of ["content", "content:", "content:none", ":read"]) {
      expect(parseScope(literal), literal).toBeNull();
    }
    // And the claim is what admits the two members, rather than merely
    // disambiguating them: `content` is one segment, and the concrete branch
    // of `isValidTypePattern` requires two, so the generic path would refuse
    // `content:read` outright.
    expect(isValidTypePattern("content")).toBe(false);
  });

  it("leaves a publisher root that merely starts the same way alone", () => {
    // The claim tests the head before the colon, so it cannot swallow a
    // handle that shares a prefix.
    expect(parseScope("contented.note:read")?.kind).toBe("type");
  });

  it("refuses a type registered under the content root", () => {
    // The other half of the claim. Without `content` in `RESERVED_ROOTS` the
    // identifier grammar admits `content.note`, and a registered type would
    // then share its first segment with a grant over the whole category.
    expect(isReservedRoot("content")).toBe(true);
    expect(isValidTypeIdentifier("content.note")).toBe(false);
    expect(isValidTypeIdentifier("content.media.book")).toBe(false);
    // And nobody can claim the word as a publisher handle either, which is
    // what would let a person's types reach the same first segment.
    expect(isValidHandle("content")).toBe(false);
  });
});

describe("the content category projection", () => {
  it("does not reach a system type", () => {
    // The exclusion, over every member of the family-backed set rather than
    // over a sample of it.
    const read = scopesToTypePermissions(["content:read"]);
    const write = scopesToTypePermissions(["content:write"]);
    expect(SYSTEM_TYPE_IDS.size).toBeGreaterThan(0);
    for (const id of SYSTEM_TYPE_IDS) {
      expect(resolveTypePermission(id, read), id).toBe("none");
      expect(resolveTypePermission(id, write), id).toBe("none");
    }
  });

  it("excludes exactly the compiled system set when nothing has seeded a registry", () => {
    // The registry-dependence contract, named. This package resolves against
    // the compiled shipped set wherever no server has booted — a browser
    // bundle, the SDK, this file — and against the seeded set on a server.
    // Both are the intended behavior; what would not be is the projection
    // silently holding a set from before a seed.
    const perms = scopesToTypePermissions(["content:read"]);
    const excluded = Object.entries(perms)
      .filter(([, level]) => level === "none")
      .map(([key]) => key)
      .sort();
    expect(excluded).toEqual([...SYSTEM_TYPE_IDS, "system.*"].sort());
  });

  it("reaches ordinary content, including a type registered later", () => {
    const read = scopesToTypePermissions(["content:read"]);
    expect(resolveTypePermission("core.note", read)).toBe("read");
    expect(resolveTypePermission("readwise.highlight", read)).toBe("read");
    // The whole point: a type nobody has registered yet is covered, because
    // the category is a complement and names no rows.
    expect(resolveTypePermission("acme.not_registered_yet", read)).toBe("read");
    const write = scopesToTypePermissions(["content:write"]);
    expect(resolveTypePermission("core.note", write)).toBe("write");
    expect(resolveTypePermission("acme.not_registered_yet", write)).toBe(
      "write",
    );
  });

  it("never claims a write the reserved-namespace gate refuses", () => {
    // `marfa.*` types are family `integration`, so they are squarely inside
    // the category and their reads are unrestricted. Their writes are refused
    // by the middleware for every credential that is not `is_operator` or a
    // manifest-granted runtime credential, and an OAuth token is neither. A
    // parent that claimed the write would put something on a consent screen
    // that will never work.
    const marfaTypes = [...TYPE_REGISTRY.keys()].filter((id) =>
      id.startsWith("marfa."),
    );
    expect(marfaTypes.length).toBeGreaterThan(0);
    const write = scopesToTypePermissions(["content:write"]);
    const read = scopesToTypePermissions(["content:read"]);
    for (const id of marfaTypes) {
      // The fixture has to be honest: these are in the category, not
      // excluded from it, so the clamp is a level and not an exclusion.
      expect(INTEGRATION_TYPE_IDS.has(id), id).toBe(true);
      expect(resolveTypePermission(id, write), id).toBe("read");
      expect(resolveTypePermission(id, read), id).toBe("read");
    }
  });

  it("lets a literal naming a row win over the category's default for it", () => {
    // Order-independence, and the collision that makes it matter: the shipped
    // read bundle names `system.connection:read`, which the category
    // excludes. Whichever ran last would otherwise decide the answer.
    const forward = scopesToTypePermissions([
      "content:read",
      "system.connection:read",
    ]);
    const reversed = scopesToTypePermissions([
      "system.connection:read",
      "content:read",
    ]);
    expect(resolveTypePermission("system.connection", forward)).toBe("read");
    expect(resolveTypePermission("system.connection", reversed)).toBe("read");
    // And the rest of the system family is untouched by that one literal.
    expect(resolveTypePermission("system.credential", forward)).toBe("none");
  });

  it("resolves the ordered levels, with write covering read", () => {
    const both = scopesToTypePermissions(["content:read", "content:write"]);
    expect(resolveTypePermission("core.note", both)).toBe("write");
    const reversed = scopesToTypePermissions(["content:write", "content:read"]);
    expect(resolveTypePermission("core.note", reversed)).toBe("write");
  });

  it("changes nothing for a scope set holding no content literal", () => {
    expect(
      scopesToTypePermissions(["core.note:read", "core.task:write"]),
    ).toEqual({ "core.note": "read", "core.task": "write" });
    expect(scopesToTypePermissions([])).toEqual({});
  });
});

describe("adding the content category to a wildcard grant can narrow it", () => {
  // Four resolutions, asserted rather than described. The comment on
  // `scopesToTypePermissions` states them as measured fact, and until this
  // block existed nothing held any of them: the tests above cover the
  // projection on its own and never the wildcard-plus-category combination
  // the claim is actually about.
  //
  // The property is that a strictly larger scope set covers strictly less.
  // `resolveTypePermission` puts an exact key ahead of any wildcard, and the
  // category writes exact keys, so the exclusions it projects outrank a
  // wildcard the same grant already holds. Fail-closed in both directions and
  // therefore not an escalation — but a caller substituting a superset is
  // wrong, and this is what says so out loud when somebody tries.

  it("takes a system type from read to none when the category joins `*:read`", () => {
    const wildcardOnly = scopesToTypePermissions(["*:read"]);
    const withCategory = scopesToTypePermissions(["*:read", "content:read"]);
    // The fixture has to be honest about why the second answer is `none`:
    // this id is in the family-backed exclusion set the projection reads.
    expect(SYSTEM_TYPE_IDS.has("system.credential")).toBe(true);
    expect(resolveTypePermission("system.credential", wildcardOnly)).toBe(
      "read",
    );
    expect(resolveTypePermission("system.credential", withCategory)).toBe(
      "none",
    );
  });

  it("clamps an integration type from write to read when the category joins `*:write`", () => {
    const wildcardOnly = scopesToTypePermissions(["*:write"]);
    const withCategory = scopesToTypePermissions(["*:write", "content:write"]);
    // Squarely inside the category rather than excluded from it, which is
    // what makes this a clamp to `read` and not a drop to `none`.
    expect(INTEGRATION_TYPE_IDS.has("marfa.captured_email")).toBe(true);
    expect(resolveTypePermission("marfa.captured_email", wildcardOnly)).toBe(
      "write",
    );
    expect(resolveTypePermission("marfa.captured_email", withCategory)).toBe(
      "read",
    );
  });

  it("flips `grantCoversScope` from true to false across the same pair", () => {
    // The consequence a person meets: a standing grant re-consented alongside
    // the category is asked for again rather than waved through. Coverage is
    // the same projection read through a different door, so it moves with it.
    expect(grantCoversScope(["*:read"], "system.credential:read")).toBe(true);
    expect(
      grantCoversScope(["*:read", "content:read"], "system.credential:read"),
    ).toBe(false);
  });
});

describe("the content category is covered by holding it and by nothing else", () => {
  // One case, two held sets, one assertion each way — the arm decides from
  // the difference between a parent grant and a row grant, so both have to be
  // run through it.
  const everyRow = [
    ...[...TYPE_REGISTRY.keys()].map((id) => `${id}:read`),
    ...[...TYPE_REGISTRY.keys()].map((id) => `${id}:write`),
  ];

  it("is not reached by a grant naming every row", () => {
    expect(everyRow.length).toBeGreaterThan(20);
    expect(grantCoversScope(everyRow, "content:read")).toBe(false);
    expect(grantCoversScope(everyRow, "content:write")).toBe(false);
  });

  it("is not reached by any wildcard", () => {
    for (const held of ["*:write", "*:read", "core.*:write"]) {
      expect(grantCoversScope([held], "content:read"), held).toBe(false);
      expect(grantCoversScope([held], "content:write"), held).toBe(false);
    }
  });

  it("is reached by holding it, at or above the level asked about", () => {
    expect(grantCoversScope(["content:read"], "content:read")).toBe(true);
    expect(grantCoversScope(["content:read"], "content:write")).toBe(false);
    expect(grantCoversScope(["content:write"], "content:read")).toBe(true);
    expect(grantCoversScope(["content:write"], "content:write")).toBe(true);
  });

  it("still lets a row grant grant exactly its rows", () => {
    expect(grantCoversScope(everyRow, "core.note:write")).toBe(true);
    expect(grantCoversScope(everyRow, "acme.registered_later:read")).toBe(
      false,
    );
  });

  it("still reaches a capability only by naming it", () => {
    expect(grantCoversScope(["content:write"], "space.webhooks")).toBe(false);
    expect(grantCoversScope(["space.webhooks"], "space.webhooks")).toBe(true);
  });

  it("covers a named type forward, through the type arm and no new code", () => {
    // The direction with no arm of its own: the category projects to the
    // global wildcard and `resolveTypePermission` takes it from there.
    expect(grantCoversScope(["content:read"], "core.note:read")).toBe(true);
    expect(grantCoversScope(["content:read"], "core.note:write")).toBe(false);
    expect(grantCoversScope(["content:write"], "core.note:write")).toBe(true);
    // Including a type registered after the grant was made, which is the
    // whole reason the category exists.
    expect(grantCoversScope(["content:read"], "acme.shipped_later:read")).toBe(
      true,
    );
    // And not into the system family.
    expect(grantCoversScope(["content:write"], "system.credential:read")).toBe(
      false,
    );
    // Nor a `marfa.*` write, matching the clamp.
    expect(
      grantCoversScope(["content:write"], "marfa.podcast.show:write"),
    ).toBe(false);
    expect(grantCoversScope(["content:write"], "marfa.podcast.show:read")).toBe(
      true,
    );
  });
});

describe("requiresExplicitConsent", () => {
  it("is true for every capability, because one is granted by being named", () => {
    for (const literal of SPACE_PERMISSIONS) {
      expect(requiresExplicitConsent(literal), literal).toBe(true);
    }
  });

  it("is false for everything a surface may offer pre-ticked", () => {
    // The families a bundle's `default_on` genuinely governs, plus the two
    // hidden mechanisms. None of these is administrative authority a role
    // would otherwise hand over unnamed, so none of them needs this rule.
    for (const literal of [
      "openid",
      "offline_access",
      "profile",
      "profile:read",
      "core.note:read",
      "*:write",
      "edge.parent-of:write",
      "metadata:read",
      "metadata.types:write",
      "content:read",
    ]) {
      expect(requiresExplicitConsent(literal), literal).toBe(false);
    }
  });

  it("answers false for a literal the grammar does not recognize", () => {
    // A guard rather than a throw: the surfaces reading this ask it of
    // whatever a client sent, and a malformed literal is refused a step
    // earlier by `isValidScope`. Answering true here would make a typo
    // un-grantable-by-silence rather than refused, which reads as the rule
    // working while the real check is the one that fired.
    expect(requiresExplicitConsent("space.not_a_real_one")).toBe(false);
    expect(requiresExplicitConsent("")).toBe(false);
  });
});
