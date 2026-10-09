import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  authorize,
  authorizeQuery,
  basicAuthorization,
  CALLBACK,
  codeFor,
  connect,
  issuerOrigin,
  itemsStatus,
  pkce,
  registerApp,
  sentTo,
  signIn,
  token,
  type App,
} from "../../utils/signed-in.js";

/**
 * What an app does with the tokens a person's approval gave it: refresh,
 * revoke, introspect and read the person's claims. A token needs a person's
 * approval, and an instance has one owner, so this file boots a server of its
 * own.
 */
let server: FreshServer;
let origin: string;
let cookie: string;

const NOTES = "core.note:read";

beforeAll(async () => {
  server = await bootFreshServer("oauth-tokens");
  origin = await issuerOrigin(server);
  cookie = await signIn(server, origin);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function refresh(app: App, refreshToken: string) {
  return token(
    server,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: app.clientId,
    },
    app,
  );
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

/** The grants `GET /auth/grants` lists, by client. */
async function grantedClients(): Promise<string[]> {
  const response = await fetch(`${server.apiUrl}/auth/grants`, {
    headers: { authorization: `Bearer ${server.workingKey}` },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { client_id: string }[] };
  return body.data.map((grant) => grant.client_id);
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

  it("is refused invalid_target when it names another server", async () => {
    const app = await registerApp(server, NOTES);
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
      resource: "https://elsewhere.example",
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("invalid_target");
    expect(refused.body.access_token).toBeUndefined();
  });
});

describe("revocation", () => {
  it("of an access token ends it at once", async () => {
    const app = await registerApp(server, NOTES);
    const issued = await connect(server, origin, cookie, app, NOTES);
    expect(await itemsStatus(server, issued.access_token!)).toBe(200);
    const revoked = await post("/auth/oauth2/revoke", {
      token: issued.access_token!,
      token_type_hint: "access_token",
      client_id: app.clientId,
    });
    expect(revoked.status).toBe(200);
    expect(await itemsStatus(server, issued.access_token!)).toBe(401);
    const again = await post("/auth/oauth2/revoke", {
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

    const revoked = await post("/auth/oauth2/revoke", {
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
    expect(asked?.pathname, String(asked)).toBe("/auth/authorize");
  });
});

describe("introspection", () => {
  it("answers a client its own live access token as active, with its scope, and a revoked one as inactive", async () => {
    const app = await registerApp(server, NOTES, {
      token_endpoint_auth_method: "client_secret_basic",
    });
    expect(app.clientSecret).toBeTruthy();
    const issued = await connect(server, origin, cookie, app, NOTES);
    const live = await post(
      "/auth/oauth2/introspect",
      { token: issued.access_token!, token_type_hint: "access_token" },
      basicAuthorization(app),
    );
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    expect(live.body?.active).toBe(true);
    expect(live.body?.client_id).toBe(app.clientId);
    expect(String(live.body?.scope).split(" ")).toContain(NOTES);

    const revoked = await post(
      "/auth/oauth2/revoke",
      { token: issued.access_token!, token_type_hint: "access_token" },
      basicAuthorization(app),
    );
    expect(revoked.status).toBe(200);
    const dead = await post(
      "/auth/oauth2/introspect",
      { token: issued.access_token!, token_type_hint: "access_token" },
      basicAuthorization(app),
    );
    expect(dead.status).toBe(200);
    expect(dead.body).toEqual({ active: false });
  });

  it("refuses a client that sends no secret 401 invalid_client", async () => {
    const app = await registerApp(server, NOTES);
    const issued = await connect(server, origin, cookie, app, NOTES);
    const refused = await post("/auth/oauth2/introspect", {
      token: issued.access_token!,
      client_id: app.clientId,
    });
    expect(refused.status).toBe(401);
    expect(refused.body?.error).toBe("invalid_client");
    expect(refused.body?.active).toBeUndefined();
  });
});

describe("userinfo", () => {
  async function userinfo(accessToken?: string) {
    const response = await fetch(`${server.apiUrl}/auth/oauth2/userinfo`, {
      headers:
        accessToken === undefined
          ? {}
          : { authorization: `Bearer ${accessToken}` },
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  }

  it("answers the person's subject, and the email only to a token holding email", async () => {
    const app = await registerApp(server, `${NOTES} openid email`);
    const withEmail = await connect(
      server,
      origin,
      cookie,
      app,
      `${NOTES} openid email`,
    );
    const read = await userinfo(withEmail.access_token);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.sub).toBeTruthy();
    expect(read.body.email).toBe("owner@example.test");

    const bare = await registerApp(server, `${NOTES} openid`);
    const without = await connect(
      server,
      origin,
      cookie,
      bare,
      `${NOTES} openid`,
    );
    const narrow = await userinfo(without.access_token);
    expect(narrow.status).toBe(200);
    expect(narrow.body.sub).toBe(read.body.sub);
    expect(narrow.body.email).toBeUndefined();
  });

  it("refuses a token without openid 400 invalid_scope, and a request with no token 401", async () => {
    const app = await registerApp(server, NOTES);
    const issued = await connect(server, origin, cookie, app, NOTES);
    const refused = await userinfo(issued.access_token);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("invalid_scope");
    expect((await userinfo()).status).toBe(401);
  });
});
