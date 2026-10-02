/**
 * Every door the app serves, what it asks of a caller before it reads the
 * request, and whether it does.
 *
 * **A census rather than a test per door.** A rule a door asks of every
 * caller, the operator key or one permission, refused inside its handler is
 * reached only after the router has validated the request, so a key that may
 * not use the door is told what is wrong with its body before it is told it
 * may not use the door. Such a door reads as covered from every angle a
 * per-route test can see, and no scan of the source can tell how a check is
 * spelled. So every door in the app's own route table has to be named below,
 * and every door that is not open to every credential is driven with a
 * credential it refuses and a request nothing would accept, and has to answer
 * `403`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  mintWorkingKey,
  request,
  seedOauthBearer,
} from "../test-utils.js";
import { buildAllowedScopes } from "../auth/oauth-provider.js";
import type { TestContext } from "../test-utils.js";
import { standingRuleOf } from "../middleware/auth.js";

let ctx: TestContext;
/** A working key holding nothing at all, so every standing rule but the one
 *  asking for a working key refuses it. */
let holdsNothing: string;
/** A signed-in app's token holding every scope there is. */
let appHoldingEverything: string;

beforeAll(async () => {
  ctx = await createTestContext();
  holdsNothing = await mintWorkingKey(ctx, {
    permissions: [],
    type_permissions: {},
    extension_permissions: {},
    edge_permissions: {},
    metadata_permissions: {},
    profile_permissions: {},
    sources: [],
  });
  appHoldingEverything = (
    await seedOauthBearer(ctx.storage, buildAllowedScopes())
  ).token;
});

afterAll(async () => {
  await ctx.cleanup();
});

const OPERATOR = "operator key";
const WORKING_KEY = "a working key";
const KEYS_ONLY = "a key, not a signed-in app";
const READS = "reads some type";
const READS_BLOBS = "reads some type, or the operator key";

/** Every data-plane door, which a credential reaching no type is refused. */
const DATA_PLANE = [
  "DELETE /edges/:id",
  "DELETE /items/:id",
  "DELETE /items/:id/extensions/:namespace",
  "DELETE /items/:id/tags/:tag",
  "GET /edges",
  "GET /edges/:id",
  "GET /events",
  "GET /export",
  "GET /items",
  "GET /items/:id",
  "GET /items/:id/backrefs",
  "GET /items/:id/edges",
  "GET /items/:id/extensions",
  "GET /items/:id/extensions/:namespace",
  "GET /items/:id/metadata",
  "GET /items/:id/versions",
  "GET /items/stats",
  "GET /metadata/tags",
  "GET /occurrences",
  "GET /search",
  "PATCH /edges/:id",
  "PATCH /items/:id",
  "PATCH /items/:id/metadata",
  "POST /edges",
  "POST /edges/bulk",
  "POST /items",
  "POST /items/:id/restore",
  "POST /items/:id/tags",
  "POST /items/:id/transition",
  "POST /items/bulk",
  "POST /items/bulk-get",
  "POST /items/lookup",
  "POST /items/tombstones",
  "PUT /items/:id/extensions/:namespace",
  "PUT /items/:id/metadata",
];

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
  "POST /connectors": WORKING_KEY,
  "GET /keys/current": KEYS_ONLY,
  "POST /folders": "write on system.folder",
  "PATCH /folders/:id": "write on system.folder",
  "POST /folders/:id/revoke": "write on system.folder",
  "GET /blobs/:hash": READS_BLOBS,
  "GET /blobs/:hash/locations": READS_BLOBS,
  "GET /blobs/:hash/url": READS_BLOBS,
  "POST /blobs": "writes some type, or the operator key",
  ...Object.fromEntries(DATA_PLANE.map((door) => [door, READS])),
};

/**
 * Doors that ask their permission inside the handler. They take no body and
 * no validated query, so nothing about the request is read before the
 * permission; they are driven like the standing doors.
 */
const ASKED_IN_PLACE: Record<string, string> = {
  "GET /auth/grants": "grants.manage, on a plain route",
  "DELETE /auth/grants/:id": "grants.manage, on a plain route",
};

