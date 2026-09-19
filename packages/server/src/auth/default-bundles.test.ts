import { describe, expect, it } from "vitest";
import { TYPE_REGISTRY, classifyNamespace } from "@withmarfa/shared";
import {
  buildDefaultPermissionBundles,
  deriveRequestableNamespaceRoots,
  resolveAllRegisteredNamespaceRoots,
  resolveRegisteredNamespaceRoots,
} from "./default-bundles.js";
import { createTestContext, request } from "../test-utils.js";

function bundle(id: string) {
  const found = buildDefaultPermissionBundles().find((b) => b.id === id);
  if (!found) throw new Error(`no bundle ${id}`);
  return found;
}

describe("default permission bundles derive from the registry", () => {
  // The inverse of the old coverage test: instead of asserting every id
  // appears in a hand-written list, the derivation makes membership true by
  // construction, and this suite pins the construction's family rules.
  it("derivation is total — every registry type lands in its family bundle", () => {
    const read = new Set(bundle("read").scopes);
    const write = new Set(bundle("write").scopes);
    const connected = new Set(bundle("connected").scopes);
    for (const id of TYPE_REGISTRY.keys()) {
      const tier = classifyNamespace(id);
      if (tier === "core") {
        expect(read.has(`${id}:read`), `read misses ${id}`).toBe(true);
        expect(write.has(`${id}:write`), `write misses ${id}`).toBe(true);
      } else if (tier === "system") {
        expect(write.has(`${id}:write`), `write leaks ${id}`).toBe(false);
        expect(connected.has(`${id}:read`), `connected leaks ${id}`).toBe(
          false,
        );
      } else {
        expect(connected.has(`${id}:read`), `connected misses ${id}`).toBe(
          true,
        );
        expect(
          connected.has(`${id}:write`),
          `connected must be read-only`,
        ).toBe(false);
      }
    }
  });

  it("the profile bundle carries the OIDC literals and the category's read, never its write", () => {
    // Read rides with the claims because showing a person to themselves is
    // what every app asking for `profile` is doing; write is administrative
    // authority over the profile and is asked for by name.
    expect(bundle("profile").scopes).toEqual([
      "openid",
      "profile",
      "email",
      "profile:read",
    ]);
    expect(bundle("profile").default_on).toBe(true);
    // The description travels in the discovery document beside the scope
    // list, so a client renders it verbatim; it names the whole read surface.
    expect(bundle("profile").description).toBe(
      "Your name, picture, email address, username, bio and timezone.",
    );
  });

  it("admits exactly one system scope: the connections toggle, read-only", () => {
    const systemScopes = buildDefaultPermissionBundles()
      .flatMap((b) => b.scopes)
      .filter((s) => s.startsWith("system."));
    expect(systemScopes).toEqual(["system.connection:read"]);
  });

  it("derives the requestable namespace roots from the registry", () => {
    const roots = deriveRequestableNamespaceRoots();
    expect(roots).toContain("user");
    expect(roots).toContain("app");
    for (const id of TYPE_REGISTRY.keys()) {
      if (classifyNamespace(id) === "publisher") {
        expect(roots).toContain(id.split(".")[0]);
      }
    }
    // Nothing beyond user, app, and the registry's own publisher roots.
    const publisherRoots = new Set(
      [...TYPE_REGISTRY.keys()]
        .filter((id) => classifyNamespace(id) === "publisher")
        .map((id) => id.split(".")[0]),
    );
    for (const root of roots) {
      if (root === "user" || root === "app") continue;
      expect(publisherRoots.has(root), `unexpected root ${root}`).toBe(true);
    }
  });

  it("covers user.* alone when no runtime namespaces are supplied", () => {
    expect(bundle("custom").scopes).toEqual(["user.*:read", "user.*:write"]);
  });

  it("extends the custom bundle with runtime handle namespaces", () => {
    const custom = buildDefaultPermissionBundles({
      own: [
        "acme",
        "google", // registry root — connected already covers it concretely
        "user", // structural — never duplicated
        "core", // reserved — cannot hold a custom type, filtered as a belt
      ],
    }).find((b) => b.id === "custom");
    expect(custom?.scopes).toEqual([
      "user.*:read",
      "user.*:write",
      "acme.*:read",
      "acme.*:write",
    ]);
  });
});

