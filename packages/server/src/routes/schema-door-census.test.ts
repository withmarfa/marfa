/**
 * Every door that reads or changes the type and edge-type registries, and
 * the credential it answers.
 *
 * **A census rather than a test per door, for the reason the blob census
 * exists.** Holding `schema.write` or `metadata.*:write` opens a registry
 * door and says nothing about which names behind it; the key's type and edge
 * maps say that, and a door that asks the permission and forgets the map
 * reads as covered from every angle a per-route test can see. So the doors
 * are read out of the app's own route table, each has to be classified below
 * before this file goes green, and every changing door is then driven with a
 * key that holds the permission but no map entry for its target, beside a
 * witness that holds the entry and is served.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PERMISSIONS } from "@withmarfa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/** Doors that change a registry for a working key, held to the key's maps. */
const CHANGING = [
  "POST /types",
  "PUT /types/:id",
  "DELETE /types/:id",
  "POST /edge-types",
  "DELETE /edge-types/:id",
];

/** Doors that read a registry and change nothing. */
const READING = ["GET /types", "GET /types/:id", "GET /edge-types"];

/** Doors only the operator key opens, refusing a working key outright. */
const OPERATOR_ONLY = [
  "GET /admin/platform-types/drift",
  "DELETE /admin/platform-types/:id",
  "POST /admin/restore-archive",
];

function schemaDoors(): string[] {
  const under = (path: string, root: string) =>
    path === root || path.startsWith(`${root}/`);
  return [
    ...new Set(
      ctx.app.routes
        .filter(
          (r) =>
            under(r.path, "/types") ||
            under(r.path, "/edge-types") ||
            under(r.path, "/admin/platform-types") ||
            under(r.path, "/admin/restore-archive"),
        )
        .filter((r) => r.method !== "ALL")
        .map((r) => `${r.method} ${r.path}`),
    ),
  ].sort();
}

/**
 * Every module outside `storage/` that changes a registry, with the door it
 * serves. A registry write outside the doors above is invisible to the route
 * walk, so it is caught here instead: a new writer fails until it is named.
 */
const REGISTRY_WRITE =
  /\b(?:types\.(?:create|update|delete|deletePlatformType)|edgeTypes\.(?:create|delete)|registerEdgeTypeSchema|unregisterEdgeTypeSchema)\(/;

const REGISTRY_WRITERS: Record<string, string> = {
  "routes/types.ts": "POST, PUT and DELETE /types, held to the type map",
  "routes/edge-types.ts":
    "POST and DELETE /edge-types, held to the edge map on the id and reverse name",
  "routes/admin-archive-types.ts":
    "the restore's type registrations, reached only through POST /admin/restore-archive",
  "routes/admin-platform-types.ts": "DELETE /admin/platform-types/:id",
};

function registryWriters(): string[] {
  const root = join(import.meta.dirname, "..");
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (rel === "storage") continue;
        walk(rel);
      } else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        rel !== "test-utils.ts" &&
        REGISTRY_WRITE.test(readFileSync(join(root, rel), "utf8"))
      ) {
        out.push(rel);
      }
    }
  };
  walk("");
  return out.sort();
}

async function errorCode(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { error?: { code?: string } }).error?.code;
}

/** Holds every permission and every metadata scope; the maps reach `mine.*`. */
function confinedKey(): Promise<string> {
  return mintWorkingKey(ctx, {
    permissions: [...PERMISSIONS],
    metadata_permissions: { "*": "write" },
    type_permissions: { "mine.*": "write" },
    edge_permissions: { "mine.*": "write" },
  });
}

/** The same key, with the maps also reaching `other.*`. */
function reachingKey(): Promise<string> {
  return mintWorkingKey(ctx, {
    permissions: [...PERMISSIONS],
    metadata_permissions: { "*": "write" },
    type_permissions: { "mine.*": "write", "other.*": "write" },
    edge_permissions: { "mine.*": "write", "other.*": "write" },
  });
}

const FIELDS = { title: { type: "string" } };

