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
    const custom = buildDefaultPermissionBundles([
      "acme",
      "google", // registry root — connected already covers it concretely
      "user", // structural — never duplicated
      "core", // reserved — cannot hold a custom type, filtered as a belt
    ]).find((b) => b.id === "custom");
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
      expect(roots).toEqual(["acme"]);
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
        await resolveRuntimeCustomNamespaces(ctx.storage, spaceA.id),
      ).toEqual(["acme"]);
      expect(
        await resolveRuntimeCustomNamespaces(ctx.storage, spaceB.id),
      ).toEqual(["rivalco"]);
      // The space-less bucket sees neither space's registrations.
      expect(await resolveRuntimeCustomNamespaces(ctx.storage)).toEqual([]);
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
