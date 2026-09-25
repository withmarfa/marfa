import { describe, it, expect, vi } from "vitest";
import {
  expandBundlesToScopes,
  isPermission,
  TYPE_REGISTRY,
  EDGE_TYPE_REGISTRY,
  parseScope,
} from "@withmarfa/shared";
import {
  buildAllowedScopes,
  requestableNamespaceRoots,
} from "./oauth-provider.js";
import {
  DEFAULT_PERMISSION_BUNDLES,
  loadPermissionBundles,
} from "../config.js";

describe("buildAllowedScopes", () => {
  it("includes the global type wildcards (Customize full-access path)", () => {
    const scopes = buildAllowedScopes(DEFAULT_PERMISSION_BUNDLES);
    expect(scopes).toContain("*:read");
    expect(scopes).toContain("*:write");
  });

  it("includes the content category's two literals", () => {
    const scopes = buildAllowedScopes(DEFAULT_PERMISSION_BUNDLES);
    expect(scopes).toContain("content:read");
    expect(scopes).toContain("content:write");
  });

  it("includes the metadata.edge_types sub-resource scopes", () => {
    const scopes = buildAllowedScopes(DEFAULT_PERMISSION_BUNDLES);
    expect(scopes).toContain("metadata.edge_types:read");
    expect(scopes).toContain("metadata.edge_types:write");
  });

  it("includes every scope referenced by the configured bundles", () => {
    const scopes = new Set(buildAllowedScopes(DEFAULT_PERMISSION_BUNDLES));
    for (const s of expandBundlesToScopes(DEFAULT_PERMISSION_BUNDLES)) {
      expect(scopes.has(s)).toBe(true);
    }
    // The namespace wildcards an app needs for its runtime user.* types.
    expect(scopes.has("user.*:read")).toBe(true);
    expect(scopes.has("user.*:write")).toBe(true);
  });

  it("offers a namespace wildcard for custom edge types, which are never enumerable", () => {
    // A custom edge type is registered at runtime, so it cannot be in this
    // set and cannot be named concretely in a grant. Without a namespace
    // wildcard the only expressible scope for a runtime-registered
    // relation edge is the global `edge.*`, so an app asking narrowly is
    // silently narrowed to nothing while an app asking for everything
    // works — the exact inversion of what scopes are for.
    const scopes = new Set(buildAllowedScopes(DEFAULT_PERMISSION_BUNDLES));
    expect(scopes.has("edge.user.*:read")).toBe(true);
    expect(scopes.has("edge.user.*:write")).toBe(true);
    expect(scopes.has("edge.app.*:write")).toBe(true);
  });

  it("offers the same namespaces for edges as for item types", () => {
    // The two halves drifted once: item types gained the runtime
    // namespaces and edge types were left with concrete core ids plus the
    // global wildcard.
    const scopes = new Set(buildAllowedScopes(DEFAULT_PERMISSION_BUNDLES));
    const itemNamespaces = [...scopes]
      .filter((s) => /^[a-z]+\.\*:write$/.test(s))
      .map((s) => s.slice(0, s.indexOf(".")))
      // `core` enumerates its members, so it needs no wildcard twin, and
      // `edge` is the edge half's own prefix rather than a namespace in it.
      .filter((ns) => ns !== "core" && ns !== "edge");
    expect(itemNamespaces.length).toBeGreaterThan(0);
    for (const ns of itemNamespaces) {
      expect(scopes.has(`edge.${ns}.*:write`)).toBe(true);
      expect(scopes.has(`edge.${ns}.*:read`)).toBe(true);
    }
  });

  it("still enumerates concrete registry + OIDC scopes", () => {
    const scopes = buildAllowedScopes(DEFAULT_PERMISSION_BUNDLES);
    expect(scopes).toContain("core.note:read");
    expect(scopes).toContain("edge.*:write");
    expect(scopes).toContain("openid");
  });

  it("admits runtime namespace roots for items and edges alike", () => {
    // The roots boot installs from the types table. Admission is what lets
    // a publisher-handle scope survive the authorize narrowing at all — without it the request is
    // silently stripped before consent and the capability is inert.
    const scopes = new Set(
      buildAllowedScopes(DEFAULT_PERMISSION_BUNDLES, ["acme"]),
    );
    expect(scopes.has("acme.*:read")).toBe(true);
    expect(scopes.has("acme.*:write")).toBe(true);
    expect(scopes.has("edge.acme.*:read")).toBe(true);
    expect(scopes.has("edge.acme.*:write")).toBe(true);
  });

  it("keeps runtime roots out of the enumeration when told to", () => {
    // The advertised discovery metadata is built with an explicit empty
    // root set: the acceptance set carries the runtime roots, the public
    // document must not — an unauthenticated reader learning this
    // instance's namespace names would be a disclosure.
    const scopes = new Set(buildAllowedScopes(DEFAULT_PERMISSION_BUNDLES, []));
    expect(scopes.has("acme.*:read")).toBe(false);
    expect(scopes.has("edge.acme.*:read")).toBe(false);
  });
});

