import { describe, expect, it } from "vitest";
import {
  TYPE_REGISTRY,
  classifyNamespace,
  seedPlatformTypes,
  shippedPlatformTypes,
} from "@withmarfa/shared";
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
  // The derivation makes membership true by construction, and this suite
  // pins the construction's family rules.
  it("derivation is total — every registry type lands in its family bundle", () => {
    const read = new Set(bundle("read").scopes);
    const write = new Set(bundle("write").scopes);
    for (const id of TYPE_REGISTRY.keys()) {
      const tier = classifyNamespace(id);
      // The build ships `core.*` and `system.*` and nothing else, so a type
      // under another root has no bundle until one is decided for it.
      expect(["core", "system"], `${id} is in no bundle`).toContain(tier);
      if (tier === "core") {
        expect(read.has(`${id}:read`), `read misses ${id}`).toBe(true);
        expect(write.has(`${id}:write`), `write misses ${id}`).toBe(true);
      } else {
        expect(write.has(`${id}:write`), `write leaks ${id}`).toBe(false);
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

  it("leaves out a root the registry itself occupies", () => {
    // A platform row this build does not ship still resolves once seeded,
    // which is the one way a publisher root reaches the registry. Its types
    // are the platform's rather than the person's.
    seedPlatformTypes([
      ...shippedPlatformTypes(),
      {
        schema: { id: "relic.widget", version: 1, fields: {} },
        family: "core",
      },
    ]);
    try {
      expect(deriveRequestableNamespaceRoots()).toContain("relic");
      const custom = buildDefaultPermissionBundles({
        own: ["acme", "relic"],
        ownReadOnly: ["relic", "salvage"],
      }).find((b) => b.id === "custom");
      expect(custom?.scopes).toEqual([
        "user.*:read",
        "user.*:write",
        "acme.*:read",
        "acme.*:write",
        "salvage.*:read",
      ]);
    } finally {
      seedPlatformTypes(shippedPlatformTypes());
    }
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
      expect(await resolveAllRegisteredNamespaceRoots(ctx.storage)).toEqual([
        "acme",
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
    // The case an archive line carrying no provenance produces. Treating it
    // as the person's own would hand a read-and-write wildcard to whatever
    // wrote the line, and dropping it would leave a legitimate restore of
    // your own types in no bundle at all, ungrantable to any application.
    const ctx = await createTestContext({});
    try {
      await ctx.storage.types.create(
        { id: "salvage.record", ...baseType },
        { origin: "unknown" },
      );

      const roots = await resolveRegisteredNamespaceRoots(ctx.storage);
      expect(roots.ownReadOnly).toEqual(["salvage"]);
      expect(roots.own).toEqual([]);

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
  it("drops reserved roots", () => {
    // A reserved root can hold no custom type at all, so one arriving here
    // would be offering something that cannot exist. The registry-root half
    // of the filter is the test above that seeds one.
    const scopes =
      buildDefaultPermissionBundles({
        ownReadOnly: ["user", "core", "salvage"],
      }).find((b) => b.id === "custom")?.scopes ?? [];

    expect(scopes).toContain("salvage.*:read");
    expect(scopes).not.toContain("core.*:read");
    // `user` is reserved and already carries the read-and-write pair, so
    // it must not reappear here at the weaker level.
    expect(scopes).toContain("user.*:write");
    expect(scopes.filter((s) => s === "user.*:read")).toHaveLength(1);
  });
});
