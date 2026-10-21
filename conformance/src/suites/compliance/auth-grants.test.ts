import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  authorize,
  authorizeQuery,
  CALLBACK,
  codeFor,
  connect,
  decide,
  issuerOrigin,
  itemsStatus,
  pkce,
  registerApp,
  sentTo,
  signIn,
  token,
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
  await expectMatchesSchema("GET", "/auth/grants", 200, body);
  const grant = body.data.find((g) => g.client_id === app.clientId);
  expect(grant, "the approved app is not listed").toBeDefined();
  return {
    clientId: app.clientId,
    access: issued.access_token!,
    grant: grant!,
  };
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
  it("classifies registered native, web and device apps", async () => {
    for (const kind of ["app", "web", "cli"] as const) {
      const redirect =
        kind === "web" ? "https://reader.example/callback" : CALLBACK;
      const app = await registerApp(server, SCOPE, {
        application_type: kind === "web" ? "web" : "native",
        redirect_uris: [redirect],
        grant_types: [
          "authorization_code",
          "refresh_token",
          ...(kind === "cli"
            ? ["urn:ietf:params:oauth:grant-type:device_code"]
            : []),
        ],
      });
      const consent = await sentTo(
        server,
        await authorize(
          server,
          authorizeQuery(app.clientId, SCOPE, pkce(), {
            redirect_uri: redirect,
          }),
          cookie,
        ),
      );
      expect(consent?.pathname).toBe("/auth/authorize");
      await decide(server, origin, cookie, consent!, true, SCOPE.split(" "));
      const listed = (await (await grants(server.managementKey)).json()) as {
        data: Grant[];
      };
      expect(
        listed.data.find((row) => row.client_id === app.clientId)?.kind,
      ).toBe(kind);
    }
  });

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

describe("a code whose grant is revoked", () => {
  it("is refused invalid_grant when exchanged after the grant was revoked", async () => {
    const { clientId, grant } = await approved();
    const app = { clientId };
    // A fresh code under the standing consent, answered without a screen.
    const { code, verifier, silent } = await codeFor(
      server,
      origin,
      cookie,
      app,
      SCOPE,
    );
    expect(silent).toBe(true);
    const revoked = await revokeGrant(grant.id, server.managementKey);
    expect(revoked.status).toBe(204);
    const exchanged = await token(server, {
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
      client_id: clientId,
    });
    expect(exchanged.status).toBe(400);
    expect(exchanged.body.error).toBe("invalid_grant");
    expect(exchanged.body.access_token).toBeUndefined();
  });
});

describe("PATCH /auth/grants/{id}", () => {
  const narrow = (id: string, expected: string[], scopes: string[]) =>
    fetch(`${server.apiUrl}/auth/grants/${id}`, {
      method: "PATCH",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ expected_scopes: expected, scopes }),
    });

  it("narrows access, ends overbroad tokens, refuses widening and stale choices, and asks before restoring access", async () => {
    const { clientId, access, grant } = await approved();
    expect(await itemsStatus(server, access)).toBe(200);
    expect((await narrow(grant.id, grant.scopes, ["*:write"])).status).toBe(
      403,
    );
    const scopes = ["core.note:read"];
    const response = await narrow(grant.id, grant.scopes, scopes);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toEqual({ scopes });
    await expectMatchesSchema("PATCH", "/auth/grants/{id}", 200, result);
    expect(await itemsStatus(server, access)).toBe(401);
    expect((await narrow(grant.id, grant.scopes, scopes)).status).toBe(409);
    const listed = (await (await grants(server.managementKey)).json()) as {
      data: Grant[];
    };
    expect(listed.data.find((row) => row.id === grant.id)?.scopes).toEqual(
      scopes,
    );
    const wider = await sentTo(
      server,
      await authorize(server, authorizeQuery(clientId, SCOPE, pkce()), cookie),
    );
    expect(wider?.pathname).toBe("/auth/authorize");
    const kept = await codeFor(
      server,
      origin,
      cookie,
      { clientId },
      "core.note:read",
    );
    expect(kept.silent).toBe(true);
  });

  it("rolls back narrowed access and tokens when its audit cannot be written", async () => {
    const { grant, access, clientId } = await approved();
    await server.setFault("fail:audit=auth.grant.narrowed");
    try {
      expect((await narrow(grant.id, grant.scopes, [])).status).toBe(500);
      expect(
        (await server.faults()).find((f) => f.name === "fail:audit")?.fired,
      ).toBe(1);
    } finally {
      await server.clearFault();
    }
    const listed = (await (await grants(server.managementKey)).json()) as {
      data: Grant[];
    };
    expect(listed.data.find((row) => row.id === grant.id)?.scopes).toEqual(
      grant.scopes,
    );
    expect(await itemsStatus(server, access)).toBe(200);
    expect(
      (await codeFor(server, origin, cookie, { clientId }, SCOPE)).silent,
    ).toBe(true);
    expect((await narrow(grant.id, grant.scopes, [])).status).toBe(200);
    expect(await itemsStatus(server, access)).toBe(401);
  });

  it("preserves covered token chains and withdraws overbroad chains and pending codes", async () => {
    const broad = "core.note:write offline_access";
    const kept = "core.note:read offline_access";
    const app = await registerApp(server, broad);
    const wide = await connect(server, origin, cookie, app, broad);
    const read = await connect(server, origin, cookie, app, kept);
    const code = await codeFor(server, origin, cookie, app, broad);
    const listed = (await (await grants(server.managementKey)).json()) as {
      data: Grant[];
    };
    const grant = listed.data.find((row) => row.client_id === app.clientId)!;
    expect((await narrow(grant.id, grant.scopes, kept.split(" "))).status).toBe(
      200,
    );
    expect(await itemsStatus(server, wide.access_token!)).toBe(401);
    expect(await itemsStatus(server, read.access_token!)).toBe(200);
    expect(
      (
        await token(server, {
          grant_type: "refresh_token",
          client_id: app.clientId,
          refresh_token: wide.refresh_token!,
        })
      ).status,
    ).toBe(400);
    const renewed = await token(server, {
      grant_type: "refresh_token",
      client_id: app.clientId,
      refresh_token: read.refresh_token!,
    });
    expect(renewed.status).toBe(200);
    expect(await itemsStatus(server, renewed.body.access_token!)).toBe(200);
    expect(
      (
        await token(server, {
          grant_type: "authorization_code",
          client_id: app.clientId,
          code: code.code,
          code_verifier: code.verifier,
          redirect_uri: CALLBACK,
        })
      ).status,
    ).toBe(400);
  });

  it("requires direct owner authority and reports an unknown grant", async () => {
    const { grant } = await approved();
    expect(
      (
        await fetch(`${server.apiUrl}/auth/grants/${grant.id}`, {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${server.managementKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ expected_scopes: grant.scopes, scopes: [] }),
        })
      ).status,
    ).toBe(403);
    expect((await narrow("missing-grant", [], [])).status).toBe(404);
  });

  it("reports the inactivity boundary from last use or approval on the app sign-in", async () => {
    const { grant } = await approved();
    const response = await fetch(`${server.apiUrl}/owner/sign-ins`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        id: string;
        created_at: string;
        last_used_at: string | null;
        expires_at: string | null;
      }[];
    };
    const app = body.data.find((row) => row.id === grant.id)!;
    expect(app.expires_at).toBe(
      new Date(
        Date.parse(app.last_used_at ?? app.created_at) + 365 * 86_400_000,
      ).toISOString(),
    );
  });
});
