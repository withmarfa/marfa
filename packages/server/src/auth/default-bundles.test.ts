import { describe, expect, it } from "vitest";
import { TYPE_REGISTRY, classifyNamespace } from "@withmarfa/shared";
import {
  buildDefaultPermissionBundles,
  deriveCustomTypeNamespaces,
  resolveAllRuntimeCustomNamespaces,
  resolveRuntimeCustomNamespaces,
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

  it("admits exactly one system scope: the connections toggle, read-only", () => {
    const systemScopes = buildDefaultPermissionBundles()
      .flatMap((b) => b.scopes)
      .filter((s) => s.startsWith("system."));
    expect(systemScopes).toEqual(["system.connection:read"]);
  });

  it("derives the custom-namespace roots from the registry", () => {
    const roots = deriveCustomTypeNamespaces();
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
          key: ctx.adminKey,
          body: { id, ...baseType },
        });
        expect(res.status).toBe(201);
      }
      const roots = await resolveRuntimeCustomNamespaces(ctx.storage);
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
    // connected service published is in their space and is not theirs to
    // be offered wholesale — it belongs to the service, and the service's
    // own scopes are how it is reached.
    const ctx = await createTestContext({ authMode: "hosted" });
    try {
      const baseType = {
        version: 1,
        fields: { name: { type: "string", required: true } },
      } as const;
      const space = await ctx.storage.spaces!.create("space-mixed");
      await ctx.storage.types.create(
        { id: "jonah.reading_item", ...baseType },
        space.id,
        { origin: "user" },
      );
      await ctx.storage.types.create(
        { id: "acme.widget", ...baseType },
        space.id,
        {
          origin: "integration",
          family: "integration",
          owner_integration: "acme/widgets",
        },
      );

      const roots = await resolveRuntimeCustomNamespaces(ctx.storage, space.id);
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
      expect(await resolveAllRuntimeCustomNamespaces(ctx.storage)).toEqual([
        "acme",
        "jonah",
      ]);
    } finally {
      await ctx.cleanup();
    }
  });

  it("resolves one space's own registrations and never a sibling's", async () => {
    // Hosted mode is where the space axis exists at all: registrations
    // land in their owning space's bucket, and the consent-time question
    // is "this space's roots", never the union. The space-less bucket
    // stays empty here — which is exactly why a bucket read alone made
    // the capability inert for every hosted space.
    const ctx = await createTestContext({ authMode: "hosted" });
    try {
      const baseType = {
        version: 1,
        fields: { name: { type: "string", required: true } },
      } as const;
      const spaceA = await ctx.storage.spaces!.create("space-a");
      const spaceB = await ctx.storage.spaces!.create("space-b");
      await ctx.storage.types.create(
        { id: "acme.gadget", ...baseType },
        spaceA.id,
      );
      await ctx.storage.types.create(
        { id: "rivalco.thing", ...baseType },
        spaceB.id,
      );

      expect(
        (await resolveRuntimeCustomNamespaces(ctx.storage, spaceA.id)).own,
      ).toEqual(["acme"]);
      expect(
        (await resolveRuntimeCustomNamespaces(ctx.storage, spaceB.id)).own,
      ).toEqual(["rivalco"]);
      // The space-less bucket sees neither space's registrations.
      expect((await resolveRuntimeCustomNamespaces(ctx.storage)).own).toEqual(
        [],
      );
      // The allowlist enumeration spans both — admission, not disclosure.
      expect(await resolveAllRuntimeCustomNamespaces(ctx.storage)).toEqual([
        "acme",
        "rivalco",
      ]);
    } finally {
      await ctx.cleanup();
    }
  });
});
