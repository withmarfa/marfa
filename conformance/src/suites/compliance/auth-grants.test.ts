import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { MarfaClient } from "../../client/api.js";
import { controlRequest } from "../../utils/control-request.js";
import { callTool, connectMcp } from "../../utils/mcp.js";
import { collectUntil, withStream } from "../../utils/stream.js";
import {
  DAY_MS,
  movedClock,
  QUIET_SCHEDULE,
  runJob,
} from "../../utils/moved-clock.js";
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
  server = await bootFreshServer("auth-grants", QUIET_SCHEDULE);
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
  it("classifies registered native, web, command line and other device apps", async () => {
    const cases = [
      { kind: "app", device: false, registration: {} },
      { kind: "web", device: false, registration: {} },
      {
        kind: "cli",
        device: true,
        registration: { software_id: "so.marfa.cli" },
      },
      // A device-grant client that is not the command line is an app, even
      // when it calls itself "marfa".
      {
        kind: "app",
        device: true,
        registration: { client_name: "marfa" },
      },
      {
        kind: "app",
        device: true,
        registration: { software_id: "so.example.set-top-box" },
      },
    ];
    for (const { kind, device, registration } of cases) {
      const web = kind === "web";
      const redirect = web ? "https://reader.example/callback" : CALLBACK;
      const app = await registerApp(server, SCOPE, {
        application_type: web ? "web" : "native",
        redirect_uris: [redirect],
        grant_types: [
          "authorization_code",
          "refresh_token",
          ...(device ? ["urn:ietf:params:oauth:grant-type:device_code"] : []),
        ],
        ...registration,
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
    expect(revoked.status).toBe(200);
    await expectMatchesSchema(
      "DELETE",
      "/auth/grants/{id}",
      200,
      await revoked.json(),
    );
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

  it("with revoke_keys=true also revokes every key the app minted, a key's descendant included", async () => {
    const { access, grant } = await approved();
    const key = await mintedBy(access, "grant-taken", {
      permissions: ["keys.mint"],
      type_permissions: { "core.note": "read" },
    });
    const descendant = await mintedBy(key.key, "grant-taken-child");
    // The witnesses: a key no app minted, a key the owner minted through the
    // local command, and another app with a key it minted.
    const unrelated = await keyHolding("grant-unrelated", []);
    const unrelatedClient = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: unrelated,
    });
    const local = await controlRequest(server.controlSocket, "/keys", {
      method: "POST",
      body: {
        label: "grant-local",
        source: "grant-local",
        type_permissions: { "core.note": "read" },
      },
    });
    expect(local.status, JSON.stringify(local.body)).toBe(201);
    const localKey = (local.body as { key: string }).key;
    const otherApp = await approved();
    const otherKey = await mintedBy(otherApp.access, "grant-other-app");
    expect(await itemsStatus(server, key.key)).toBe(200);
    expect(await itemsStatus(server, descendant.key)).toBe(200);

    const revoked = await revokeGrant(
      grant.id,
      server.managementKey,
      "?revoke_keys=true",
    );
    expect(revoked.status).toBe(200);
    expect(await itemsStatus(server, access)).toBe(401);
    expect(await itemsStatus(server, key.key)).toBe(401);
    expect(await itemsStatus(server, descendant.key)).toBe(401);
    expect((await unrelatedClient.getCurrentKey()).status).toBe(200);
    expect(await itemsStatus(server, localKey)).toBe(200);
    expect(await itemsStatus(server, otherApp.access)).toBe(200);
    expect(await itemsStatus(server, otherKey.key)).toBe(200);
  });

  it("refuses a revoke_keys that is neither true nor false, or is named twice, 400, and leaves the grant and the keys working", async () => {
    const { access, grant } = await approved();
    const key = await mintedBy(access, "grant-unreadable", {
      permissions: ["keys.mint"],
      type_permissions: { "core.note": "read" },
    });
    for (const value of [
      "1",
      "yes",
      "True",
      "",
      "false&revoke_keys=yes",
      "yes&revoke_keys=false",
      "true&revoke_keys=true",
      "false&revoke_keys=false",
    ]) {
      const refused = await revokeGrant(
        grant.id,
        server.managementKey,
        `?revoke_keys=${value}`,
      );
      expect(refused.status, value).toBe(400);
      expect(refused.headers.get("x-error-code")).toBe("validation_error");
      expect(await itemsStatus(server, access)).toBe(200);
      expect(await itemsStatus(server, key.key)).toBe(200);
    }
    // The witnesses: false reads, and the grant was there to end.
    const kept = await revokeGrant(
      grant.id,
      server.managementKey,
      "?revoke_keys=false",
    );
    expect(kept.status).toBe(200);
    expect(await itemsStatus(server, access)).toBe(401);
    expect(await itemsStatus(server, key.key)).toBe(200);
  });

  it("refuses a caller without grants.manage 403 whatever query it sends, at both doors", async () => {
    const { access, grant } = await approved();
    const without = await keyHolding("grants-query-without", ["audit.read"]);
    const listed = await fetch(`${server.apiUrl}/auth/grants?stray=1`, {
      headers: { authorization: `Bearer ${without}` },
    });
    expect(listed.status).toBe(403);
    const revoked = await revokeGrant(grant.id, without, "?stray=1");
    expect(revoked.status).toBe(403);
    expect(
      ((await revoked.json()) as { error: { details?: unknown } }).error
        .details,
    ).toEqual({ required_scope: "grants.manage" });
    expect(await itemsStatus(server, access)).toBe(200);
    // The witness: the same queries from a caller holding it are refused 400.
    const holder = await keyHolding("grants-query-holder", ["grants.manage"]);
    const asHolder = await fetch(`${server.apiUrl}/auth/grants?stray=1`, {
      headers: { authorization: `Bearer ${holder}` },
    });
    expect(asHolder.status).toBe(400);
    const revokedAsHolder = await revokeGrant(grant.id, holder, "?stray=1");
    expect(revokedAsHolder.status).toBe(400);
    expect(await itemsStatus(server, access)).toBe(200);
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
    expect(revoked.status).toBe(200);
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
  const narrow = async (id: string, expected: string[], scopes: string[]) => {
    const answer = await controlRequest(
      server.controlSocket,
      `/auth/grants/${id}`,
      { method: "PATCH", body: { expected_scopes: expected, scopes } },
    );
    return Response.json(answer.body, { status: answer.status });
  };

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

  it("requires the local command and reports an unknown grant", async () => {
    const { grant } = await approved();
    const sent = (headers: Record<string, string>) =>
      fetch(`${server.apiUrl}/auth/grants/${grant.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ expected_scopes: grant.scopes, scopes: [] }),
      });
    expect(
      (await sent({ authorization: `Bearer ${server.managementKey}` })).status,
    ).toBe(403);
    expect((await sent({})).status).toBe(401);
    expect((await sent({ cookie, origin })).status).toBe(401);
    expect((await narrow("missing-grant", [], [])).status).toBe(404);
  });

  it("reports the inactivity boundary from last use or approval on the app sign-in", async () => {
    const { grant } = await approved();
    const response = await controlRequest(
      server.controlSocket,
      "/owner/sign-ins",
    );
    expect(response.status).toBe(200);
    const body = response.body as unknown as {
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

describe("the apps a person approved, read as items", () => {
  /** What a credential is answered at one door, as text. */
  type Door = (credential: string) => Promise<{ status: number; text: string }>;

  let connectionId: string;
  /** Reads every type and holds no permission. */
  let reader: string;
  /** Reads every type and holds `grants.manage`. */
  let manager: string;

  function local(method: string, path: string, body?: unknown) {
    return controlRequest(server.controlSocket, path, { method, body });
  }

  async function readingKey(
    label: string,
    permissions: string[],
  ): Promise<string> {
    const minted = await local("POST", "/keys", {
      label,
      source: label,
      permissions,
      type_permissions: { "*": "read" },
      edge_permissions: { "*": "read" },
    });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    return minted.body.key as string;
  }

  async function answered(
    credential: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; text: string }> {
    const response = await fetch(`${server.apiUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  }

  /** Every door that answers items, each asked for everything it can show. */
  function doors(): [string, Door][] {
    const get =
      (path: string): Door =>
      (credential) =>
        answered(credential, path);
    const post =
      (path: string, body: unknown): Door =>
      (credential) =>
        answered(credential, path, body);
    return [
      ["GET /items", get("/items?include=system&limit=200")],
      ["GET /items/{id}", get(`/items/${connectionId}`)],
      [
        "POST /items/bulk-get",
        post("/items/bulk-get", {
          ids: [connectionId],
          include: ["system"],
        }),
      ],
      ["GET /items/stats", get("/items/stats?by=type&include=system")],
      ["GET /export", get("/export")],
      [
        "GET /events, replayed",
        async (credential) =>
          withStream(
            server.apiUrl,
            credential,
            { lastEventId: "0" },
            async (stream) => {
              const { raw } = await collectUntil(
                stream,
                (frames) => frames.some((f) => f.event === "stream_live"),
                "the replay's live marker",
                AbortSignal.timeout(15_000),
              );
              return { status: stream.response.status, text: raw };
            },
          ),
      ],
      [
        "marfa_find",
        async (credential) => {
          const mcp = await connectMcp(server.apiUrl, credential);
          try {
            const found = await callTool(mcp, "marfa_find", {
              type: "system.connection",
            });
            return { status: found.isError ? 403 : 200, text: found.text };
          } finally {
            await mcp.close();
          }
        },
      ],
    ];
  }

  beforeAll(async () => {
    const app = await registerApp(server, SCOPE);
    await connect(server, origin, cookie, app, SCOPE);
    reader = await readingKey("connections-reader", []);
    manager = await readingKey("connections-manager", ["grants.manage"]);
    const listed = await answered(
      manager,
      "/items?type=system.connection&include=system&limit=100",
    );
    expect(listed.status, listed.text).toBe(200);
    const row = (
      JSON.parse(listed.text) as {
        data: { id: string; properties: { client_id?: string } }[];
      }
    ).data.find((item) => item.properties.client_id === app.clientId);
    expect(row, "the approval wrote no system.connection item").toBeDefined();
    connectionId = row!.id;
  });

  it("shows a system.connection item at no door to a credential without grants.manage, though it reads every type", async () => {
    for (const [name, door] of doors()) {
      // The witness: the same door shows the item to a credential holding
      // grants.manage beside the same type map.
      const shown = await door(manager);
      expect(shown.status, `${name}: ${shown.text}`).toBe(200);
      const witness =
        name === "GET /items/stats" ? "system.connection" : connectionId;
      expect(shown.text, name).toContain(witness);

      const hidden = await door(reader);
      expect(hidden.text, name).not.toContain(connectionId);
      expect(hidden.text, name).not.toContain("system.connection");
    }
    // An item with no history yet shows only by its status.
    const versions = `/items/${connectionId}/versions`;
    expect((await answered(manager, versions)).status).toBe(200);
    expect((await answered(reader, versions)).status).toBe(404);
  });

  it("refuses a listing of system.connection to a credential without grants.manage, naming the permission", async () => {
    const path = "/items?type=system.connection&include=system";
    const shown = await answered(manager, path);
    expect(shown.status, shown.text).toBe(200);
    expect(shown.text).toContain(connectionId);

    const refused = await answered(reader, path);
    expect(refused.status, refused.text).toBe(403);
    const error = (
      JSON.parse(refused.text) as {
        error: { code: string; details?: { required_scope?: string } };
      }
    ).error;
    expect(error.code).toBe("forbidden");
    expect(error.details?.required_scope).toBe("grants.manage");
  });

  it("shows an app's system.connection items only where it holds grants.manage, whatever data scope it holds", async () => {
    const path = "/items?include=system&limit=200";
    const holding = await registerApp(server, "*:read grants.manage");
    const manages = await connect(
      server,
      origin,
      cookie,
      holding,
      "*:read grants.manage",
    );
    const shown = await answered(manages.access_token!, path);
    expect(shown.status, shown.text).toBe(200);
    expect(shown.text).toContain(connectionId);

    const plain = await registerApp(server, "*:read *:write");
    const reads = await connect(
      server,
      origin,
      cookie,
      plain,
      "*:read *:write",
    );
    const hidden = await answered(reads.access_token!, path);
    expect(hidden.status, hidden.text).toBe(200);
    expect(hidden.text).not.toContain("system.connection");
  });
});

describe("the keys an app minted, when its grant ends another way", () => {
  /** A key the app mints that may mint, and the key that key mints. */
  async function keysOf(
    access: string,
    label: string,
  ): Promise<[{ key: string }, { key: string }]> {
    const key = await mintedBy(access, label, {
      permissions: ["keys.mint"],
      type_permissions: { "core.note": "read" },
    });
    return [key, await mintedBy(key.key, `${label}-child`)];
  }

  it("leaves the keys an app minted working when the app revokes its refresh token", async () => {
    const scope = `${SCOPE} offline_access`;
    const app = await registerApp(server, scope);
    const issued = await connect(server, origin, cookie, app, scope);
    const [key, descendant] = await keysOf(
      issued.access_token!,
      "refresh-survivor",
    );

    const revoked = await fetch(`${server.apiUrl}/auth/oauth2/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: issued.refresh_token!,
        token_type_hint: "refresh_token",
        client_id: app.clientId,
      }),
    });
    expect(revoked.status).toBe(200);
    // The witness: the revocation ended the app.
    expect(await itemsStatus(server, issued.access_token!)).toBe(401);
    const afterRevoke = (await (await grants(server.managementKey)).json()) as {
      data: Grant[];
    };
    expect(afterRevoke.data.map((g) => g.client_id)).not.toContain(
      app.clientId,
    );
    expect(await itemsStatus(server, key.key)).toBe(200);
    expect(await itemsStatus(server, descendant.key)).toBe(200);
  });

  // Moves the clock past every grant's window, so it runs last.
  it("leaves the keys an idle app minted working when the inactivity retirement retires its grant", async () => {
    const { clientId, access } = await approved();
    const [key, descendant] = await keysOf(access, "idle-survivor");

    await movedClock(server).advance(366 * DAY_MS);
    expect((await runJob(server, "credential-cleanup")).outcome).toBe("ok");
    // The witness: the retirement ended the app.
    const listed = (await (await grants(server.managementKey)).json()) as {
      data: Grant[];
    };
    expect(listed.data.map((g) => g.client_id)).not.toContain(clientId);
    expect(await itemsStatus(server, key.key)).toBe(200);
    expect(await itemsStatus(server, descendant.key)).toBe(200);
    cookie = await signIn(server, origin);
  });
});
