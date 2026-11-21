import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  DAY_MS,
  movedClock,
  QUIET_SCHEDULE,
  quiet,
} from "../../utils/moved-clock.js";
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
  type App,
  type TokenAnswer,
} from "../../utils/signed-in.js";
import {
  ADMIN_TOOLS,
  ALL_TOOLS,
  connectMcp,
  toolNames,
} from "../../utils/mcp.js";

/**
 * What an app does with the tokens a person's approval gave it: refresh and
 * revoke. A token needs a person's approval, and an instance has one owner, so
 * this file boots a server of its own.
 */
let server: FreshServer;
let origin: string;
let cookie: string;

const NOTES = "core.note:read";
const MCP_PATHS = ["/mcp", "/mcp/schema", "/mcp/admin"];

beforeAll(async () => {
  server = await bootFreshServer("oauth-tokens");
  origin = await issuerOrigin(server);
  cookie = await signIn(server, origin);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function refresh(app: App, refreshToken: string) {
  return token(server, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: app.clientId,
  });
}

async function post(
  path: string,
  form: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const response = await fetch(`${server.apiUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(form),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text === "" ? null : JSON.parse(text)) as Record<
      string,
      unknown
    > | null,
  };
}

/** The grants `GET /grants` lists, by client. */
async function grantedClients(): Promise<string[]> {
  const response = await fetch(`${server.apiUrl}/grants`, {
    headers: { authorization: `Bearer ${server.workingKey}` },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { client_id: string }[] };
  return body.data.map((grant) => grant.client_id);
}

function revokeRefresh(app: App, refreshToken: string) {
  return post("/oauth/revoke", {
    token: refreshToken,
    token_type_hint: "refresh_token",
    client_id: app.clientId,
  });
}

/** The id `GET /grants` lists for the app's grant. */
async function grantIdOf(app: App): Promise<string> {
  const response = await fetch(`${server.apiUrl}/grants`, {
    headers: { authorization: `Bearer ${server.workingKey}` },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { id: string; client_id: string }[];
  };
  const grant = body.data.find((listed) => listed.client_id === app.clientId);
  if (grant === undefined) {
    throw new Error(`no grant listed for ${app.clientId}`);
  }
  return grant.id;
}

describe("refresh tokens", () => {
  it("are issued only to an authorization that asked for offline_access", async () => {
    const app = await registerApp(server, `${NOTES} offline_access`);
    const offline = await connect(
      server,
      origin,
      cookie,
      app,
      `${NOTES} offline_access`,
    );
    expect(offline.refresh_token).toMatch(/^marfa_rt_/);
    const online = await registerApp(server, NOTES);
    const access = await connect(server, origin, cookie, online, NOTES);
    expect(access.access_token).toBeTruthy();
    expect(access.refresh_token).toBeUndefined();
  });

  it("rotate: a refresh answers a new refresh token and an access token that works", async () => {
    const app = await registerApp(server, `${NOTES} offline_access`);
    const first = await connect(
      server,
      origin,
      cookie,
      app,
      `${NOTES} offline_access`,
    );
    const rotated = await refresh(app, first.refresh_token!);
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    expect(rotated.body.refresh_token).toMatch(/^marfa_rt_/);
    expect(rotated.body.refresh_token).not.toBe(first.refresh_token);
    expect(rotated.body.scope?.split(" ").sort()).toEqual(
      [NOTES, "offline_access"].sort(),
    );
    expect(await itemsStatus(server, rotated.body.access_token!)).toBe(200);
  });

  it("refuse a replayed refresh token invalid_grant, and end every token of its chain", async () => {
    const app = await registerApp(server, `${NOTES} offline_access`);
    const first = await connect(
      server,
      origin,
      cookie,
      app,
      `${NOTES} offline_access`,
    );
    const rotated = await refresh(app, first.refresh_token!);
    expect(rotated.status).toBe(200);
    // The witness: both access tokens work before the replay.
    expect(await itemsStatus(server, first.access_token!)).toBe(200);
    expect(await itemsStatus(server, rotated.body.access_token!)).toBe(200);

    const replayed = await refresh(app, first.refresh_token!);
    expect(replayed.status).toBe(400);
    expect(replayed.body.error).toBe("invalid_grant");
    expect(replayed.body.access_token).toBeUndefined();
    expect(await itemsStatus(server, first.access_token!)).toBe(401);
    expect(await itemsStatus(server, rotated.body.access_token!)).toBe(401);
    const successor = await refresh(app, rotated.body.refresh_token!);
    expect(successor.status).toBe(400);
    expect(successor.body.error).toBe("invalid_grant");
  });

  it("refuse a refresh token the server never issued invalid_grant", async () => {
    const app = await registerApp(server, `${NOTES} offline_access`);
    const refused = await refresh(app, `marfa_rt_${"0".repeat(64)}`);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("invalid_grant");
  });
});

describe("the resource parameter", () => {
  it("is accepted when it names this server, and the token works here", async () => {
    const app = await registerApp(server, NOTES);
    for (const resource of [origin, `${origin}/`]) {
      const { code, verifier } = await codeFor(
        server,
        origin,
        cookie,
        app,
        NOTES,
      );
      const issued = await token(server, {
        grant_type: "authorization_code",
        code,
        redirect_uri: CALLBACK,
        code_verifier: verifier,
        client_id: app.clientId,
        resource,
      });
      expect(issued.status, JSON.stringify(issued.body)).toBe(200);
      expect(issued.body.access_token).toMatch(/^marfa_at_/);
      expect(await itemsStatus(server, issued.body.access_token!)).toBe(200);
    }
  });

  it("is accepted at authorization and at the token request when it names an MCP endpoint, and the token works here", async () => {
    const app = await registerApp(server, NOTES);
    for (const path of MCP_PATHS) {
      const resource = `${origin}${path}`;
      const proof = pkce();
      const consent = await sentTo(
        server,
        await authorize(
          server,
          authorizeQuery(app.clientId, NOTES, proof, {
            prompt: "consent",
            resource,
          }),
          cookie,
        ),
      );
      expect(consent?.pathname, String(consent)).toBe("/auth/consent");
      const sent = await decide(server, origin, cookie, consent!, true, [
        NOTES,
      ]);
      const issued = await token(server, {
        grant_type: "authorization_code",
        code: sent?.searchParams.get("code") ?? "",
        redirect_uri: CALLBACK,
        code_verifier: proof.verifier,
        client_id: app.clientId,
        resource,
      });
      expect(issued.status, JSON.stringify(issued.body)).toBe(200);
      expect(issued.body.access_token).toMatch(/^marfa_at_/);
      expect(await itemsStatus(server, issued.body.access_token!)).toBe(200);
    }
  });

  it("is accepted when the scheme and host are in capitals", async () => {
    const app = await registerApp(server, NOTES);
    const capitals = origin.toUpperCase();
    expect(capitals).not.toBe(origin);
    for (const resource of [capitals, `${capitals}/mcp`]) {
      const { code, verifier } = await codeFor(
        server,
        origin,
        cookie,
        app,
        NOTES,
      );
      const issued = await token(server, {
        grant_type: "authorization_code",
        code,
        redirect_uri: CALLBACK,
        code_verifier: verifier,
        client_id: app.clientId,
        resource,
      });
      expect(issued.status, `${resource} ${JSON.stringify(issued.body)}`).toBe(
        200,
      );
      expect(await itemsStatus(server, issued.body.access_token!)).toBe(200);
    }
  });

  it("is refused invalid_target when it names another server", async () => {
    const app = await registerApp(server, NOTES);
    for (const resource of [
      "https://elsewhere.example",
      `${origin}/mcp/`,
      `${origin}/MCP`,
      `${origin}/mcp/other`,
      `${origin}/items`,
    ]) {
      const { code, verifier } = await codeFor(
        server,
        origin,
        cookie,
        app,
        NOTES,
      );
      const refused = await token(server, {
        grant_type: "authorization_code",
        code,
        redirect_uri: CALLBACK,
        code_verifier: verifier,
        client_id: app.clientId,
        resource,
      });
      expect(refused.status, resource).toBe(400);
      expect(refused.body.error).toBe("invalid_target");
      expect(refused.body.access_token).toBeUndefined();
    }
  });

  it("is refused invalid_target when a token request names more than one", async () => {
    const app = await registerApp(server, NOTES);
    const { code, verifier } = await codeFor(
      server,
      origin,
      cookie,
      app,
      NOTES,
    );
    const response = await fetch(`${server.apiUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([
        ["grant_type", "authorization_code"],
        ["code", code],
        ["redirect_uri", CALLBACK],
        ["code_verifier", verifier],
        ["client_id", app.clientId],
        ["resource", `${origin}/mcp`],
        ["resource", `${origin}/mcp/schema`],
      ]),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as TokenAnswer;
    expect(body.error).toBe("invalid_target");
    expect(body.access_token).toBeUndefined();
  });

  it("is refused at authorization to the redirect URI the app registered, with the request's state", async () => {
    const app = await registerApp(server, NOTES);
    const sent = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, NOTES, pkce(), {
          resource: "https://elsewhere.example",
        }),
        cookie,
      ),
    );
    expect(sent?.href.startsWith(CALLBACK), String(sent)).toBe(true);
    expect(sent?.searchParams.get("error")).toBe("invalid_target");
    expect(sent?.searchParams.get("state")).toBe("signed-in-fixture");
    expect(sent?.searchParams.get("code")).toBeNull();
  });

  it("is refused at authorization 400 invalid_target when the redirect URI is not one the app registered", async () => {
    const app = await registerApp(server, NOTES);
    const query = authorizeQuery(app.clientId, NOTES, pkce(), {
      resource: "https://elsewhere.example",
    });
    query.set("redirect_uri", "http://127.0.0.1:9/elsewhere");
    const response = await authorize(server, query, cookie);
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    const body = (await response.json()) as TokenAnswer;
    expect(body.error).toBe("invalid_target");
  });
});

