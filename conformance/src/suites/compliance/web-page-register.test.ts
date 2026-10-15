import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import {
  authorize,
  authorizeQuery,
  decide,
  issuerOrigin,
  pkce,
  sentTo,
  signIn,
} from "../../utils/signed-in.js";

/**
 * A web page with no setup at all: it finds the endpoints and registers
 * itself from the browser, on an origin the instance has never seen, before
 * the owner approves it. And the registrations nobody approves, which any
 * page can now leave behind, are removed.
 *
 * Approving needs the owner signed in, and the reaper's case reads the
 * instance's whole set of registrations, so this file boots a server of its
 * own.
 */
let server: FreshServer;
let issuer: string;
let cookie: string;

const SCOPE = "core.note:read";
const DISCOVERY = [
  "/.well-known/oauth-authorization-server/auth",
  "/.well-known/openid-configuration/auth",
  "/auth/.well-known/oauth-authorization-server",
  "/auth/.well-known/openid-configuration",
  "/.well-known/oauth-protected-resource",
];

beforeAll(async () => {
  server = await bootFreshServer("web-page-register");
  issuer = await issuerOrigin(server);
  cookie = await signIn(server, issuer);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

/** Registers a web page from `origin`, as its own script would. */
async function registerFrom(
  origin: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${server.apiUrl}/auth/oauth2/register`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify({
      client_name: "Unregistered Page",
      redirect_uris: [`${origin}/callback`],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    }),
  });
}

async function registeredClient(origin: string): Promise<string> {
  const response = await registerFrom(origin);
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

/** Where the owner's browser is sent when `clientId` asks for approval. */
async function authorizeLandsAt(
  clientId: string,
  origin: string,
): Promise<URL | undefined> {
  return sentTo(
    server,
    await authorize(
      server,
      authorizeQuery(clientId, SCOPE, pkce(), {
        redirect_uri: `${origin}/callback`,
        prompt: "consent",
      }),
      cookie,
    ),
  );
}

/** The owner approves `clientId`; answers the code and its verifier. */
async function approve(
  clientId: string,
  origin: string,
): Promise<{ code: string; verifier: string }> {
  const proof = pkce();
  const consent = await sentTo(
    server,
    await authorize(
      server,
      authorizeQuery(clientId, SCOPE, proof, {
        redirect_uri: `${origin}/callback`,
        prompt: "consent",
      }),
      cookie,
    ),
  );
  expect(consent?.pathname).toBe("/auth/authorize");
  const landed = await decide(server, issuer, cookie, consent!, true, [SCOPE]);
  const code = landed?.searchParams.get("code");
  expect(code, `no code on ${String(landed)}`).toBeTruthy();
  return { code: code!, verifier: proof.verifier };
}

describe("a page that has never been registered", () => {
  it("answers the discovery documents and registration to any origin, with every origin allowed and no credentials", async () => {
    const origin = "https://discovering.web-page-register.test";
    for (const path of DISCOVERY) {
      const read = await fetch(`${server.apiUrl}${path}`, {
        headers: { origin },
      });
      await read.body?.cancel();
      expect(read.status, path).toBe(200);
      expect(read.headers.get("access-control-allow-origin"), path).toBe("*");
      expect(
        read.headers.get("access-control-allow-credentials"),
        path,
      ).toBeNull();
    }
    const registered = await registerFrom(origin);
    expect(registered.status).toBe(201);
    expect(registered.headers.get("access-control-allow-origin")).toBe("*");
    expect(
      registered.headers.get("access-control-allow-credentials"),
    ).toBeNull();
  });

  it("allows a preflight for registration with POST and Content-Type, and nothing more", async () => {
    const origin = "https://preflighting.web-page-register.test";
    const preflight = (method: string) =>
      fetch(`${server.apiUrl}/auth/oauth2/register`, {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": method,
          "access-control-request-headers": "content-type",
        },
      });
    const asked = await preflight("POST");
    expect(asked.status).toBe(204);
    expect(asked.headers.get("access-control-allow-origin")).toBe("*");
    expect(asked.headers.get("access-control-allow-methods")).toBe("POST");
    expect(asked.headers.get("access-control-allow-headers")).toBe(
      "Content-Type",
    );
    expect(asked.headers.get("access-control-allow-credentials")).toBeNull();
    // Another method on the same address is not open to the page.
    const other = await preflight("DELETE");
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("still refuses that origin on a data operation and at the token endpoint before approval", async () => {
    const origin = "https://unapproved.web-page-register.test";
    expect((await registerFrom(origin)).status).toBe(201);
    for (const [path, method] of [
      ["/items", "GET"],
      ["/auth/oauth2/token", "POST"],
      ["/auth/grants", "GET"],
    ] as const) {
      const asked = await fetch(`${server.apiUrl}${path}`, {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": method,
          "access-control-request-headers": "authorization,content-type",
        },
      });
      expect(asked.headers.get("access-control-allow-origin"), path).toBeNull();
    }
    const read = await fetch(`${server.apiUrl}/items?limit=1`, {
      headers: { origin, authorization: `Bearer ${server.workingKey}` },
    });
    await read.body?.cancel();
    expect(read.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("registers a client sent with the owner's session cookie as it registers one sent without", async () => {
    const origin = "https://cookied.web-page-register.test";
    const without = await registerFrom(origin);
    const withCookie = await registerFrom(origin, { cookie });
    expect(without.status).toBe(201);
    expect(withCookie.status).toBe(201);
    const shape = (body: Record<string, unknown>) => {
      const { client_id: _id, client_id_issued_at: _at, ...rest } = body;
      return rest;
    };
    expect(shape((await withCookie.json()) as Record<string, unknown>)).toEqual(
      shape((await without.json()) as Record<string, unknown>),
    );
  });

  it("completes the flow from a page that was never registered: discover, register, approve, exchange and read", async () => {
    const origin = "https://fresh.web-page-register.test";
    const discovered = await fetch(
      `${server.apiUrl}/.well-known/oauth-authorization-server/auth`,
      { headers: { origin } },
    );
    expect(discovered.headers.get("access-control-allow-origin")).toBe("*");
    const endpoints = (await discovered.json()) as {
      registration_endpoint: string;
      token_endpoint: string;
    };
    const registered = await fetch(endpoints.registration_endpoint, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Fresh Page",
        redirect_uris: [`${origin}/callback`],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: SCOPE,
      }),
    });
    expect(registered.status).toBe(201);
    expect(registered.headers.get("access-control-allow-origin")).toBe("*");
    const { client_id: clientId } = (await registered.json()) as {
      client_id: string;
    };

    const { code, verifier } = await approve(clientId, origin);
    const exchanged = await fetch(endpoints.token_endpoint, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${origin}/callback`,
        code_verifier: verifier,
        client_id: clientId,
      }),
    });
    expect(exchanged.status).toBe(200);
    expect(exchanged.headers.get("access-control-allow-origin")).toBe(origin);
    const { access_token: access } = (await exchanged.json()) as {
      access_token: string;
    };
    const read = await fetch(`${server.apiUrl}/items?limit=1`, {
      headers: { origin, authorization: `Bearer ${access}` },
    });
    await read.body?.cancel();
    expect(read.status).toBe(200);
    expect(read.headers.get("access-control-allow-origin")).toBe(origin);
  });
});

