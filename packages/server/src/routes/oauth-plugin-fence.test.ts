import { describe, it, expect, afterEach, vi } from "vitest";
import {
  oauthDeviceAuthorization,
  oauthProvider,
} from "@better-auth/oauth-provider";
import {
  createTestContext,
  createTestAccount,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import {
  FENCED_PLUGIN_ENDPOINTS,
  REACHABLE_PLUGIN_ENDPOINTS,
} from "./oauth-plugin-fence.js";

/**
 * The OAuth Provider plugin's management endpoints are refused before the
 * catch-all can serve them, and the list of what is refused is held to what
 * the plugin actually registers.
 *
 * Three properties, and none implies the others. The enumeration case says
 * the two lists between them decide every path the plugin routes, whatever
 * its prefix, and name nothing the plugin no longer registers, so a plugin
 * upgrade that adds a door and a fence entry that has gone stale both
 * redden. The driven case says the fence is actually mounted ahead of the
 * catch-all: a signed-in session reaching a fenced path, in either
 * trailing-slash spelling, gets the Marfa 404 and neither its consent row
 * nor the client table moves. The control cases say the signature the
 * driven case keys on is the fence's alone, and that every path declared
 * reachable answers as itself rather than with that signature, and the
 * reachable list itself is pinned, so moving a path between the two lists
 * is a change the suite sees.
 */

vi.setConfig({ testTimeout: 45_000 });

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const ORIGIN = "http://localhost:0";

interface PluginEndpoint {
  path: string;
  /** True only when every registration of the path is marked server-only,
   *  which Better Auth's router never serves over HTTP. */
  serverOnly: boolean;
}

type EndpointRecord = Record<
  string,
  { path: string; options?: { metadata?: { SERVER_ONLY?: boolean } } }
>;

/** Every path the provider and its device plugin register, read off their
 *  own endpoint records rather than from a list somebody typed. Options are
 *  the minimum each factory accepts; the records are flat literals, so they
 *  gate nothing. */
function pluginEndpoints(): PluginEndpoint[] {
  const provider = oauthProvider({
    loginPage: "/auth/sign-in",
    consentPage: "/auth/authorize",
  });
  const device = oauthDeviceAuthorization();
  const endpoints = {
    ...(provider as unknown as { endpoints: EndpointRecord }).endpoints,
    ...(device as unknown as { endpoints: EndpointRecord }).endpoints,
  };
  const byPath = new Map<string, boolean>();
  for (const endpoint of Object.values(endpoints)) {
    const serverOnly = endpoint.options?.metadata?.SERVER_ONLY === true;
    byPath.set(
      endpoint.path,
      (byPath.get(endpoint.path) ?? true) && serverOnly,
    );
  }
  return [...byPath.entries()]
    .map(([path, serverOnly]) => ({ path, serverOnly }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Sign up + verify + sign in; returns the session cookie (`name=value`). */
async function signInUser(c: TestContext, email: string): Promise<string> {
  const password = "correct horse battery";
  await createTestAccount(c, email, password, "Fence Test User");
  const signInRes = await request(c.app, "POST", "/auth/sign-in/email", {
    body: { email, password },
    headers: { origin: ORIGIN },
  });
  if (signInRes.status !== 200) {
    throw new Error(`sign-in failed (${String(signInRes.status)})`);
  }
  const setCookie = signInRes.headers.get("set-cookie");
  if (!setCookie) throw new Error("sign-in: no Set-Cookie header");
  // The cookie name carries the configured prefix (`marfa.auth.session_token`),
  // so match the name rather than splitting on a character class that a dot
  // would defeat.
  const match = /(?:^|,\s*)([\w.-]*session_token=[^;]+)/.exec(setCookie);
  if (!match?.[1]) throw new Error("sign-in: session_token cookie not found");
  return match[1];
}

function betterAuthSchema() {
  return import("../storage/sqlite/schema.js");
}

interface InsertingDb {
  insert: (table: unknown) => {
    values: (v: Record<string, unknown>) => {
      run?: () => Promise<unknown>;
      execute?: () => Promise<unknown>;
    };
  };
}

async function authUserIdFor(c: TestContext, email: string): Promise<string> {
  const schema = await betterAuthSchema();
  const { eq } = await import("drizzle-orm");
  const db = c.storage.betterAuthDb as {
    select: () => {
      from: (t: unknown) => {
        where: (w: unknown) => Promise<{ id: string }[]>;
      };
    };
  };
  const rows = await db
    .select()
    .from(schema.auth_user)
    .where(eq(schema.auth_user.email, email));
  const id = rows[0]?.id;
  if (!id) throw new Error(`authUserIdFor: no auth_user for ${email}`);
  return id;
}

/** A client row for the consent row to point at, and something a successful
 *  `create-client` or `delete-client` would visibly change. */
async function seedClient(c: TestContext): Promise<string> {
  const schema = await betterAuthSchema();
  const db = c.storage.betterAuthDb as InsertingDb;
  const asColumn = (v: readonly string[]): unknown => JSON.stringify(v);
  const clientId = `client_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date();
  const op = db.insert(schema.auth_oauth_client).values({
    id: `pk_${Math.random().toString(36).slice(2, 10)}`,
    clientId,
    name: "Fenced App",
    redirectUris: asColumn(["https://example.com/cb"]),
    grantTypes: asColumn(["authorization_code"]),
    disabled: false,
    createdAt: now,
    updatedAt: now,
    public: true,
    tokenEndpointAuthMethod: "none",
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
  return clientId;
}

const SEEDED_SCOPES = ["core.note:read"];

/** The consent row a live grant carries, for `update-consent` and
 *  `delete-consent` to have something a successful call would change. */
async function seedConsent(
  c: TestContext,
  clientId: string,
  authUserId: string,
): Promise<string> {
  const schema = await betterAuthSchema();
  const db = c.storage.betterAuthDb as InsertingDb;
  const now = new Date();
  const id = `cons_${Math.random().toString(36).slice(2)}`;
  const op = db.insert(schema.auth_oauth_consent).values({
    id,
    clientId,
    userId: authUserId,
    scopes: JSON.stringify(SEEDED_SCOPES),
    consentGiven: true,
    createdAt: now,
    updatedAt: now,
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
  return id;
}

/** The consent rows for a (client, user) pair, scopes normalized across the
 *  array column and the JSON-string column. */
async function consentScopes(
  c: TestContext,
  clientId: string,
  authUserId: string,
): Promise<string[][]> {
  const schema = await betterAuthSchema();
  const { and, eq } = await import("drizzle-orm");
  const db = c.storage.betterAuthDb as {
    select: () => {
      from: (t: unknown) => {
        where: (w: unknown) => Promise<{ scopes: unknown }[]>;
      };
    };
  };
  const rows = await db
    .select()
    .from(schema.auth_oauth_consent)
    .where(
      and(
        eq(schema.auth_oauth_consent.clientId, clientId),
        eq(schema.auth_oauth_consent.userId, authUserId),
      ),
    );
  return rows.map((row) =>
    Array.isArray(row.scopes)
      ? (row.scopes as string[])
      : (JSON.parse(String(row.scopes)) as string[]),
  );
}

async function countClients(c: TestContext): Promise<number> {
  const schema = await betterAuthSchema();
  const db = c.storage.betterAuthDb as {
    select: () => { from: (table: unknown) => Promise<unknown[]> };
  };
  const rows = await db.select().from(schema.auth_oauth_client);
  return rows.length;
}

/** Substitute concrete segments for the Hono parameters a path carries, so a
 *  request can actually be sent to it. */
function concrete(path: string): string {
  return path
    .replaceAll(":identifier", "https%3A%2F%2Fapi.example.com")
    .replaceAll(":client_id", "some-client");
}

/** The fence's signature, and only the fence's: the catch-all's own 404 is a
 *  bare response with no header, and the app-level `notFound` sends the
 *  envelope without the header. */
async function isFenced(res: Response): Promise<boolean> {
  if (res.status !== 404) return false;
  if (res.headers.get("x-error-code") !== "not_found") return false;
  const body = (await res.json().catch(() => null)) as {
    error?: { code?: string };
  } | null;
  return body?.error?.code === "not_found";
}

/** The body a real caller of each endpoint would send, aimed at the seeded
 *  rows, so a handler that ran would visibly move one of them: the consent
 *  endpoints resolve the row by `id` and refuse a miss before touching
 *  anything, an update to the scopes the row already holds would read back
 *  unchanged, and `oauth_query` goes only where the plugin expects it,
 *  because its signed-query check refuses any body carrying one. */
function managementBody(
  path: string,
  consentId: string,
  clientId: string,
): Record<string, unknown> {
  if (path === "/oauth2/consent") {
    return { accept: true, oauth_query: `client_id=${clientId}&sig=nope` };
  }
  if (path === "/oauth2/update-consent") {
    return { id: consentId, update: { scopes: ["core.note:write"] } };
  }
  if (path === "/oauth2/delete-consent") return { id: consentId };
  if (path.endsWith("create-client")) {
    return {
      client_name: "Fenced",
      redirect_uris: ["https://example.com/cb"],
    };
  }
  return {
    id: consentId,
    client_id: clientId,
    client_name: "Fenced",
    redirect_uris: ["https://example.com/cb"],
    update: { scopes: ["core.note:write"] },
  };
}

describe("the plugin's management endpoints are fenced", () => {
  it("the reachable and fenced lists between them decide every path the plugin routes, and name nothing else", () => {
    const registered = pluginEndpoints();
    const known = new Set(registered.map((e) => e.path));
    const routable = registered.filter((e) => !e.serverOnly).map((e) => e.path);
    const reachable = new Set(REACHABLE_PLUGIN_ENDPOINTS);
    const fenced = new Set(FENCED_PLUGIN_ENDPOINTS);

    // The reachable list is a decision, so it is written twice. Without
    // this, moving a path from the fenced list to the reachable one is a
    // one-line change every other case here accepts: the partition still
    // holds and a reopened door answers as the plugin would, which is
    // exactly what the signature control below is satisfied by.
    expect([...REACHABLE_PLUGIN_ENDPOINTS].sort()).toEqual([
      "/device",
      "/device/code",
      "/oauth2/authorize",
      "/oauth2/continue",
      "/oauth2/end-session",
      "/oauth2/end-session/confirm",
      "/oauth2/introspect",
      "/oauth2/register",
      "/oauth2/revoke",
      "/oauth2/token",
      "/oauth2/userinfo",
    ]);

    // A path in both lists is a contradiction: the fence would win at
    // runtime and the reachable list would be lying about it.
    for (const path of reachable) expect(fenced.has(path)).toBe(false);

    // Every routable path is decided one way or the other, whatever prefix
    // it carries. A plugin upgrade that registers something new, under any
    // prefix, lands here first.
    const undecided = routable.filter(
      (path) => !reachable.has(path) && !fenced.has(path),
    );
    expect(undecided).toEqual([]);

    // The premise the enumeration rests on: the plugin does route the
    // protocol surface, so an empty `routable` would not be a clean pass.
    for (const path of reachable) {
      expect(routable, `${path} is not routable`).toContain(path);
    }

    // And both lists describe paths that exist, so a stale entry — a path
    // the plugin stopped registering — reddens rather than reading as a
    // protection.
    for (const path of [...reachable, ...fenced]) {
      expect(known.has(path), `${path} is not a plugin endpoint`).toBe(true);
    }
  });

  it("a signed-in session gets the Marfa 404 on every fenced path in both spellings, and neither its consent row nor the client table moves", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx, "fence@example.com");
    const authUserId = await authUserIdFor(ctx, "fence@example.com");
    const clientId = await seedClient(ctx);
    const consentId = await seedConsent(ctx, clientId, authUserId);
    const clientsBefore = await countClients(ctx);

    for (const path of FENCED_PLUGIN_ENDPOINTS) {
      for (const spelling of [concrete(path), `${concrete(path)}/`]) {
        for (const method of ["GET", "POST"]) {
          const res = await request(ctx.app, method, `/auth${spelling}`, {
            headers: { cookie, origin: ORIGIN },
            ...(method === "POST" && {
              body: managementBody(path, consentId, clientId),
            }),
          });
          expect.soft(await isFenced(res), `${method} ${spelling}`).toBe(true);
        }
      }
    }

    // `update-consent` and `delete-consent` aimed at this row; `create-client`
    // and `delete-client` at this table. The reads say none of them ran.
    expect(await consentScopes(ctx, clientId, authUserId)).toEqual([
      SEEDED_SCOPES,
    ]);
    expect(await countClients(ctx)).toBe(clientsBefore);
  });

  it("the signature is the fence's alone, and every reachable path answers as itself", async () => {
    ctx = await createTestContext({});
    const cookie = await signInUser(ctx, "control@example.com");

    // An unknown `/auth/*` path is refused by the catch-all with a bare 404
    // and no header. That difference is what the driven case keys on, so a
    // later global 404 shaper that added the header everywhere would hollow
    // it out; this pins the shape.
    const unknown = await request(ctx.app, "GET", "/auth/oauth2/no-such-path", {
      headers: { cookie },
    });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("x-error-code")).toBeNull();

    // Nothing declared reachable carries the fence's signature. That is all
    // this loop proves: a path the plugin does not serve for a method also
    // passes, since the catch-all's bare 404 is not the signature. "Answers
    // as itself" is carried by the enumeration case's routable check and the
    // three explicit refusals below; the pin there is what makes moving a
    // path between the lists a change the suite sees.
    for (const path of REACHABLE_PLUGIN_ENDPOINTS) {
      for (const method of ["GET", "POST"]) {
        const res = await request(ctx.app, method, `/auth${concrete(path)}`, {
          headers: { cookie, origin: ORIGIN },
          ...(method === "POST" && { form: { client_name: "x" } }),
        });
        expect.soft(await isFenced(res), `${method} ${path}`).toBe(false);
      }
    }

    // And three of them answer with their own refusals, not a 404: a token
    // request with no grant, userinfo with no bearer, and the plugin's
    // registration handler refusing a form-encoded body.
    const token = await request(ctx.app, "POST", "/auth/oauth2/token", {
      form: { grant_type: "refresh_token" },
      headers: { origin: ORIGIN },
    });
    expect(token.status).toBeGreaterThanOrEqual(400);
    expect(token.status).toBeLessThan(500);
    expect(token.status).not.toBe(404);

    const userinfo = await request(ctx.app, "GET", "/auth/oauth2/userinfo");
    expect(userinfo.status).toBe(401);

    const register = await request(ctx.app, "POST", "/auth/oauth2/register", {
      form: { client_name: "x" },
    });
    expect(register.status).toBe(415);
  });
});