describe("a bundle is not a way around the scope grammar", () => {
  // Every other literal in the allowlist is assembled here from a registry
  // key, so it is well-formed by construction. Bundle scopes are the one
  // input that is not: the operator override parses arbitrary JSON. A
  // malformed literal admitted from it would be requestable, survive the
  // authorize narrowing, and land in a token as a grant no permission map
  // will ever carry and no route will ever check.
  const bundleOf = (scopes: string[]) => [
    {
      id: "operator",
      label: "Operator override",
      description: "",
      default_on: true,
      scopes,
    },
  ];

  it("drops a malformed literal instead of admitting it", () => {
    const scopes = new Set(
      buildAllowedScopes(bundleOf(["core.note:destroy"]), []),
    );
    expect(scopes.has("core.note:destroy")).toBe(false);
  });

  it("drops a near-miss under a reserved prefix", () => {
    // Two near misses under claimed roots. `webhooks.manage:write` reads as
    // a permission grant and is not one — a permission is named by its
    // literal and carries no verb. `space.*:read` is under the root kept
    // reserved after its family was renamed away, and the parser has to
    // claim it too: reserved alone would leave it parsing as an item-type
    // pattern over a namespace no type may ever occupy.
    const scopes = new Set(
      buildAllowedScopes(
        bundleOf(["space.webhook", "webhooks.manage:write", "space.*:read"]),
        [],
      ),
    );
    expect(scopes.has("space.webhook")).toBe(false);
    expect(scopes.has("webhooks.manage:write")).toBe(false);
    expect(scopes.has("space.*:read")).toBe(false);
  });

  it("keeps the valid scopes of a bundle that also carries a bad one", () => {
    // Refusing the whole bundle would take a working consent screen down
    // over one typo. The literal is what is refused, not the bundle.
    const scopes = new Set(
      buildAllowedScopes(bundleOf(["core.note:read", "core.note:destroy"]), []),
    );
    expect(scopes.has("core.note:read")).toBe(true);
    expect(scopes.has("core.note:destroy")).toBe(false);
  });

  it("admits every literal the shipped bundles name", () => {
    // The check has to discriminate rather than merely refuse: a validity
    // gate that also dropped the defaults would be an outage.
    const scopes = new Set(buildAllowedScopes(DEFAULT_PERMISSION_BUNDLES));
    const shipped = expandBundlesToScopes(DEFAULT_PERMISSION_BUNDLES);
    // Without this the loop below is vacuous, and it would stay green on the
    // day the bundles derived to nothing — which is the failure it is here
    // to catch, since that is what a broken derivation looks like.
    expect(shipped.length).toBeGreaterThan(20);
    for (const s of shipped) {
      expect(scopes.has(s)).toBe(true);
    }
  });
});

