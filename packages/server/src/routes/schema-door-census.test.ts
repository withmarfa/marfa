/**
 * Every door that reads or changes the type and edge-type registries, and
 * the credential it answers.
 *
 * **A census rather than a test per door, for the reason the blob census
 * exists.** Holding `schema.write` or `metadata.*:write` opens a registry
 * door and says nothing about which names behind it; the key's type and edge
 * maps say that, and a door that asks the permission and forgets the map
 * reads as covered from every angle a per-route test can see. So the doors
 * are read out of the app's own route table and each has to be classified
 * below before this file goes green. A changing door is classified by giving
 * it a driver, and every driver is run: it calls the door with a key that
 * holds every permission but no map entry for the target, which must be
 * refused and change nothing, and then with a witness that holds the entry,
 * which must be served.
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

/**
 * The two keys a driver is handed. `refused` holds every permission and
 * metadata scope, and maps reaching only `mine.*`; `served` is the same key
 * with the maps also reaching `other.*`. `name` is unique to the run, for
 * the identifiers a driver makes.
 */
interface DriverKeys {
  refused: string;
  served: string;
  name: string;
}

type Driver = (keys: DriverKeys) => Promise<void>;

const FIELDS = { title: { type: "string" } };

async function errorCode(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { error?: { code?: string } }).error?.code;
}

async function expectRefused(
  res: Response,
  code: "type_not_permitted" | "edge_permission_denied",
  what: string,
): Promise<void> {
  expect(res.status, what).toBe(403);
  expect(await errorCode(res), what).toBe(code);
}

async function registerType(key: string, id: string): Promise<void> {
  const res = await request(ctx.app, "POST", "/types", {
    key,
    body: { id, fields: FIELDS },
  });
  expect(res.status, `register ${id}`).toBe(201);
}

async function typeFields(id: string, key: string): Promise<string[] | null> {
  const res = await request(ctx.app, "GET", `/types/${id}`, { key });
  if (res.status === 404) return null;
  return Object.keys(((await res.json()) as { fields: object }).fields);
}

async function registerEdgeType(
  key: string,
  body: { id: string; reverse_name?: string },
): Promise<void> {
  const res = await request(ctx.app, "POST", "/edge-types", {
    key,
    body: { cardinality: "many-to-many", ...body },
  });
  expect(res.status, `register ${body.id}`).toBe(201);
}

async function edgeTypeListed(id: string, key: string): Promise<boolean> {
  const res = await request(ctx.app, "GET", "/edge-types", { key });
  return ((await res.json()) as { data: { id: string }[] }).data.some(
    (t) => t.id === id,
  );
}

/** A registered edge type outside the refused key's map, by its id and by
 *  its reverse name alone. */
function edgeTargets(name: string) {
  return [
    { id: `other.${name}` },
    { id: `mine.${name}`, reverse_name: `other.${name}-from` },
  ];
}

/**
 * Doors that change a registry for a working key, each with its driver. A
 * door the route table serves and this map does not name fails the
 * classification below; a door named here is driven.
 */