describe("registrations nobody approves", () => {
  it("removes a registration nobody approved once it is idle past the retention, and keeps an approved, a revoked and an offered one", async () => {
    const idle = "https://idle.web-page-register.test";
    const approved = "https://approved.web-page-register.test";
    const revoked = "https://revoked.web-page-register.test";
    const offered = "https://offered.web-page-register.test";
    const idleId = await registeredClient(idle);
    const approvedId = await registeredClient(approved);
    const revokedId = await registeredClient(revoked);
    const offeredId = await registeredClient(offered);
    await approve(approvedId, approved);
    await approve(revokedId, revoked);
    const listed = (await (
      await fetch(`${server.apiUrl}/auth/grants`, {
        headers: { authorization: `Bearer ${server.managementKey}` },
      })
    ).json()) as { data: { id: string; client_id: string }[] };
    const grant = listed.data.find((g) => g.client_id === revokedId);
    expect(grant).toBeDefined();
    const ended = await fetch(`${server.apiUrl}/auth/grants/${grant!.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${server.managementKey}` },
    });
    expect(ended.status).toBe(204);

    // The retention is days, so the registrations' age is written rather
    // than waited for.
    const aged = withInstanceDatabase(server.sqlitePath, (db) => {
      const update = db.prepare(
        "UPDATE auth_oauth_client SET created_at = 0, updated_at = 0 WHERE client_id = ?",
      );
      return [idleId, approvedId, revokedId, offeredId].reduce(
        (total, id) => total + Number(update.run(id).changes),
        0,
      );
    });
    expect(aged).toBe(4);
    // The owner opens the approval for one of them after it aged.
    const consent = await authorizeLandsAt(offeredId, offered);
    expect(consent?.pathname).toBe("/auth/authorize");
    const screen = await fetch(consent!, { headers: { cookie } });
    await screen.body?.cancel();
    expect(screen.status).toBe(200);

    const swept = await fetch(
      `${server.apiUrl}/housekeeping/dcr-client-cleanup/run`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${server.managementKey}` },
      },
    );
    expect(swept.status).toBe(200);
    expect(await swept.json()).toMatchObject({
      outcome: "ok",
      result: { deleted: 1 },
    });

    const gone = await authorizeLandsAt(idleId, idle);
    expect(gone?.pathname).toBe("/auth/error");
    expect(gone?.searchParams.get("error")).toBe("invalid_client");
    for (const [id, origin] of [
      [approvedId, approved],
      [revokedId, revoked],
      [offeredId, offered],
    ] as const) {
      expect((await authorizeLandsAt(id, origin))?.pathname, origin).toBe(
        "/auth/authorize",
      );
    }
  });
});