describe("permission bundles bind to the type registry", () => {
  // Asserting the bundles against `buildAllowedScopes` cannot fail: the
  // builder unions the bundle scopes into the set it returns, so the
  // obvious guard is true by construction. It was true on the day a bundle
  // naming a deleted type took sign-in down for every client. This
  // resolves each bundle scope against the registries themselves instead.
  const NON_TYPE_LITERALS = new Set([
    "openid",
    "profile",
    "email",
    "offline_access",
    "metadata:read",
    "metadata:write",
    "metadata.types:read",
    "metadata.types:write",
    "metadata.edge_types:read",
    "metadata.edge_types:write",
  ]);
  const runtimeNamespaces = new Set<string>(
    requestableNamespaceRoots().map((ns) => `${ns}.`),
  );

  it("names only types and edge types that exist", () => {
    const unresolved: string[] = [];
    for (const literal of expandBundlesToScopes(DEFAULT_PERMISSION_BUNDLES)) {
      if (NON_TYPE_LITERALS.has(literal)) continue;
      // A permission names no type, and `split(":")` makes it its own
      // pattern: the literal carries no colon, so the whole string survives
      // and falls through to a registry lookup that can never succeed now
      // the root is reserved. The day a bundle names one, a correct config
      // would be reported here as a deleted type. Asked of the parser rather
      // than of the characters, like everything else that classifies a scope.
      if (isPermission(literal)) continue;
      // The profile family names the account's own record, a reserved root
      // no registered type can occupy, so the registry has nothing to say
      // about it; the parser owns that family and is asked here as well.
      if (parseScope(literal)?.kind === "profile") continue;
      const pattern = literal.split(":")[0] ?? "";
      // A wildcard names a namespace rather than a member, so it resolves
      // when anything in the registry sits under it — or when it is one of
      // the runtime namespaces the registry deliberately never enumerates.
      if (pattern === "*") continue;
      if (pattern.startsWith("edge.")) {
        const edgePattern = pattern.slice("edge.".length);
        if (edgePattern.endsWith("*")) continue;
        if (!EDGE_TYPE_REGISTRY.has(edgePattern)) unresolved.push(literal);
        continue;
      }
      if (pattern.endsWith("*")) {
        const prefix = pattern.slice(0, -1);
        const known = [...TYPE_REGISTRY.keys()].some((t) =>
          t.startsWith(prefix),
        );
        if (!known && !runtimeNamespaces.has(prefix)) unresolved.push(literal);
        continue;
      }
      if (!TYPE_REGISTRY.has(pattern)) unresolved.push(literal);
    }
    expect(unresolved).toEqual([]);
  });

  it("fails when a bundle names a type the registry does not have", () => {
    // The guard above is only worth having if it discriminates, so this
    // drives the exact data condition that caused the outage: a bundle
    // referencing a type that has been deleted from the registry.
    const stale = [
      {
        id: "stale",
        label: "Stale",
        description: "A bundle naming a type the registry no longer has",
        default_on: false,
        scopes: ["core.media.podcast:read"],
      },
    ];
    const unresolved = expandBundlesToScopes(stale).filter((literal) => {
      const pattern = literal.split(":")[0] ?? "";
      return !TYPE_REGISTRY.has(pattern);
    });
    expect(unresolved).toEqual(["core.media.podcast:read"]);
  });
});

describe("loadPermissionBundles", () => {
  it("returns the defaults when unset", () => {
    expect(loadPermissionBundles(undefined)).toBe(DEFAULT_PERMISSION_BUNDLES);
  });

  it("falls back to defaults on malformed JSON", () => {
    expect(loadPermissionBundles("{not json")).toBe(DEFAULT_PERMISSION_BUNDLES);
  });

  it("falls back to defaults on a non-array payload", () => {
    expect(loadPermissionBundles('{"id":"x"}')).toBe(
      DEFAULT_PERMISSION_BUNDLES,
    );
  });

  it("falls back to defaults when an entry is malformed", () => {
    expect(loadPermissionBundles('[{"label":"no id or scopes"}]')).toBe(
      DEFAULT_PERMISSION_BUNDLES,
    );
  });

  it("accepts a valid override array", () => {
    const raw = JSON.stringify([
      {
        id: "x",
        label: "X",
        description: "",
        scopes: ["core.note:read"],
        default_on: true,
      },
    ]);
    const out = loadPermissionBundles(raw);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("x");
  });

  // `default_on` decides whether a bundle's toggles start ticked, so an
  // override that omits it is not a bundle with a sensible default: it is a
  // bundle whose grant behavior nobody stated. The field is required on
  // `PermissionBundle`, and an override is JSON the type system never
  // checks, so the predicate has to.
  it("refuses an entry that omits default_on", () => {
    const raw = JSON.stringify([
      { id: "x", label: "X", description: "", scopes: ["core.note:read"] },
    ]);
    expect(loadPermissionBundles(raw)).toBe(DEFAULT_PERMISSION_BUNDLES);
  });

  it("refuses an entry whose default_on is not a boolean", () => {
    // The JSON shapes a hand-edited env var actually produces. `"false"` is
    // the one that matters: a truthy string, so a coercing reader would have
    // turned an operator's explicit off into an on.
    for (const value of ['"false"', '"true"', "0", "1", "null"]) {
      const raw = `[{"id":"x","label":"X","description":"","scopes":["core.note:read"],"default_on":${value}}]`;
      expect(loadPermissionBundles(raw)).toBe(DEFAULT_PERMISSION_BUNDLES);
    }
  });

  it("accepts default_on: false, which is the point of checking it", () => {
    const raw = JSON.stringify([
      {
        id: "x",
        label: "X",
        description: "",
        scopes: ["core.note:read"],
        default_on: false,
      },
    ]);
    const out = loadPermissionBundles(raw);
    expect(out).toHaveLength(1);
    expect(out[0]?.default_on).toBe(false);
  });

  it("names the offending entries so an operator can find them", () => {
    // A rejected override reverts the instance to the shipped bundles, and
    // the operator's next signal is otherwise a consent screen that does not
    // offer what they configured, with nothing pointing at the variable.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      loadPermissionBundles(
        JSON.stringify([
          {
            id: "good",
            label: "",
            description: "",
            scopes: [],
            default_on: true,
          },
          { id: "bad-one", label: "", description: "", scopes: [] },
          { label: "no id", description: "", scopes: [] },
        ]),
      );
      const message = spy.mock.calls.map((c) => String(c[0])).join(" ");
      expect(message).toContain("bad-one");
      // The entry with no id is found by position, since it has no name.
      expect(message).toContain("index 2");
      expect(message).not.toContain("good");
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses the whole override when one entry is missing the field", () => {
    // Whole-array, matching the shape the other malformed cases already
    // take. A half-applied bundle set is a consent screen nobody described.
    const raw = JSON.stringify([
      {
        id: "good",
        label: "Good",
        description: "",
        scopes: ["core.note:read"],
        default_on: true,
      },
      { id: "bad", label: "Bad", description: "", scopes: ["core.task:read"] },
    ]);
    expect(loadPermissionBundles(raw)).toBe(DEFAULT_PERMISSION_BUNDLES);
  });
});