/**
 * Doors open to every credential, by why. What each answers turns on the row
 * the path names and whose it is, so each is driven with three credentials
 * as different as there are, a key holding nothing, a signed-in app's token
 * holding everything and the operator key, and must answer every one alike
 * and never `403`.
 */
const OPEN_TO_EVERY_CREDENTIAL: Record<string, readonly string[]> = {
  "a connector's doors answer the connector the path names, to its own key or a reader of it":
    [
      "DELETE /connectors/:id",
      "DELETE /connectors/:id/endpoints/:endpoint_id",
      "DELETE /connectors/:id/hold",
      "DELETE /connectors/:id/state",
      "GET /connectors",
      "GET /connectors/:id",
      "GET /connectors/:id/agreements",
      "GET /connectors/:id/deliveries",
      "GET /connectors/:id/deliveries/:delivery_id/body",
      "GET /connectors/:id/endpoints",
      "GET /connectors/:id/runs",
      "GET /connectors/:id/state",
      "POST /connectors/:id/agreements",
      "POST /connectors/:id/agreements/find",
      "POST /connectors/:id/deliveries/handled",
      "POST /connectors/:id/endpoints",
      "POST /connectors/:id/heartbeat",
      "POST /connectors/:id/hold",
      "POST /connectors/:id/runs",
      "PUT /connectors/:id/state",
    ],
  "a bulk-action job answers the credential that started it, judged on the job the path names":
    ["DELETE /items/bulk-actions/jobs/:id", "GET /items/bulk-actions/jobs/:id"],
  "a bulk action narrows what it matches to what the credential may write, and refuses nothing for it (keys-and-oauth.md 1)":
    ["POST /items/bulk-actions"],
  "the registries every credential writes against": [
    "GET /types",
    "GET /types/:id",
    "GET /edge-types",
  ],
};

/** Doors that take no credential at all, by why. */
const NO_CREDENTIAL: Record<string, readonly string[]> = {
  "who the instance is, and how it is reached and described": [
    "GET /",
    "GET /health",
    "GET /openapi.json",
    "GET /.well-known/oauth-authorization-server/auth",
    "GET /.well-known/oauth-protected-resource",
    "GET /.well-known/openid-configuration/auth",
    "GET /auth/.well-known/oauth-authorization-server",
    "GET /auth/.well-known/openid-configuration",
  ],
  "the sign-in surface a browser walks, which a session cookie or a signed query authenticates":
    [
      "GET /auth/*",
      "POST /auth/*",
      "GET /auth/authorize",
      "POST /auth/authorize/decision",
      "GET /auth/device",
      "POST /auth/device",
      "GET /auth/device/consent",
      "POST /auth/device/consent",
      "GET /auth/error",
      "GET /auth/oauth2/end-session",
      "GET /auth/sign-in",
      "POST /auth/sign-in",
      "GET /auth/static/auth.css",
      "GET /auth/static/password-toggle.js",
      "GET /auth/static/submit-state.js",
    ],
  "the address or the signature in it is the credential": [
    "GET /blobs/:hash/fetch",
    "POST /inbound/:token",
  ],
};

/**
 * Every `requirePermission` call left in a route file, by file and literal,
 * each with why it cannot be a standing rule.
 */
const PERMISSION_CALLS: Record<
  string,
  { asks: Record<string, number>; because: string }
> = {
  "routes/_schema-reach.ts": {
    asks: { "schema.write": 1 },
    because:
      "the whole schema guard, which asks schema.write again once it knows the names; the standing rule asks it first through standingPermission",
  },
  "routes/auth-pages.ts": {
    asks: { "grants.manage": 2 },
    because:
      "the grant doors are plain routes that read no body, and are driven below like the standing doors",
  },
  "routes/bulk.ts": {
    asks: { "items.purge": 1 },
    because: "asked only of a bulk action whose action is purge",
  },
};

