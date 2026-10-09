import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  authorize,
  authorizeQuery,
  connect,
  issuerOrigin,
  itemsStatus,
  pkce,
  registerApp,
  sentTo,
  signIn,
} from "../../utils/signed-in.js";

/**
 * The apps a person approved, listed and revoked through `/auth/grants`. A
 * grant needs a person's approval, and an instance has one owner, so this
 * file boots a server of its own.
 */
let server: FreshServer;
let origin: string;
let cookie: string;
let management: MarfaClient;

/** Every app here reads notes and mints keys within that. */
const SCOPE = "core.note:read keys.mint";

beforeAll(async () => {
  server = await bootFreshServer("auth-grants");
  origin = await issuerOrigin(server);
  cookie = await signIn(server, origin);
  management = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

interface Grant {
  id: string;
  kind: string;
  client_id: string;
  scopes: string[];
  status: string;
  granted_at: string;
  last_used_at: string | null;
}

/** A key minted by the management key holding only what is named. */
async function keyHolding(
  label: string,
  permissions: string[],
): Promise<string> {
  const minted = await management.createKey({
    label,
    source: label,
    permissions: permissions as never,
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  return minted.data.key;
}

function grants(credential?: string): Promise<Response> {
  return fetch(`${server.apiUrl}/auth/grants`, {
    headers:
      credential === undefined ? {} : { authorization: `Bearer ${credential}` },
  });
}

function revokeGrant(
  id: string,
  credential: string,
  query = "",
): Promise<Response> {
  return fetch(`${server.apiUrl}/auth/grants/${id}${query}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${credential}` },
  });
}

/** An app the person approved, and the grant the listing shows for it. */
async function approved(): Promise<{
  clientId: string;
  access: string;
  grant: Grant;
}> {
  const app = await registerApp(server, SCOPE);
  const issued = await connect(server, origin, cookie, app, SCOPE);
  const listed = await grants(server.managementKey);
  expect(listed.status).toBe(200);
  const body = (await listed.json()) as {
    data: Grant[];
    next_cursor: null;
  };
  const grant = body.data.find((g) => g.client_id === app.clientId);
  expect(grant, "the approved app is not listed").toBeDefined();
  return { clientId: app.clientId, access: issued.access_token!, grant: grant! };
}

/** A key an app mints with its token, as a client of that app's. */
async function mintedBy(
  access: string,
  label: string,
  body: Record<string, unknown> = {},
): Promise<{ id: string; key: string }> {
  const minted = await new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: access,
  }).createKey({ label, source: label, ...body });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  return { id: minted.data.id, key: minted.data.key };
}

describe("GET /auth/grants", () => {
  it("lists each app the person approved, with its client, scopes and status, in one page", async () => {
    const { clientId, grant } = await approved();
    expect(grant.kind).toBe("app");
    expect(grant.client_id).toBe(clientId);
    expect(grant.scopes.sort()).toEqual(SCOPE.split(" ").sort());
    expect(grant.status).toBe("active");
    expect(Number.isNaN(Date.parse(grant.granted_at))).toBe(false);
    const listed = (await (await grants(server.managementKey)).json()) as {
      next_cursor: unknown;
    };
    expect(listed.next_cursor).toBeNull();
  });

  it("refuses a caller without grants.manage 403, naming it, and a request with no credential 401", async () => {
    const { grant } = await approved();
    const without = await keyHolding("grants-without", ["audit.read"]);
    const listed = await grants(without);
    expect(listed.status).toBe(403);
    const refusal = (await listed.json()) as {
      error: { code: string; details?: { required_scope?: string } };
    };
    expect(refusal.error.code).toBe("forbidden");
    expect(refusal.error.details?.required_scope).toBe("grants.manage");
    const revoked = await revokeGrant(grant.id, without);
    expect(revoked.status).toBe(403);
    expect(
      ((await revoked.json()) as { error: { details?: unknown } }).error
        .details,
    ).toEqual({ required_scope: "grants.manage" });
    expect((await grants()).status).toBe(401);
    // The witness: a caller holding it lists the grant the refusal kept.
    const holder = await keyHolding("grants-holder", ["grants.manage"]);
    const allowed = await grants(holder);
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as { data: Grant[] };
    expect(body.data.map((g) => g.id)).toContain(grant.id);
  });
});

describe("DELETE /auth/grants/{id}", () => {
  it("ends the app's tokens and the person's consent, and leaves the keys it minted working", async () => {
    const { clientId, access, grant } = await approved();
    const key = await mintedBy(access, "grant-survivor", {
      permissions: ["keys.mint"],
      type_permissions: { "core.note": "read" },
    });
    const descendant = await mintedBy(key.key, "grant-survivor-child");
    expect(await itemsStatus(server, access)).toBe(200);

    const revoked = await revokeGrant(grant.id, server.managementKey);
    expect(revoked.status).toBe(204);
    expect(await itemsStatus(server, access)).toBe(401);
    expect(await itemsStatus(server, key.key)).toBe(200);
    expect(await itemsStatus(server, descendant.key)).toBe(200);
    const listed = (await (await grants(server.managementKey)).json()) as {
      data: Grant[];
    };
    expect(listed.data.map((g) => g.id)).not.toContain(grant.id);
    const asked = await sentTo(
      server,
      await authorize(server, authorizeQuery(clientId, SCOPE, pkce()), cookie),
    );
    expect(asked?.pathname, String(asked)).toBe("/auth/authorize");
  });

  it("with revoke_keys=1 also revokes every key the app minted, a key's descendant included", async () => {
    const { access, grant } = await approved();
    const key = await mintedBy(access, "grant-taken", {
      permissions: ["keys.mint"],
      type_permissions: { "core.note": "read" },
    });
    const descendant = await mintedBy(key.key, "grant-taken-child");
    // The witness: a key no app minted, which the revoke leaves alone.
    const unrelated = await keyHolding("grant-unrelated", []);
    const unrelatedClient = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: unrelated,
    });

    const revoked = await revokeGrant(
      grant.id,
      server.managementKey,
      "?revoke_keys=1",
    );
    expect(revoked.status).toBe(204);
    expect(await itemsStatus(server, access)).toBe(401);
    expect(await itemsStatus(server, key.key)).toBe(401);
    expect(await itemsStatus(server, descendant.key)).toBe(401);
    expect((await unrelatedClient.getCurrentKey()).status).toBe(200);
  });
});