describe("DEFAULT_PERMISSION_BUNDLES", () => {
  it("ships the expected bundles, all default-on", () => {
    expect(DEFAULT_PERMISSION_BUNDLES.map((b) => b.id)).toEqual([
      "read",
      "write",
      "custom",
      "profile",
    ]);
    expect(DEFAULT_PERMISSION_BUNDLES.every((b) => b.default_on)).toBe(true);
  });

  it("covers user-defined types through the user.* wildcards, nothing wider", () => {
    // Runtime types cannot be enumerated at request time, so the custom
    // bundle carries the narrowest wildcard that reaches them — never the
    // bare `*`, which would fold system internals into the default grant.
    const custom = DEFAULT_PERMISSION_BUNDLES.find((b) => b.id === "custom");
    expect(custom?.scopes).toEqual(["user.*:read", "user.*:write"]);
  });

  it("covers every shipped content type across read and write", () => {
    // The consent screen's plain-language options have to cover everything
    // a person has: a shipped type outside every bundle is unreachable from
    // the default grant, and this is what catches the next one added. The
    // build ships only `core.*` and `system.*`, so a type under any other
    // root fails here until a bundle is decided for it.
    const read = DEFAULT_PERMISSION_BUNDLES.find((b) => b.id === "read");
    const write = DEFAULT_PERMISSION_BUNDLES.find((b) => b.id === "write");
    for (const [id] of TYPE_REGISTRY) {
      if (id.startsWith("system.")) continue;
      expect(id.startsWith("core."), `${id} is in no bundle`).toBe(true);
      expect(read?.scopes, `read misses ${id}`).toContain(`${id}:read`);
      expect(write?.scopes, `write misses ${id}`).toContain(`${id}:write`);
    }
  });

  it("requests concrete per-type content scopes, never a core.* wildcard", () => {
    // Concrete scopes are what makes per-type narrowing enforceable — the
    // OAuth provider only lets a grant narrow to literally-requested scopes.
    const read = DEFAULT_PERMISSION_BUNDLES.find((b) => b.id === "read");
    const write = DEFAULT_PERMISSION_BUNDLES.find((b) => b.id === "write");
    expect(read?.scopes).toContain("core.note:read");
    expect(write?.scopes).toContain("core.note:write");
    for (const b of [read, write]) {
      expect(b?.scopes.some((s) => s.includes("*"))).toBe(false);
    }
  });

  it("keeps system.* out of write; read touches only system.connection", () => {
    const write = DEFAULT_PERMISSION_BUNDLES.find((b) => b.id === "write");
    expect(write?.scopes.some((s) => s.startsWith("system."))).toBe(false);
    // "Connections" folds system.connection:read into the read bundle;
    // it's the only system.* scope in the default grant.
    const read = DEFAULT_PERMISSION_BUNDLES.find((b) => b.id === "read");
    const readSystem =
      read?.scopes.filter((s) => s.startsWith("system.")) ?? [];
    expect(readSystem).toEqual(["system.connection:read"]);
  });
});