function servedDoors(): string[] {
  return [
    ...new Set(
      ctx.app.routes
        .filter((route) => route.method !== "ALL")
        .map((route) => `${route.method} ${route.path}`),
    ),
  ].sort();
}

function standingDoors(): Record<string, string> {
  const found: Record<string, string[]> = {};
  for (const route of ctx.app.routes) {
    const rule = standingRuleOf(route.handler);
    if (rule !== undefined) {
      (found[`${route.method} ${route.path}`] ??= []).push(rule);
    }
  }
  return Object.fromEntries(
    Object.entries(found).map(([door, rules]) => [door, rules.join(", ")]),
  );
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

/** A door's path with each parameter filled in. */
function concrete(path: string, value: string): string {
  return path.replace(/:[a-z_]+/g, value);
}

function send(
  method: string,
  path: string,
  bearer: string,
  body: string | undefined,
): Promise<Response> {
  return Promise.resolve(
    ctx.app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: method === "GET" ? undefined : body,
    }),
  );
}

/** The request nothing would accept: an id no row has, in no shape any
 *  validator takes, a query value no door takes, and a body no parser reads. */
function malformed(door: string, bearer: string): Promise<Response> {
  const [method, path] = door.split(" ") as [string, string];
  return send(
    method,
    `${concrete(path, "not%20a%20valid%20id")}?limit=not-a-number`,
    bearer,
    "{ not json",
  );
}

/** An id of the shape every id is, which no row holds. */
const NO_ROW = "019537a0-7b80-7000-8000-000000000000";

type Schema = Record<string, unknown>;

/**
 * The smallest value a schema in the served document accepts: required
 * properties only, the first of an enum or a union, the shortest array.
 */
function sample(schema: Schema | undefined, doc: Schema): unknown {
  if (!schema) return undefined;
  const ref = schema.$ref;
  if (typeof ref === "string") {
    const name = ref.split("/").pop()!;
    const components = (doc.components as { schemas: Record<string, Schema> })
      .schemas;
    return sample(components[name], doc);
  }
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    const options = schema[key];
    if (Array.isArray(options)) return sample(options[0] as Schema, doc);
  }
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  switch (schema.type) {
    case "object": {
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      const required = (schema.required ?? []) as string[];
      return Object.fromEntries(
        required.map((name) => [name, sample(properties[name], doc)]),
      );
    }
    case "array": {
      const count = typeof schema.minItems === "number" ? schema.minItems : 0;
      return Array.from({ length: count }, () =>
        sample(schema.items as Schema, doc),
      );
    }
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? schema.minimum : 1;
    case "boolean":
      return false;
    case "string":
      return schema.format === "date-time"
        ? new Date().toISOString()
        : "x".repeat(
            typeof schema.minLength === "number" ? schema.minLength : 1,
          );
    default:
      return undefined;
  }
}

/**
 * A request the door's own validators take, read off the served document:
 * every path parameter an id no row holds, every required query parameter,
 * and the smallest body the schema accepts. A door that refuses a credential
 * by rule after reading the request answers this one with the refusal.
 */
function wellFormed(door: string, doc: Schema, bearer: string) {
  const [method, path] = door.split(" ") as [string, string];
  const template = path.replace(/:([a-z_]+)/g, "{$1}");
  const operation = (doc.paths as Record<string, Record<string, Schema>>)[
    template
  ]?.[method.toLowerCase()];
  if (!operation) throw new Error(`${door} is not in the served document`);
  const query = new URLSearchParams();
  for (const parameter of (operation.parameters ?? []) as Schema[]) {
    if (parameter.in === "query" && parameter.required === true) {
      query.set(
        parameter.name as string,
        String(sample(parameter.schema as Schema, doc)),
      );
    }
  }
  const content = (operation.requestBody as Schema | undefined)?.content as
    Record<string, { schema?: Schema }> | undefined;
  const body = content?.["application/json"]?.schema;
  const search = query.size > 0 ? `?${query.toString()}` : "";
  return send(
    method,
    `${concrete(path, NO_ROW)}${search}`,
    bearer,
    body === undefined ? undefined : JSON.stringify(sample(body, doc)),
  );
}