describe("the MCP endpoint", () => {
  /**
   * A token for `scope`, with `resource` named at authorization and at the
   * token request, approved with the scopes it names or with `access`.
   */
  async function tokenNaming(
    app: App,
    scope: string,
    resource: string,
    access?: string,
  ): Promise<string> {
    const proof = pkce();
    const consent = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, scope, proof, {
          prompt: "consent",
          resource,
        }),
        cookie,
      ),
    );
    const sent = await decide(
      server,
      origin,
      cookie,
      consent!,
      true,
      access === undefined ? scope.split(" ") : [],
      [],
      access,
    );
    const issued = await token(server, {
      grant_type: "authorization_code",
      code: sent?.searchParams.get("code") ?? "",
      redirect_uri: CALLBACK,
      code_verifier: proof.verifier,
      client_id: app.clientId,
      resource,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    return issued.body.access_token!;
  }

  function mcp(accessToken: string, message: unknown): Promise<Response> {
    return fetch(`${server.apiUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(message),
    });
  }

  it("accepts a token at the API and at /mcp, whichever of the server's resources it was issued for", async () => {
    const app = await registerApp(server, NOTES);
    for (const resource of [origin, ...MCP_PATHS.map((p) => `${origin}${p}`)]) {
      const accessToken = await tokenNaming(app, NOTES, resource);
      expect(await itemsStatus(server, accessToken), resource).toBe(200);
      const listed = await mcp(accessToken, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      expect(listed.status, resource).toBe(200);
      expect(await listed.text(), resource).toContain("marfa_find");
    }
  });

  it("challenges a tool call the token lacks a scope for with 403 insufficient_scope, naming the scope and the endpoint's metadata", async () => {
    const scope = "core.task:write core.note:read";
    const app = await registerApp(server, scope);
    const accessToken = await tokenNaming(app, scope, `${origin}/mcp`);
    const create = (type: string) =>
      mcp(accessToken, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "marfa_create",
          arguments: { type, properties: { title: "Needs a scope" } },
        },
      });
    const challenged = await create("core.note");
    expect(challenged.status).toBe(403);
    const header = challenged.headers.get("www-authenticate") ?? "";
    expect(header).toMatch(/^Bearer /);
    expect(header).toContain('error="insufficient_scope"');
    expect(header).toContain('scope="core.note:write"');
    expect(header).toContain(
      `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    );
    await challenged.body?.cancel();
    // The witness: the type the token writes is saved.
    const saved = await create("core.task");
    expect(saved.status).toBe(200);
    expect(await saved.text()).toContain("created");
  });

  it("lists every admin tool at /mcp/admin to an app that asks for exactly the scopes its metadata names and is given full access", async () => {
    const metadata = await fetch(
      `${server.apiUrl}/.well-known/oauth-protected-resource/mcp/admin`,
    );
    expect(metadata.status).toBe(200);
    const advertised = (
      (await metadata.json()) as { scopes_supported: string[] }
    ).scopes_supported;
    const scope = advertised.join(" ");
    const app = await registerApp(server, scope);
    const accessToken = await tokenNaming(
      app,
      scope,
      `${origin}/mcp/admin`,
      "full",
    );
    const connection = await connectMcp(
      server.apiUrl,
      accessToken,
      "2026-07-28",
      "/mcp/admin",
    );
    try {
      expect(await toolNames(connection)).toEqual(
        [...ALL_TOOLS, ...ADMIN_TOOLS].sort(),
      );
    } finally {
      await connection.close();
    }

    // A client naming no scope is still registered for what /mcp names alone.
    const items = (
      (await (
        await fetch(`${server.apiUrl}/.well-known/oauth-protected-resource/mcp`)
      ).json()) as { scopes_supported: string[] }
    ).scopes_supported;
    const unnamed = await fetch(`${server.apiUrl}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "names no scope",
        application_type: "native",
        redirect_uris: [CALLBACK],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    expect(unnamed.status).toBe(201);
    const registered = ((await unnamed.json()) as { scope: string }).scope;
    expect(registered.split(" ").sort()).toEqual([...items].sort());
    expect(advertised.length).toBeGreaterThan(items.length);
  });

  it("answers a tool call naming a type nothing registered with the tool's error, not a challenge", async () => {
    const scope = "core.task:write core.note:read";
    const app = await registerApp(server, scope);
    const accessToken = await tokenNaming(app, scope, `${origin}/mcp`);
    const answer = await mcp(accessToken, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "marfa_create",
        arguments: { type: "core.notez", properties: { title: "Misspelled" } },
      },
    });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("www-authenticate")).toBeNull();
    const text = await answer.text();
    expect(text).toContain('"isError":true');
    expect(text).toContain("type_not_permitted");
  });
});

/** Lowercase letters no earlier attempt used, for a vendor a retry must find unheld. */
function letters(): string {
  return Array.from({ length: 8 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join("");
}

describe("registering a type from /mcp/schema", () => {
  const SCHEMA_APP = "metadata.types:write core.note:read";

  /** A token for `scope` issued for the schema endpoint, to `app` or to a new app. */
  async function schemaToken(scope: string, given?: App): Promise<string> {
    const app = given ?? (await registerApp(server, scope));
    const proof = pkce();
    const resource = `${origin}/mcp/schema`;
    const consent = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, scope, proof, {
          prompt: "consent",
          resource,
        }),
        cookie,
      ),
    );
    const sent = await decide(server, origin, cookie, consent!, true, [
      ...scope.split(" "),
    ]);
    const issued = await token(server, {
      grant_type: "authorization_code",
      code: sent?.searchParams.get("code") ?? "",
      redirect_uri: CALLBACK,
      code_verifier: proof.verifier,
      client_id: app.clientId,
      resource,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    return issued.body.access_token!;
  }

  function register(accessToken: string, id: string): Promise<Response> {
    return fetch(`${server.apiUrl}/mcp/schema`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "marfa_save_type",
          arguments: {
            action: "register",
            id,
            label: "Recipe",
            fields: { title: { type: "string" } },
          },
        },
      }),
    });
  }

  it("asks an app holding metadata.types:write alone for the namespace wildcard covering the new name, and registers it for an app holding both", async () => {
    const narrow = await register(await schemaToken(SCHEMA_APP), "user.recipe");
    expect(narrow.status).toBe(403);
    const header = narrow.headers.get("www-authenticate") ?? "";
    expect(header).toContain('error="insufficient_scope"');
    expect(header).toContain('scope="user.*:write"');
    expect(header).toContain(
      `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp/schema"`,
    );
    await narrow.body?.cancel();
    // The witness: the namespace the challenge named registers the type.
    const granted = await register(
      await schemaToken(`${SCHEMA_APP} user.*:write`),
      "user.recipe",
    );
    expect(granted.status).toBe(200);
    expect(await granted.text()).toContain("user.recipe");
  });

  it("asks for the vendor's own namespace where a type sits under it, and for app.* where none does", async () => {
    const tag = letters();
    const vendor = `app.held${tag}`;
    const wide = `${SCHEMA_APP} app.*:write`;
    const app = await registerApp(server, wide);
    const claimed = await register(
      await schemaToken(wide, app),
      `${vendor}.widget`,
    );
    expect(claimed.status).toBe(200);
    expect(await claimed.text()).not.toContain('"isError":true');
    const challenged = async (id: string): Promise<string> => {
      const answer = await register(await schemaToken(SCHEMA_APP, app), id);
      expect(answer.status, id).toBe(403);
      await answer.body?.cancel();
      return answer.headers.get("www-authenticate") ?? "";
    };
    expect(await challenged(`${vendor}.gizmo`)).toContain(
      `scope="${vendor}.*:write"`,
    );
    expect(await challenged(`app.fresh${tag}.gizmo`)).toContain(
      'scope="app.*:write"',
    );
  });

  it("answers a name under a vendor held for the owner with the tool's error, not a challenge, whatever the scope", async () => {
    const tag = letters();
    const vendor = `app.owned${tag}`;
    const registered = await fetch(`${server.apiUrl}/types`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${server.workingKey}`,
      },
      body: JSON.stringify({
        id: `${vendor}.widget`,
        version: 1,
        fields: { title: { type: "string" } },
      }),
    });
    expect(registered.status).toBe(201);
    for (const scope of [SCHEMA_APP, `${SCHEMA_APP} ${vendor}.*:write`]) {
      const answer = await register(
        await schemaToken(scope),
        `${vendor}.gizmo`,
      );
      expect(answer.status, scope).toBe(200);
      expect(answer.headers.get("www-authenticate"), scope).toBeNull();
      const text = await answer.text();
      expect(text, scope).toContain('"isError":true');
      expect(text, scope).toContain(`/app-vendors/${vendor}`);
    }
  });

  it("answers a name in a namespace nothing grants with the tool's error, not a challenge", async () => {
    const answer = await register(
      await schemaToken(SCHEMA_APP),
      "unheard.recipe",
    );
    expect(answer.status).toBe(200);
    expect(answer.headers.get("www-authenticate")).toBeNull();
    expect(await answer.text()).toContain('"isError":true');
  });
});

describe("revocation", () => {
  it("of an access token ends it at once", async () => {
    const app = await registerApp(server, NOTES);
    const issued = await connect(server, origin, cookie, app, NOTES);
    expect(await itemsStatus(server, issued.access_token!)).toBe(200);
    const revoked = await post("/oauth/revoke", {
      token: issued.access_token!,
      token_type_hint: "access_token",
      client_id: app.clientId,
    });
    expect(revoked.status).toBe(200);
    expect(await itemsStatus(server, issued.access_token!)).toBe(401);
    const again = await post("/oauth/revoke", {
      token: issued.access_token!,
      client_id: app.clientId,
    });
    expect(again.status).toBe(200);
  });

  it("of a refresh token ends the app's grant: its tokens, its listing and the person's consent", async () => {
    const app = await registerApp(server, `${NOTES} offline_access`);
    const issued = await connect(
      server,
      origin,
      cookie,
      app,
      `${NOTES} offline_access`,
    );
    // The witness: the grant is listed, and the consent stands.
    expect(await grantedClients()).toContain(app.clientId);
    expect((await codeFor(server, origin, cookie, app, NOTES)).silent).toBe(
      true,
    );

    const revoked = await post("/oauth/revoke", {
      token: issued.refresh_token!,
      token_type_hint: "refresh_token",
      client_id: app.clientId,
    });
    expect(revoked.status).toBe(200);
    expect(await itemsStatus(server, issued.access_token!)).toBe(401);
    const refreshed = await refresh(app, issued.refresh_token!);
    expect(refreshed.status).toBe(400);
    expect(refreshed.body.error).toBe("invalid_grant");
    expect(await grantedClients()).not.toContain(app.clientId);
    const asked = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, NOTES, pkce()),
        cookie,
      ),
    );
    expect(asked?.pathname, String(asked)).toBe("/auth/consent");
  });

  it("of a refresh token a refresh already rotated ends the app's grant and its newest refresh token", async () => {
    const app = await registerApp(server, `${NOTES} offline_access`);
    const first = await connect(
      server,
      origin,
      cookie,
      app,
      `${NOTES} offline_access`,
    );
    const rotated = await refresh(app, first.refresh_token!);
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    expect(await itemsStatus(server, rotated.body.access_token!)).toBe(200);
    expect(await grantedClients()).toContain(app.clientId);

    const revoked = await revokeRefresh(app, first.refresh_token!);
    expect(revoked.status).toBe(200);
    expect(await itemsStatus(server, rotated.body.access_token!)).toBe(401);
    const newest = await refresh(app, rotated.body.refresh_token!);
    expect(newest.status).toBe(400);
    expect(newest.body.error).toBe("invalid_grant");
    expect(await grantedClients()).not.toContain(app.clientId);
  });

  it("of the newest refresh token after a rotation ends the app's grant", async () => {
    const app = await registerApp(server, `${NOTES} offline_access`);
    const first = await connect(
      server,
      origin,
      cookie,
      app,
      `${NOTES} offline_access`,
    );
    const rotated = await refresh(app, first.refresh_token!);
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);

    const revoked = await revokeRefresh(app, rotated.body.refresh_token!);
    expect(revoked.status).toBe(200);
    expect(await itemsStatus(server, rotated.body.access_token!)).toBe(401);
    const again = await refresh(app, rotated.body.refresh_token!);
    expect(again.status).toBe(400);
    expect(await grantedClients()).not.toContain(app.clientId);
  });

  it("of a refresh token from before the person revoked the grant and approved the app again leaves the new approval", async () => {
    const app = await registerApp(server, `${NOTES} offline_access`);
    const scope = `${NOTES} offline_access`;
    const before = await connect(server, origin, cookie, app, scope);
    const beforeRotated = await refresh(app, before.refresh_token!);
    expect(beforeRotated.status, JSON.stringify(beforeRotated.body)).toBe(200);
    const grantId = await grantIdOf(app);
    const ended = await fetch(`${server.apiUrl}/grants/${grantId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${server.managementKey}` },
    });
    expect(ended.status).toBe(200);
    const after = await connect(server, origin, cookie, app, scope);
    expect(await grantIdOf(app)).toBe(grantId);

    for (const old of [
      before.refresh_token!,
      beforeRotated.body.refresh_token!,
    ]) {
      expect((await revokeRefresh(app, old)).status).toBe(200);
    }
    expect(await grantIdOf(app)).toBe(grantId);
    expect(await itemsStatus(server, after.access_token!)).toBe(200);
    const renewed = await refresh(app, after.refresh_token!);
    expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);
    expect(await itemsStatus(server, renewed.body.access_token!)).toBe(200);

    // The witness: a token of the new approval still ends it.
    expect((await revokeRefresh(app, renewed.body.refresh_token!)).status).toBe(
      200,
    );
    expect(await itemsStatus(server, renewed.body.access_token!)).toBe(401);
    expect(await grantedClients()).not.toContain(app.clientId);
  });

  it("of a refresh token whose chain a replay ended leaves the grant and its other sign-ins", async () => {
    const app = await registerApp(server, `${NOTES} offline_access`);
    const scope = `${NOTES} offline_access`;
    const replayedChain = await connect(server, origin, cookie, app, scope);
    const other = await connect(server, origin, cookie, app, scope);
    expect((await refresh(app, replayedChain.refresh_token!)).status).toBe(200);
    expect((await refresh(app, replayedChain.refresh_token!)).status).toBe(400);

    expect(
      (await revokeRefresh(app, replayedChain.refresh_token!)).status,
    ).toBe(200);
    expect(await grantedClients()).toContain(app.clientId);
    expect(await itemsStatus(server, other.access_token!)).toBe(200);
    const renewed = await refresh(app, other.refresh_token!);
    expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);
  });

  it("of another app's refresh token, an unknown one or a malformed one answers 200 and changes nothing", async () => {
    const app = await registerApp(server, `${NOTES} offline_access`);
    const otherApp = await registerApp(server, `${NOTES} offline_access`);
    const scope = `${NOTES} offline_access`;
    const first = await connect(server, origin, cookie, app, scope);
    const rotated = await refresh(app, first.refresh_token!);
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    const grantId = await grantIdOf(app);

    for (const held of [first.refresh_token!, rotated.body.refresh_token!]) {
      expect((await revokeRefresh(otherApp, held)).status).toBe(200);
    }
    expect(
      (await revokeRefresh(app, `marfa_rt_${"0".repeat(64)}`)).status,
    ).toBe(200);
    expect((await revokeRefresh(app, "not a token")).status).toBe(200);
    expect(await grantIdOf(app)).toBe(grantId);
    expect(await itemsStatus(server, rotated.body.access_token!)).toBe(200);
    const renewed = await refresh(app, rotated.body.refresh_token!);
    expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);

    // The witness: the app's own rotated token still ends the grant.
    expect((await revokeRefresh(app, first.refresh_token!)).status).toBe(200);
    expect(await itemsStatus(server, renewed.body.access_token!)).toBe(401);
    expect(await grantedClients()).not.toContain(app.clientId);
  });

  it(
    "of a refresh token past its own expiry leaves the grant and its live sign-in",
    async () => {
      const moved = await bootFreshServer(
        "oauth-tokens-expired-refresh",
        QUIET_SCHEDULE,
      );
      try {
        await quiet(moved, ["credential-cleanup"]);
        const movedOrigin = await issuerOrigin(moved);
        const movedCookie = await signIn(moved, movedOrigin);
        const scope = `${NOTES} offline_access`;
        const app = await registerApp(moved, scope);
        const renew = (refreshToken: string) =>
          token(moved, {
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: app.clientId,
          });
        const revoke = async (refreshToken: string) => {
          const answered = await fetch(`${moved.apiUrl}/oauth/revoke`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              token: refreshToken,
              token_type_hint: "refresh_token",
              client_id: app.clientId,
            }),
          });
          expect(answered.status).toBe(200);
        };
        const granted = async (): Promise<boolean> => {
          const response = await fetch(`${moved.apiUrl}/grants`, {
            headers: { authorization: `Bearer ${moved.managementKey}` },
          });
          expect(response.status).toBe(200);
          const body = (await response.json()) as {
            data: { client_id: string }[];
          };
          return body.data.some((grant) => grant.client_id === app.clientId);
        };

        const unused = await connect(
          moved,
          movedOrigin,
          movedCookie,
          app,
          scope,
        );
        const live = await connect(moved, movedOrigin, movedCookie, app, scope);
        const clock = movedClock(moved);
        await clock.advance(10 * DAY_MS);
        const rotated = await renew(live.refresh_token!);
        expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
        // Past the 30 days a refresh token lives, short of the renewed one.
        await clock.advance(21 * DAY_MS);

        for (const expired of [unused.refresh_token!, live.refresh_token!]) {
          await revoke(expired);
        }
        expect(await granted()).toBe(true);
        const renewed = await renew(rotated.body.refresh_token!);
        expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);
        expect(await itemsStatus(moved, renewed.body.access_token!)).toBe(200);

        // The witness: a token of the live chain ends the grant.
        await revoke(renewed.body.refresh_token!);
        expect(await granted()).toBe(false);
        expect(await itemsStatus(moved, renewed.body.access_token!)).toBe(401);
      } finally {
        await moved.stop();
      }
    },
    4 * FRESH_SERVER_TIMEOUT_MS,
  );
});
