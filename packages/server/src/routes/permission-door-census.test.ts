/**
 * Every door that asks the same thing of every caller, the operator key or
 * one permission, and the order it asks it in.
 *
 * **A census rather than a test per door.** A door's standing rule, the
 * operator key or one permission, refused inside its handler is reached only
 * after the router has validated the request, so a key that may not use the
 * door is told what is wrong with its body before it is told it may not use
 * the door. Such a door reads as covered from every angle a per-route test
 * can see. So the doors carrying a standing rule are read out of the app's
 * own route table, each has to be named below, the sources are read for a
 * check made inside a handler instead, and every named door is then driven
 * with a key that may not use it and a request nothing would accept.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { standingRuleOf } from "../middleware/auth.js";

let ctx: TestContext;
/** A working key holding no permission and no metadata reach, so every
 *  standing rule refuses it. */
let holdsNoPermission: string;

beforeAll(async () => {
  ctx = await createTestContext();
  holdsNoPermission = await mintWorkingKey(ctx, {
    permissions: [],
    metadata_permissions: {},
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

const OPERATOR = "operator key";

/** Every door with a standing rule, and the rule. */
const STANDING: Record<string, string> = {
  "GET /owner": OPERATOR,
  "POST /owner": OPERATOR,
  "GET /blobs/orphans": OPERATOR,
  "GET /blobs/stores": OPERATOR,
  "DELETE /blobs/:hash/locations/:store": OPERATOR,
  "GET /housekeeping": OPERATOR,
  "POST /housekeeping/:name/run": OPERATOR,
  "GET /admin/platform-types/drift": OPERATOR,
  "DELETE /admin/platform-types/:id": OPERATOR,
  "POST /admin/restore-archive": OPERATOR,
  "GET /metrics": OPERATOR,
  "POST /webhooks": "webhooks.manage",
  "GET /webhooks": "webhooks.manage",
  "GET /webhooks/:id": "webhooks.manage",
  "PATCH /webhooks/:id": "webhooks.manage",
  "DELETE /webhooks/:id": "webhooks.manage",
  "GET /webhooks/:id/deliveries": "webhooks.manage",
  "GET /config": "config.manage",
  "PUT /config": "config.manage",
  "GET /audit": "audit.read",
  "POST /keys": "keys.mint or operator key",
  "GET /keys": "keys.mint or operator key",
  "DELETE /keys/:id": "keys.mint or operator key",
  "PATCH /keys/:id": "keys.mint or operator key",
  "DELETE /items/:id/purge": "items.purge",
  "POST /types": "metadata.types:write",
  "PUT /types/:id": "schema.write",
  "DELETE /types/:id": "schema.write",
  "POST /edge-types": "metadata.edge_types:write",
  "DELETE /edge-types/:id": "schema.write",
};

/**
 * Every `requirePermission` call left in a route file, by file and literal,
 * each with why it cannot be a standing rule: what it asks depends on the
 * request, or the door is not one the route table carries a rule on.
 */
const ASKED_IN_PLACE: Record<
  string,
  { asks: Record<string, number>; because: string }
> = {
  "routes/_schema-reach.ts": {
    asks: { "schema.write": 1 },
    because:
      "the schema guard, which the standing rule and the whole guard both call once the names are known",
  },
  "routes/auth-pages.ts": {
    asks: { "grants.manage": 2 },
    because:
      "the grant doors are plain routes that read no body, and answer a path id only after the permission",
  },
  "routes/bulk.ts": {
    asks: { "items.purge": 1 },
    because: "asked only of a bulk action whose action is purge",
  },
};

function standingDoors(): Record<string, string> {
  const found: Record<string, string> = {};
  for (const route of ctx.app.routes) {
    const rule = standingRuleOf(route.handler);
    if (rule !== undefined) found[`${route.method} ${route.path}`] = rule;
  }
  return found;
}

function sourcesUnder(dir: string): string[] {
  const root = join(import.meta.dirname, "..");
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel), {
      withFileTypes: true,
    })) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(path);
      }
    }
  };
  walk(dir);
  return out.sort();
}

function read(rel: string): string {
  return readFileSync(join(import.meta.dirname, "..", rel), "utf8");
}

/** The request nothing would accept: an id no row has, in no shape any
 *  validator takes, a query key no door knows, and a body no parser reads. */
function malformed(door: string): [string, string] {
  const [method, path] = door.split(" ") as [string, string];
  const concrete = path.replace(/:[a-z_]+/g, "not a valid id");
  return [method, `${concrete.replaceAll(" ", "%20")}?limit=not-a-number`];
}

describe("every door with a standing rule asks it before anything else", () => {
  it("names every door the app serves with a standing rule, and no other", () => {
    const doors = standingDoors();
    expect(Object.keys(doors).length).toBeGreaterThan(20);
    expect(doors).toEqual(STANDING);
  });

  it("asks no standing rule inside a handler", () => {
    const routes = sourcesUnder("routes");
    expect(routes.length).toBeGreaterThan(20);
    const asked: Record<string, Record<string, number>> = {};
    for (const file of routes) {
      const source = read(file);
      expect(source, file).not.toMatch(/checkOperatorKey\(/);
      for (const match of source.matchAll(
        /requirePermission\(\s*c\s*,\s*"([^"]+)"/g,
      )) {
        const byLiteral = (asked[file] ??= {});
        byLiteral[match[1]!] = (byLiteral[match[1]!] ?? 0) + 1;
      }
    }
    expect(asked).toEqual(
      Object.fromEntries(
        Object.entries(ASKED_IN_PLACE).map(([file, { asks }]) => [file, asks]),
      ),
    );
    for (const { because } of Object.values(ASKED_IN_PLACE)) {
      expect(because.length).toBeGreaterThan(30);
    }
  });

  it("refuses a key that may not use the door 403, whatever is wrong with its request", async () => {
    const wrong: string[] = [];
    for (const door of Object.keys(STANDING)) {
      const [method, path] = malformed(door);
      const res = await fetchRaw(method, path);
      const body = (await res.json()) as { error?: { code?: string } };
      if (res.status !== 403 || body.error?.code !== "forbidden") {
        wrong.push(
          `${door} answered ${String(res.status)} ${JSON.stringify(body)}`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  it("names the permission it refuses, on a door a permission opens", async () => {
    const [method, path] = malformed("PUT /config");
    const res = await fetchRaw(method, path);
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { details?: { required_scope?: string } };
    };
    expect(body.error.details?.required_scope).toBe("config.manage");
  });

  it("still validates the request of a caller the rule admits", async () => {
    // The witness: the malformed request is one the validators refuse, so the
    // 403s above come from the rule running first rather than from a request
    // the door would have taken.
    const res = await ctx.app.request("/config", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "application/json",
      },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    const owner = await request(ctx.app, "POST", "/owner", {
      key: ctx.operatorKey,
      body: { email: "not an address", password: "x" },
    });
    expect(owner.status).toBe(400);
  });
});

function fetchRaw(method: string, path: string): Promise<Response> {
  return Promise.resolve(
    ctx.app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${holdsNoPermission}`,
        "Content-Type": "application/json",
      },
      body: method === "GET" ? undefined : "{ not json",
    }),
  );
}