/** The credential a door's rule refuses. */
function refusedBy(door: string): string {
  if (STANDING[door] === WORKING_KEY) return ctx.operatorKey;
  if (STANDING[door] === KEYS_ONLY) return appHoldingEverything;
  return holdsNothing;
}

/** The status and error code of an answer, reading no stream. */
async function answer(res: Response): Promise<string> {
  if (!(res.headers.get("content-type") ?? "").includes("json")) {
    await res.body?.cancel();
    return String(res.status);
  }
  const body = (await res.json()) as { error?: { code?: string } };
  return `${String(res.status)} ${body.error?.code ?? ""}`.trim();
}

describe("every door asks what it asks of every caller before anything else", () => {
  it("names every door the app serves, once", () => {
    const named = [
      ...Object.keys(STANDING),
      ...Object.keys(ASKED_IN_PLACE),
      ...Object.values(OPEN_TO_EVERY_CREDENTIAL).flat(),
      ...Object.values(NO_CREDENTIAL).flat(),
    ];
    expect(new Set(named).size).toBe(named.length);
    expect(servedDoors().length).toBeGreaterThan(100);
    expect(servedDoors()).toEqual([...named].sort());
  });

  it("reads each standing rule off the route table", () => {
    expect(standingDoors()).toEqual(STANDING);
  });

  it("refuses a credential the door does not admit 403, whatever is wrong with its request", async () => {
    const wrong: string[] = [];
    for (const door of [
      ...Object.keys(STANDING),
      ...Object.keys(ASKED_IN_PLACE),
    ]) {
      const got = await answer(await malformed(door, refusedBy(door)));
      if (got !== "403 forbidden" && got !== "403 type_not_permitted") {
        wrong.push(`${door} answered ${got}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("answers every credential alike on a door open to all of them, and never 403", async () => {
    const doc = (await (
      await ctx.app.request("/openapi.json")
    ).json()) as Schema;
    const credentials = [holdsNothing, appHoldingEverything, ctx.operatorKey];
    const wrong: string[] = [];
    for (const door of Object.values(OPEN_TO_EVERY_CREDENTIAL).flat()) {
      for (const [shape, drive] of [
        ["malformed", (bearer: string) => malformed(door, bearer)],
        ["well-formed", (bearer: string) => wellFormed(door, doc, bearer)],
      ] as const) {
        const answers = [];
        for (const bearer of credentials) {
          answers.push(await answer(await drive(bearer)));
        }
        if (
          answers.some((got) => got.startsWith("403")) ||
          new Set(answers).size > 1
        ) {
          wrong.push(`${door}, ${shape}: ${answers.join(" | ")}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("names the permission it refuses, on a door a permission opens", async () => {
    const res = await malformed("PUT /config", holdsNothing);
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
    const config = await malformed("PUT /config", ctx.workingKey);
    expect(config.status).toBe(400);
    const owner = await request(ctx.app, "POST", "/owner", {
      key: ctx.operatorKey,
      body: { email: "not an address", password: "x" },
    });
    expect(owner.status).toBe(400);
    const connector = await malformed("POST /connectors", holdsNothing);
    expect(connector.status).toBe(400);
  });

  it("lists every permission still asked inside a route file", () => {
    const routes = sourcesUnder("routes");
    expect(routes.length).toBeGreaterThan(20);
    const asked: Record<string, Record<string, number>> = {};
    for (const file of routes) {
      for (const match of read(file).matchAll(
        /requirePermission\(\s*c\s*,\s*"([^"]+)"/g,
      )) {
        const byLiteral = (asked[file] ??= {});
        byLiteral[match[1]!] = (byLiteral[match[1]!] ?? 0) + 1;
      }
    }
    expect(asked).toEqual(
      Object.fromEntries(
        Object.entries(PERMISSION_CALLS).map(([file, { asks }]) => [
          file,
          asks,
        ]),
      ),
    );
    for (const { because } of Object.values(PERMISSION_CALLS)) {
      expect(because.length).toBeGreaterThan(30);
    }
  });
});