describe("runtime custom-namespace resolution", () => {
  it("returns the publisher roots of registered custom types, nothing else", async () => {
    const ctx = await createTestContext();
    try {
      const baseType = {
        version: 1,
        fields: { name: { type: "string", required: true } },
      };
      for (const id of ["acme.gadget", "acme.widget", "user.recipe"]) {
        const res = await request(ctx.app, "POST", "/types", {
          key: ctx.workingKey,
          body: { id, ...baseType },
        });
        expect(res.status).toBe(201);
      }
      const roots = await resolveRegisteredNamespaceRoots(ctx.storage);
      expect(roots.own).toEqual(["acme"]);
    } finally {
      await ctx.cleanup();
    }
  });

  it("offers the person's own roots and not a connected service's", async () => {
    // The distinction the identifier cannot make. Both ids are
    // publisher-tier by prefix, so the tier test admits each of them; only
    // the stored origin says one arrived with an integration.
    //
    // It matters because these roots become a wildcard in the default
    // grant, under a heading about the person's own types. A type a
    // connected service published is stored beside their own and is not
    // theirs to be offered wholesale — it belongs to the service, and the service's
    // own scopes are how it is reached.
    const ctx = await createTestContext({});
    try {
      const baseType = {
        version: 1,
        fields: { name: { type: "string", required: true } },
      } as const;
      await ctx.storage.types.create(
        { id: "jonah.reading_item", ...baseType },
        { origin: "user" },
      );
      await ctx.storage.types.create(
        { id: "acme.widget", ...baseType },
        {
          origin: "integration",
          family: "integration",
          owner_integration: "acme/widgets",
        },
      );

      const roots = await resolveRegisteredNamespaceRoots(ctx.storage);
      expect(roots.own).toEqual(["jonah"]);
      expect(roots.connected).toEqual(["acme"]);

      // And both are offered, differently. Dropping the service's root
      // from the person's bundle without putting it anywhere would leave
      // its types in no default bundle at all, including the one named
      // for them — a narrowing in appearance and an omission in fact.
      const bundles = buildDefaultPermissionBundles(roots);
      const scopesOf = (id: string) =>
        bundles.find((b) => b.id === id)?.scopes ?? [];
      expect(scopesOf("custom")).toContain("jonah.*:read");
      expect(scopesOf("custom")).toContain("jonah.*:write");
      expect(scopesOf("custom")).not.toContain("acme.*:read");
      expect(scopesOf("custom")).not.toContain("acme.*:write");
      expect(scopesOf("connected")).toContain("acme.*:read");
      // Read-only: a mirror of an upstream record, and a third-party
      // write forks it.
      expect(scopesOf("connected")).not.toContain("acme.*:write");

      // The allowlist is a different question and keeps both: a scope
      // outside it cannot be granted at all, so the integration's own
      // types have to be in it for the integration to reach them.
      expect(await resolveAllRegisteredNamespaceRoots(ctx.storage)).toEqual([
        "acme",
        "jonah",
      ]);
    } finally {
      await ctx.cleanup();
    }
  });
});

describe("a type whose provenance nobody recorded", () => {
  const baseType = {
    version: 1,
    fields: { name: { type: "string", required: true } },
  } as const;

  it("is offered read-only rather than dropped or written", async () => {
    // The case an archive taken before archives carried provenance
    // produces. Two wrong answers were both considered and rejected:
    // treating it as the person's own gives a read-and-write wildcard
    // over what may be a connected service's mirror, and dropping it
    // leaves a legitimate restore of your own types in no bundle at all,
    // ungrantable to any application.
    const ctx = await createTestContext({});
    try {
      await ctx.storage.types.create(
        { id: "salvage.record", ...baseType },
        { origin: "unknown" },
      );

      const roots = await resolveRegisteredNamespaceRoots(ctx.storage);
      expect(roots.ownReadOnly).toEqual(["salvage"]);
      expect(roots.own).toEqual([]);
      expect(roots.connected).toEqual([]);

      const scopes =
        buildDefaultPermissionBundles(roots).find((b) => b.id === "custom")
          ?.scopes ?? [];
      expect(scopes).toContain("salvage.*:read");
      expect(scopes).not.toContain("salvage.*:write");
    } finally {
      await ctx.cleanup();
    }
  });

  it("does not take write away from a root the person also owns", async () => {
    // A root holding a type registered here and a restored one has earned
    // write on that root through the first. Offering the same root at two levels would put a
    // contradiction on one screen, so the stronger grant wins.
    const ctx = await createTestContext({});
    try {
      await ctx.storage.types.create(
        { id: "salvage.mine", ...baseType },
        { origin: "user" },
      );
      await ctx.storage.types.create(
        { id: "salvage.restored", ...baseType },
        { origin: "unknown" },
      );

      const roots = await resolveRegisteredNamespaceRoots(ctx.storage);
      expect(roots.own).toEqual(["salvage"]);
      expect(roots.ownReadOnly).toEqual(["salvage"]);

      const scopes =
        buildDefaultPermissionBundles(roots).find((b) => b.id === "custom")
          ?.scopes ?? [];
      expect(scopes).toContain("salvage.*:write");
      // And exactly once, rather than the root appearing twice at two
      // levels.
      expect(scopes.filter((s) => s === "salvage.*:read")).toHaveLength(1);
    } finally {
      await ctx.cleanup();
    }
  });
});

describe("the read-only bucket obeys the same filters as the others", () => {
  it("drops registry roots and reserved roots", () => {
    // The `own` path has this test and the read-only path did not, which
    // is the asymmetry worth closing rather than the likelihood of it
    // firing: a registry root is already offered concretely under
    // `connected`, and a reserved root can hold no custom type at all, so
    // either one arriving here would be offering something twice or
    // offering something that cannot exist.
    const registryRoot = deriveRequestableNamespaceRoots().find(
      (ns) => ns !== "user" && ns !== "app",
    );
    expect(registryRoot).toBeDefined();

    const scopes =
      buildDefaultPermissionBundles({
        ownReadOnly: [registryRoot!, "user", "salvage"],
      }).find((b) => b.id === "custom")?.scopes ?? [];

    expect(scopes).toContain("salvage.*:read");
    expect(scopes).not.toContain(`${registryRoot!}.*:read`);
    // `user` is reserved and already carries the read-and-write pair, so
    // it must not reappear here at the weaker level.
    expect(scopes).toContain("user.*:write");
    expect(scopes.filter((s) => s === "user.*:read")).toHaveLength(1);
  });
});