const CHANGING: Record<string, Driver> = {
  "POST /types": async ({ refused, served, name }) => {
    const id = `other.${name}`;
    const res = await request(ctx.app, "POST", "/types", {
      key: refused,
      body: { id, fields: FIELDS },
    });
    await expectRefused(res, "type_not_permitted", id);
    expect(await typeFields(id, served)).toBeNull();
    await registerType(served, id);
  },

  "PUT /types/:id": async ({ refused, served, name }) => {
    const id = `other.${name}`;
    await registerType(served, id);
    const replacement = { fields: { replaced: { type: "string" } } };
    const res = await request(ctx.app, "PUT", `/types/${id}`, {
      key: refused,
      body: replacement,
    });
    await expectRefused(res, "type_not_permitted", id);
    expect(await typeFields(id, served)).toEqual(["title"]);
    const ok = await request(ctx.app, "PUT", `/types/${id}`, {
      key: served,
      body: replacement,
    });
    expect(ok.status).toBe(200);
    expect(await typeFields(id, served)).toEqual(["replaced"]);
  },

  "DELETE /types/:id": async ({ refused, served, name }) => {
    for (const query of ["", "?force=true"]) {
      const id = `other.${name}${query ? "-forced" : ""}`;
      await registerType(served, id);
      const res = await request(ctx.app, "DELETE", `/types/${id}${query}`, {
        key: refused,
      });
      await expectRefused(res, "type_not_permitted", `${id}${query}`);
      expect(await typeFields(id, served)).toEqual(["title"]);
      const ok = await request(ctx.app, "DELETE", `/types/${id}${query}`, {
        key: served,
      });
      expect(ok.status, `${id}${query}`).toBe(200);
      expect(await typeFields(id, served)).toBeNull();
    }
  },

  "POST /edge-types": async ({ refused, served, name }) => {
    for (const body of edgeTargets(name)) {
      const res = await request(ctx.app, "POST", "/edge-types", {
        key: refused,
        body: { cardinality: "many-to-many", ...body },
      });
      await expectRefused(res, "edge_permission_denied", body.id);
      expect(await edgeTypeListed(body.id, served)).toBe(false);
      await registerEdgeType(served, body);
    }
  },

  "DELETE /edge-types/:id": async ({ refused, served, name }) => {
    for (const query of ["", "?force=true"]) {
      for (const body of edgeTargets(`${name}${query ? "-forced" : ""}`)) {
        await registerEdgeType(served, body);
        const path = `/edge-types/${body.id}${query}`;
        const res = await request(ctx.app, "DELETE", path, { key: refused });
        await expectRefused(res, "edge_permission_denied", path);
        expect(await edgeTypeListed(body.id, served)).toBe(true);
        const ok = await request(ctx.app, "DELETE", path, { key: served });
        expect(ok.status, path).toBe(200);
        expect(await edgeTypeListed(body.id, served)).toBe(false);
      }
    }
  },
};

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
 * Every module outside `storage/` that changes a registry, the stored rows
 * or the in-memory one, with what it serves. A registry write outside the
 * doors above is invisible to the route walk, so it is caught here instead:
 * a new writer fails until it is named.
 */
const REGISTRY_WRITE =
  /\b(?:types\.(?:create|update|delete|deletePlatformType)|edgeTypes\.(?:create|delete)|(?:un)?registerTypeSchema|(?:un)?registerEdgeTypeSchema)\(/;

const REGISTRY_WRITERS: Record<string, string> = {
  "routes/types.ts": "POST, PUT and DELETE /types, held to the type map",
  "routes/edge-types.ts":
    "POST and DELETE /edge-types, held to the edge map on the id and reverse name",
  "routes/_type-write.ts":
    "puts the in-memory registry back when a type write it wraps does not commit",
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

describe("every registry door is held to the credential's maps", () => {
  it("classifies every registry door the app serves, and no door it does not", () => {
    const doors = schemaDoors();
    expect(doors.length).toBeGreaterThan(8);
    expect(doors).toEqual(
      [...Object.keys(CHANGING), ...READING, ...OPERATOR_ONLY].sort(),
    );
  });

  it("names every module that changes a registry", () => {
    expect(registryWriters()).toEqual(Object.keys(REGISTRY_WRITERS).sort());
  });

  it.each(Object.entries(CHANGING))(
    "refuses %s a name outside the key's map, and serves it with the entry",
    async (door, drive) => {
      const name = door
        .toLowerCase()
        .replace(/[^a-z]+/g, "-")
        .replace(/^-|-$/g, "");
      await drive({
        refused: await mintWorkingKey(ctx, {
          permissions: [...PERMISSIONS],
          metadata_permissions: { "*": "write" },
          type_permissions: { "mine.*": "write" },
          edge_permissions: { "mine.*": "write" },
        }),
        served: await mintWorkingKey(ctx, {
          permissions: [...PERMISSIONS],
          metadata_permissions: { "*": "write" },
          type_permissions: { "mine.*": "write", "other.*": "write" },
          edge_permissions: { "mine.*": "write", "other.*": "write" },
        }),
        name,
      });
    },
  );

  it("refuses a working key on every operator door", async () => {
    const key = await mintWorkingKey(ctx, {
      permissions: [...PERMISSIONS],
      metadata_permissions: { "*": "write" },
    });
    for (const door of OPERATOR_ONLY) {
      const [method, path] = door.split(" ") as [string, string];
      const res = await request(
        ctx.app,
        method,
        path.replace(":id", "other.platform"),
        { key, body: method === "POST" ? {} : undefined },
      );
      expect(res.status, door).toBe(403);
      expect(await errorCode(res)).toBe("forbidden");
    }
  });
});
