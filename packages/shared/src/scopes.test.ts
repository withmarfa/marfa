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
  CAPABILITY_ROOT,
  CAPABILITY_SCOPES,
  hasCapability,
} from "./scopes.js";
import type { ParsedScope, PermissionBundle } from "./scopes.js";
import {
  isValidHandle,
  isValidTypeIdentifier,
  isValidTypePattern,
} from "./validation.js";
import { isReservedRoot } from "./type-registry.js";

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
// Capability scopes
// ---------------------------------------------------------------------------

describe("capability scopes", () => {
  for (const literal of CAPABILITY_SCOPES) {
    it(`parses ${literal}`, () => {
      expect(parseScope(literal)).toEqual({
        typePattern: literal,
        operation: "none",
        kind: "capability",
        capability: literal,
      });
      expect(isValidScope(literal)).toBe(true);
    });
  }

  it("carries no verb, and that is pinned rather than incidental", () => {
    // Verb-lessness is a property of the literal, not of the parser: the
    // prefix claim in `parseScope` is what refuses `capability.webhooks:read`,
    // and it would go on refusing it if a member of this set grew a colon.
    // The member would then be unparseable and the grant silently dead, so
    // the shape of the set is the thing to hold.
    for (const literal of CAPABILITY_SCOPES) {
      expect(literal).not.toContain(":");
      expect(parseScope(literal)?.operation).toBe("none");
    }
  });

  it("is granted by naming it, and by nothing else", () => {
    // `hasCapability` exists because the neighbouring helper answered this
    // question backwards. `*:write` is the full-access path the consent
    // screen offers under Customize, and a pattern match admitted it against
    // anything type-shaped, so the wrong tool said yes to a token holding no
    // capability at all. These two assertions are the pair that catches it.
    expect(hasCapability(["*:write"], "capability.item_purge")).toBe(false);
    expect(hasCapability(["*:read"], "capability.webhooks")).toBe(false);
    expect(hasCapability(["capability.webhooks"], "capability.webhooks")).toBe(
      true,
    );
    // Holding every other capability implies nothing about this one.
    const others = CAPABILITY_SCOPES.filter((c) => c !== "capability.keys");
    expect(hasCapability(others, "capability.keys")).toBe(false);
    expect(hasCapability([], "capability.keys")).toBe(false);
  });

  it("refuses to answer a capability question through scopeCovers", () => {
    // The wrong tool must not answer yes. A capability is never a point on
    // the item-type axis, so the category error answers false rather than
    // matching a wildcard.
    expect(scopeCovers(["*:read"], "capability.webhooks", "read")).toBe(false);
    expect(scopeCovers(["*:write"], "capability.item_purge", "write")).toBe(
      false,
    );
    expect(scopeCovers(["*:write"], "capability", "write")).toBe(false);
    // And it still answers ordinary type questions the same way.
    expect(scopeCovers(["*:write"], "core.note", "write")).toBe(true);
  });

  it("keeps every capability out of the one that would escalate it", () => {
    // The two boundaries in the set that a reader is most likely to want to
    // collapse, pinned so collapsing one is a test failure rather than a
    // judgement call made again from scratch. Managing this app's own keys
    // must not carry the power to revoke every other app's access, and
    // configuring a connection must not carry the credential behind it.
    const keys = ["capability.keys"];
    expect(hasCapability(keys, "capability.app_grants")).toBe(false);
    const connections = ["capability.connections"];
    expect(hasCapability(connections, "capability.credentials")).toBe(false);
    // And reading how full a space is must not carry rewriting its policy.
    const usage = ["capability.space_usage"];
    expect(hasCapability(usage, "capability.space_settings")).toBe(false);
  });

  it("names one surface per admin gate, so consent reads as sentences", () => {
    // A set that has quietly become one entry is the failure this guards:
    // the whole point is that a person grants webhooks without granting
    // credentials. The count is the cheapest statement of that.
    expect(new Set(CAPABILITY_SCOPES).size).toBe(CAPABILITY_SCOPES.length);
    expect(CAPABILITY_SCOPES.length).toBe(10);
  });

  it("claims its whole namespace, members or nothing", () => {
    // A near-miss must not degrade into some other family's grant. Each of
    // these is refused for a different reason worth pinning:
    // an unknown surface, a verb the grammar does not carry here, the bare
    // root, and the wildcard that `isValidTypePattern` would otherwise
    // accept as an item-type pattern.
    expect(parseScope("capability.everything")).toBeNull();
    // The name the previous draft of this set used. A retired member has to
    // fail rather than linger as a literal nothing enforces.
    expect(parseScope("capability.types")).toBeNull();
    expect(parseScope("capability.webhooks:read")).toBeNull();
    expect(parseScope("capability.webhooks:write")).toBeNull();
    expect(parseScope("capability")).toBeNull();
    expect(parseScope("capability.*")).toBeNull();
    expect(parseScope("capability.*:read")).toBeNull();
    expect(parseScope("capability.")).toBeNull();
    expect(parseScope("Capability.webhooks")).toBeNull();
    expect(parseScope("capability.web hooks")).toBeNull();
  });

  it("does not admit a near-miss on the item-type axis either", () => {
    // The refusal above is only worth anything if nothing downstream
    // reinstates the literal. `capability.*:read` is the one that matters:
    // parsed as an item-type pattern it would resolve against the live
    // registry rather than naming a capability at all.
    expect(scopesToTypePermissions(["capability.*:read"])).toEqual({});
    expect(
      scopeCovers(["capability.*:read"], "capability.webhooks", "read"),
    ).toBe(false);
  });

  for (const literal of CAPABILITY_SCOPES) {
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
      "capability.webhooks",
      "capability.keys",
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
        ["capability.webhooks", "core.media.*:read"],
        ["core.media", "core.media.book"],
      ),
    ).toEqual([
      "capability.webhooks",
      "core.media:read",
      "core.media.book:read",
    ]);
  });

  it("keeps the root out of the type grammar", () => {
    // The reservation is what stops a publisher registering a type whose
    // identifier is a capability literal. Without it the grant and the type
    // would be the same string with two meanings.
    expect(isReservedRoot(CAPABILITY_ROOT)).toBe(true);
    for (const literal of CAPABILITY_SCOPES) {
      expect(isValidTypeIdentifier(literal)).toBe(false);
      expect(isValidTypePattern(literal)).toBe(false);
    }
    expect(isValidTypeIdentifier("capability.anything")).toBe(false);
    expect(isValidHandle(CAPABILITY_ROOT)).toBe(false);
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

// ---------------------------------------------------------------------------
// A scope reaches the item-type axis because it was identified as a type
// scope, never because it was not identified as anything else.
//
// The two projections onto that axis used to name the families they skip.
// That reads the same as the rule on today's union and inverts on tomorrow's:
// a family nobody adds to the list falls through to "must be an item type",
// and being treated as one means having the pattern matched against the live
// type registry, where a `*` anywhere in it reaches every registered type.
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
    capability: "capability.webhooks",
  };

  const kinds = Object.keys(LITERAL_BY_KIND) as ParsedScope["kind"][];

  for (const kind of kinds) {
    const literal = LITERAL_BY_KIND[kind];
    const isType = kind === "type";

    it(`parses ${literal} as kind=${kind}`, () => {
      // The fixture has to be honest or the two cases below prove nothing.
      expect(parseScope(literal)?.kind).toBe(kind);
    });

    it(`${isType ? "admits" : "refuses"} ${literal} in type_permissions`, () => {
      const admitted = Object.keys(scopesToTypePermissions([literal]));
      expect(admitted.length > 0).toBe(isType);
    });

    it(`${isType ? "lets" : "stops"} ${literal} satisfy an item-type requirement`, () => {
      // The requirement is the scope's own pattern, so a bare
      // `typeMatchesPattern` would match it. Whether it is refused is then
      // down to the kind and nothing else, which is the property under test.
      const pattern = parseScope(literal)?.typePattern ?? "";
      expect(scopeCovers([literal], pattern, "read")).toBe(isType);
    });

    it(`the two projections agree about ${kind} scopes`, () => {
      // One predicate answers for both, so they cannot drift apart the way
      // two hand-maintained skip lists could.
      const pattern = parseScope(literal)?.typePattern ?? "";
      expect(scopeCovers([literal], pattern, "read")).toBe(
        Object.keys(scopesToTypePermissions([literal])).length > 0,
      );
    });
  }

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
