import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  DAY_MS,
  MINUTE_MS,
  QUIET_SCHEDULE,
  quiet,
  runJob,
} from "../../utils/moved-clock.js";
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
  // The clean-up job runs when the test asks: moving the clock makes it due,
  // and the scheduler would then run it first.
  server = await bootFreshServer("web-page-register", QUIET_SCHEDULE);
  await quiet(server, ["dcr-client-cleanup"]);
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
    // What earlier cases registered and nobody approved is idle by now, and the
    // sweep below is to remove the one registration this case leaves idle.
    await server.advanceClock(2 * DAY_MS);
    expect((await runJob(server, "dcr-client-cleanup")).outcome).toBe("ok");
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

    // Past the retention, a day.
    await server.advanceClock(2 * DAY_MS);
    // The owner opens the approval for one of them after it aged.
    const consent = await authorizeLandsAt(offeredId, offered);
    expect(consent?.pathname).toBe("/auth/authorize");
    const screen = await fetch(consent!, { headers: { cookie } });
    await screen.body?.cancel();
    expect(screen.status).toBe(200);

    expect(await runJob(server, "dcr-client-cleanup")).toMatchObject({
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

  it("keeps a registration the device approval page offered after it aged", async () => {
    const registered = await fetch(`${server.apiUrl}/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Aged Device App",
        application_type: "native",
        grant_types: ["urn:ietf:params:oauth:grant-type:device_code"],
        response_types: [],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registered.status).toBe(201);
    const { client_id: clientId } = (await registered.json()) as {
      client_id: string;
    };
    // The code lives ten minutes and the retention is a day, so the code is
    // asked for just short of the day, and the day passes while it stands.
    await server.advanceClock(DAY_MS - 5 * MINUTE_MS);
    const code = await fetch(`${server.apiUrl}/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, scope: SCOPE }),
    });
    expect(code.status).toBe(200);
    const { user_code: userCode } = (await code.json()) as {
      user_code: string;
    };
    await server.advanceClock(6 * MINUTE_MS);
    const page = `${server.apiUrl}/auth/device/consent?user_code=${encodeURIComponent(userCode)}`;
    const offered = await fetch(page, { headers: { cookie } });
    await offered.body?.cancel();
    expect(offered.status).toBe(200);

    expect((await runJob(server, "dcr-client-cleanup")).outcome).toBe("ok");
    const again = await fetch(page, { headers: { cookie } });
    await again.body?.cancel();
    expect(again.status).toBe(200);
  });
});

describe("the size of a registration", () => {
  const body = (redirects: number, padding = 0) =>
    JSON.stringify({
      client_name: "Sized Page",
      redirect_uris: Array.from(
        { length: redirects },
        (_, i) => `https://sized.web-page-register.test/callback/${String(i)}`,
      ),
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      software_version: "x".repeat(padding),
    });
  const register = (text: string) =>
    fetch(`${server.apiUrl}/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text,
    });

  it("refuses a registration over 32768 bytes, and takes one just under it", async () => {
    const under = body(1, 32_000);
    expect(Buffer.byteLength(under)).toBeLessThanOrEqual(32_768);
    const taken = await register(under);
    await taken.body?.cancel();
    expect(taken.status).toBe(201);
    const over = body(1, 33_000);
    expect(Buffer.byteLength(over)).toBeGreaterThan(32_768);
    const refused = await register(over);
    expect(refused.status).toBe(413);
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
    ).toBe("request_too_large");
  });

  it("refuses a registration naming more than 10 redirect URIs, and takes one naming 10", async () => {
    const taken = await register(body(10));
    expect(taken.status).toBe(201);
    expect(
      ((await taken.json()) as { redirect_uris: string[] }).redirect_uris,
    ).toHaveLength(10);
    const refused = await register(body(11));
    expect(refused.status).toBe(400);
    const answer = (await refused.json()) as {
      error: string;
      error_description: string;
    };
    expect(answer.error).toBe("invalid_redirect_uri");
    expect(answer.error_description).toContain("10");
  });
});