describe("every registry door is held to the credential's maps", () => {
  it("classifies every registry door the app serves, and no door it does not", () => {
    const doors = schemaDoors();
    expect(doors.length).toBeGreaterThan(8);
    expect(doors).toEqual([...CHANGING, ...READING, ...OPERATOR_ONLY].sort());
  });

  it("names every module that changes a registry", () => {
    expect(registryWriters()).toEqual(Object.keys(REGISTRY_WRITERS).sort());
  });

  it("refuses POST /types an identifier outside the type map", async () => {
    const confined = await confinedKey();
    const refused = await request(ctx.app, "POST", "/types", {
      key: confined,
      body: { id: "other.registered", fields: FIELDS },
    });
    expect(refused.status).toBe(403);
    expect(await errorCode(refused)).toBe("type_not_permitted");
    expect(
      (
        await request(ctx.app, "GET", "/types/other.registered", {
          key: confined,
        })
      ).status,
    ).toBe(404);

    const served = await request(ctx.app, "POST", "/types", {
      key: await reachingKey(),
      body: { id: "other.registered", fields: FIELDS },
    });
    expect(served.status).toBe(201);
  });

  it("refuses PUT /types/:id a type outside the type map, and leaves it as it was", async () => {
    const reaching = await reachingKey();
    expect(
      (
        await request(ctx.app, "POST", "/types", {
          key: reaching,
          body: { id: "other.replaced", fields: FIELDS },
        })
      ).status,
    ).toBe(201);

    const confined = await confinedKey();
    const refused = await request(ctx.app, "PUT", "/types/other.replaced", {
      key: confined,
      body: { fields: { hijacked: { type: "string" } } },
    });
    expect(refused.status).toBe(403);
    expect(await errorCode(refused)).toBe("type_not_permitted");
    const stored = (await (
      await request(ctx.app, "GET", "/types/other.replaced", { key: confined })
    ).json()) as { fields: Record<string, unknown> };
    expect(Object.keys(stored.fields)).toEqual(["title"]);

    const served = await request(ctx.app, "PUT", "/types/other.replaced", {
      key: reaching,
      body: { fields: { title: { type: "string" }, kept: { type: "string" } } },
    });
    expect(served.status).toBe(200);
  });

  it("refuses DELETE /types/:id a type outside the type map, forced or not", async () => {
    const reaching = await reachingKey();
    const confined = await confinedKey();
    for (const query of ["", "?force=true"]) {
      const id = `other.deleted${query ? "-forced" : ""}`;
      expect(
        (
          await request(ctx.app, "POST", "/types", {
            key: reaching,
            body: { id, fields: FIELDS },
          })
        ).status,
      ).toBe(201);

      const refused = await request(ctx.app, "DELETE", `/types/${id}${query}`, {
        key: confined,
      });
      expect(refused.status, query).toBe(403);
      expect(await errorCode(refused)).toBe("type_not_permitted");
      expect(
        (await request(ctx.app, "GET", `/types/${id}`, { key: confined }))
          .status,
      ).toBe(200);

      const served = await request(ctx.app, "DELETE", `/types/${id}${query}`, {
        key: reaching,
      });
      expect(served.status, query).toBe(200);
    }
  });

  it("refuses POST /edge-types a name outside the edge map, on the id and the reverse name", async () => {
    const confined = await confinedKey();
    const reaching = await reachingKey();
    for (const body of [
      { id: "other.registered-link", cardinality: "many-to-many" },
      {
        id: "mine.registered-link",
        cardinality: "many-to-many",
        reverse_name: "other.registered-link-from",
      },
    ]) {
      const refused = await request(ctx.app, "POST", "/edge-types", {
        key: confined,
        body,
      });
      expect(refused.status, body.id).toBe(403);
      expect(await errorCode(refused)).toBe("edge_permission_denied");

      const served = await request(ctx.app, "POST", "/edge-types", {
        key: reaching,
        body,
      });
      expect(served.status, body.id).toBe(201);
    }
  });

  it("refuses DELETE /edge-types/:id an edge type whose id or reverse name is outside the edge map, forced or not", async () => {
    const confined = await confinedKey();
    const reaching = await reachingKey();
    const listed = async (id: string) =>
      (
        (await (
          await request(ctx.app, "GET", "/edge-types", { key: confined })
        ).json()) as { data: { id: string }[] }
      ).data.some((t) => t.id === id);

    for (const query of ["", "?force=true"]) {
      const suffix = query ? "-forced" : "";
      for (const body of [
        { id: `other.deleted-link${suffix}`, cardinality: "many-to-many" },
        {
          id: `mine.deleted-link${suffix}`,
          cardinality: "many-to-many",
          reverse_name: `other.deleted-link-from${suffix}`,
        },
      ]) {
        expect(
          (
            await request(ctx.app, "POST", "/edge-types", {
              key: reaching,
              body,
            })
          ).status,
        ).toBe(201);

        const refused = await request(
          ctx.app,
          "DELETE",
          `/edge-types/${body.id}${query}`,
          { key: confined },
        );
        expect(refused.status, `${body.id}${query}`).toBe(403);
        expect(await errorCode(refused)).toBe("edge_permission_denied");
        expect(await listed(body.id)).toBe(true);

        const served = await request(
          ctx.app,
          "DELETE",
          `/edge-types/${body.id}${query}`,
          { key: reaching },
        );
        expect(served.status, `${body.id}${query}`).toBe(200);
        expect(await listed(body.id)).toBe(false);
      }
    }
  });

  it("refuses a working key on every operator door", async () => {
    const reaching = await reachingKey();
    for (const door of OPERATOR_ONLY) {
      const [method, path] = door.split(" ") as [string, string];
      const res = await request(
        ctx.app,
        method,
        path.replace(":id", "other.platform"),
        { key: reaching, body: method === "POST" ? {} : undefined },
      );
      expect(res.status, door).toBe(403);
      expect(await errorCode(res)).toBe("forbidden");
    }
  });
});
