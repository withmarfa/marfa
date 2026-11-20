import { request as httpRequest } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { controlRequest } from "../../utils/control-request.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { visibleText } from "../../utils/approval-form.js";
import { TEST_OWNER } from "../../utils/target.js";
import {
  authorize,
  authorizeQuery,
  decide,
  issuerOrigin,
  pkce,
  sentTo,
  signIn,
  token,
} from "../../utils/signed-in.js";

/**
 * A web page connects as an app does, and the owner's approval is what lets
 * its address call the instance from a browser. The address is the origin of
 * the redirect URI the page registered, never the `Origin` a browser reports.
 *
 * Approving needs the owner signed in, the restart needs a server of its own,
 * and the configured origin and the instance's addresses are settings, so this
 * file boots a server of its own. Every case approves pages
 * on origins no other case names, so the cases share it without reading each
 * other's grants.
 */
let server: FreshServer;
let issuer: string;
let cookie: string;

const CONFIGURED = "https://configured.web-page-origin.test";
const LOOPBACK = "http://localhost:5173";
const SCOPE = "core.note:read core.note:write";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** What an approval page says beside the addresses it names. */
const REACH_LINE = "from your browser";

/** An origin as the approval pages write it: without a secure scheme, which is understood. */
const shown = (origin: string): string => origin.replace(/^https:\/\//, "");

beforeAll(async () => {
  server = await bootFreshServer("web-page-origin", {
    MARFA_CORS_ORIGINS: `${CONFIGURED},${LOOPBACK}`,
  });
  issuer = await issuerOrigin(server);
  cookie = await signIn(server, issuer);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

interface Page {
  clientId: string;
  redirectUri: string;
}

/** Registers a web page the way any program can: no credential and no
 *  `application_type`, which registers a web client. */
async function registerPage(
  redirectUris: string[],
  extra: Record<string, unknown> = {},
): Promise<Page> {
  const response = await fetch(`${server.apiUrl}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Web Page Fixture",
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
      ...extra,
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const body = (await response.json()) as { client_id: string };
  return { clientId: body.client_id, redirectUri: redirectUris[0]! };
}

/** The consent screen the owner reads for `page`, as its address. */
async function consentFor(page: Page, scope = SCOPE): Promise<URL> {
  const proof = pkce();
  const consent = await sentTo(
    server,
    await authorize(
      server,
      authorizeQuery(page.clientId, scope, proof, {
        redirect_uri: page.redirectUri,
      }),
      cookie,
    ),
  );
  expect(consent?.pathname).toBe("/auth/consent");
  return consent!;
}

/**
 * The owner approves `page` on the consent screen, leaving `ticked` ticked.
 * Answers the code the decision sends to the redirect URI and its verifier.
 */
async function approvedCode(
  page: Page,
  ticked: readonly string[] = SCOPE.split(" "),
): Promise<{ code: string; verifier: string }> {
  const proof = pkce();
  const consent = await sentTo(
    server,
    await authorize(
      server,
      authorizeQuery(page.clientId, SCOPE, proof, {
        redirect_uri: page.redirectUri,
        prompt: "consent",
      }),
      cookie,
    ),
  );
  expect(consent?.pathname).toBe("/auth/consent");
  const landed = await decide(server, issuer, cookie, consent!, true, ticked);
  const code = landed?.searchParams.get("code");
  expect(code, `no code on ${String(landed)}`).toBeTruthy();
  return { code: code!, verifier: proof.verifier };
}

/**
 * The owner approves `page` and the page exchanges its code. Answers the
 * access token and the scope the token answer names.
 */
async function approve(
  page: Page,
  ticked: readonly string[] = SCOPE.split(" "),
): Promise<{ access: string; scope: string }> {
  const { code, verifier } = await approvedCode(page, ticked);
  const answer = await token(server, {
    grant_type: "authorization_code",
    code,
    redirect_uri: page.redirectUri,
    code_verifier: verifier,
    client_id: page.clientId,
  });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return { access: answer.body.access_token!, scope: answer.body.scope ?? "" };
}

interface Grant {
  id: string;
  client_id: string;
  client_name: string | null;
  origins: string[];
}

async function grantOf(page: Page): Promise<Grant | undefined> {
  const listed = await fetch(`${server.apiUrl}/grants`, {
    headers: { authorization: `Bearer ${server.managementKey}` },
  });
  expect(listed.status).toBe(200);
  const { data } = (await listed.json()) as { data: Grant[] };
  return data.find((grant) => grant.client_id === page.clientId);
}

/** Disconnects `page` as the owner's settings page does. */
async function disconnect(page: Page): Promise<void> {
  const grant = await grantOf(page);
  expect(grant, "the page is not listed").toBeDefined();
  const revoked = await fetch(`${server.apiUrl}/grants/${grant!.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${server.managementKey}` },
  });
  expect(revoked.status).toBe(200);
}

/** A browser's preflight for a read from `origin` carrying a bearer. */
async function preflight(origin: string): Promise<Response> {
  const response = await fetch(`${server.apiUrl}/items`, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    },
  });
  await response.body?.cancel();
  return response;
}

/** The read itself, from `origin`, under `credential`. */
async function read(origin: string, credential: string): Promise<Response> {
  const response = await fetch(`${server.apiUrl}/items?limit=1`, {
    headers: { origin, authorization: `Bearer ${credential}` },
  });
  await response.body?.cancel();
  return response;
}

/** Asserts a browser on `origin` may make the read under `credential`. */
async function expectAllowed(origin: string, credential: string) {
  const asked = await preflight(origin);
  expect(asked.status, `preflight from ${origin}`).toBe(204);
  expect(asked.headers.get("access-control-allow-origin")).toBe(origin);
  const answered = await read(origin, credential);
  expect(answered.status, `read from ${origin}`).toBe(200);
  expect(answered.headers.get("access-control-allow-origin")).toBe(origin);
}

/** Asserts a browser on `origin` is told nothing it may read. */
async function expectRefused(origin: string, credential: string) {
  const asked = await preflight(origin);
  expect(
    asked.headers.get("access-control-allow-origin"),
    `preflight from ${origin}`,
  ).toBeNull();
  const answered = await read(origin, credential);
  expect(
    answered.headers.get("access-control-allow-origin"),
    `read from ${origin}`,
  ).toBeNull();
}

describe("a web page's address", () => {
  it("allows a page's origin once the owner approves it, on a preflight and on a request", async () => {
    const origin = "https://approved.web-page-origin.test";
    const page = await registerPage([`${origin}/callback`]);
    await expectRefused(origin, server.workingKey);
    const { access } = await approve(page);
    await expectAllowed(origin, access);
  });

  it("lets the page exchange its code at the token endpoint from its own origin, with no credentials allowed", async () => {
    const origin = "https://exchange.web-page-origin.test";
    const page = await registerPage([`${origin}/callback`]);
    const { code, verifier } = await approvedCode(page);
    const asked = await fetch(`${server.apiUrl}/oauth/token`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    await asked.body?.cancel();
    expect(asked.status).toBe(204);
    expect(asked.headers.get("access-control-allow-origin")).toBe(origin);
    expect(asked.headers.get("access-control-allow-credentials")).toBeNull();
    const exchanged = await fetch(`${server.apiUrl}/oauth/token`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: page.redirectUri,
        code_verifier: verifier,
        client_id: page.clientId,
      }),
    });
    expect(exchanged.status).toBe(200);
    expect(exchanged.headers.get("access-control-allow-origin")).toBe(origin);
    expect(
      exchanged.headers.get("access-control-allow-credentials"),
    ).toBeNull();
    const { access_token: access } = (await exchanged.json()) as {
      access_token: string;
    };
    await expectAllowed(origin, access);
  });

  it("allows each origin of a page registered on two, once the owner approves it", async () => {
    const first = "https://first-of-two.web-page-origin.test";
    const second = "https://second-of-two.web-page-origin.test";
    const page = await registerPage([
      `${first}/callback`,
      `${second}/callback`,
    ]);
    await expectRefused(first, server.workingKey);
    await expectRefused(second, server.workingKey);
    const { access } = await approve(page);
    await expectAllowed(first, access);
    await expectAllowed(second, access);
    expect((await grantOf(page))?.origins).toEqual([first, second]);
  });

  it("refuses a page's origin before approval, after a denial, and for another origin", async () => {
    const origin = "https://denied.web-page-origin.test";
    const page = await registerPage([`${origin}/callback`]);
    await expectRefused(origin, server.workingKey);

    const consent = await consentFor(page);
    const landed = await decide(server, issuer, cookie, consent, false, []);
    expect(landed?.searchParams.get("error")).toBe("access_denied");
    await expectRefused(origin, server.workingKey);
    expect(await grantOf(page)).toBeUndefined();

    // The witness: another page approved beside it is allowed, and an
    // address nobody approved stays refused while it is.
    const other = "https://beside-denied.web-page-origin.test";
    const { access } = await approve(await registerPage([`${other}/cb`]));
    await expectAllowed(other, access);
    await expectRefused("https://unapproved.web-page-origin.test", access);
    await expectRefused(origin, access);
  });

  it("keeps allowing the page on a reload, which a standing consent answers with a code", async () => {
    const origin = "https://reloaded.web-page-origin.test";
    const page = await registerPage([`${origin}/callback`]);
    const first = await approve(page);
    await expectAllowed(origin, first.access);

    // A reloaded page asks again without showing anything, and the standing
    // consent answers it at once.
    const proof = pkce();
    const landed = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(page.clientId, SCOPE, proof, {
          redirect_uri: page.redirectUri,
          prompt: "none",
        }),
        cookie,
      ),
    );
    const code = landed?.searchParams.get("code");
    expect(code, `no code on ${String(landed)}`).toBeTruthy();
    const again = await token(server, {
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: page.redirectUri,
      code_verifier: proof.verifier,
      client_id: page.clientId,
    });
    expect(again.status).toBe(200);
    await expectAllowed(origin, again.body.access_token!);
    await expectAllowed(origin, first.access);
  });

  it("keeps allowing the page across a restart", async () => {
    const origin = "https://restarted.web-page-origin.test";
    const { access } = await approve(
      await registerPage([`${origin}/callback`]),
    );
    await expectAllowed(origin, access);
    await server.restart();
    issuer = await issuerOrigin(server);
    await expectAllowed(origin, access);
    await expectRefused("https://unapproved.web-page-origin.test", access);
  });

  it("keeps an origin two pages share until the last of them is disconnected", async () => {
    const origin = "https://shared.web-page-origin.test";
    const first = await registerPage([`${origin}/first/callback`]);
    const second = await registerPage([`${origin}/second/callback`]);
    const { access } = await approve(first);
    await approve(second);
    await expectAllowed(origin, access);

    await disconnect(first);
    await expectAllowed(origin, server.workingKey);

    await disconnect(second);
    await expectRefused(origin, server.workingKey);
  });

  it("answers the request that disconnects a page's last grant with its origin allowed, and the next request without", async () => {
    const origin = "https://disconnecting.web-page-origin.test";
    const page = await registerPage([`${origin}/callback`]);
    const { access } = await approve(page);
    // The witness: the origin is allowed until the delete.
    await expectAllowed(origin, access);
    const grant = await grantOf(page);
    expect(grant, "the page is not listed").toBeDefined();
    const revoked = await fetch(`${server.apiUrl}/grants/${grant!.id}`, {
      method: "DELETE",
      headers: { origin, authorization: `Bearer ${server.managementKey}` },
    });
    await revoked.body?.cancel();
    expect(revoked.status).toBe(200);
    expect(revoked.headers.get("access-control-allow-origin")).toBe(origin);
    expect(await grantOf(page)).toBeUndefined();
    await expectRefused(origin, server.workingKey);
  });

  it("keeps an origin approved twice until its one grant is disconnected", async () => {
    const origin = "https://twice.web-page-origin.test";
    const page = await registerPage([`${origin}/callback`]);
    await approve(page);
    const { access } = await approve(page);
    await expectAllowed(origin, access);

    await disconnect(page);
    await expectRefused(origin, server.workingKey);
    expect(await grantOf(page)).toBeUndefined();
  });

  it("reads the origin as scheme, host and port, whatever path, port or trailing slash the redirect URI carries", async () => {
    const pathed = await registerPage([
      "https://Pathed.Web-Page-Origin.test:443/app/callback/?from=page",
    ]);
    const ported = await registerPage([
      "https://ported.web-page-origin.test:8443/callback/",
    ]);
    const { access } = await approve(pathed);
    await approve(ported);
    await expectAllowed("https://pathed.web-page-origin.test", access);
    await expectAllowed("https://ported.web-page-origin.test:8443", access);
    // The same host on its default port is another origin.
    await expectRefused("https://ported.web-page-origin.test", access);
    expect((await grantOf(pathed))?.origins).toEqual([
      "https://pathed.web-page-origin.test",
    ]);
  });

  it("allows no origin for a native app's redirect URI", async () => {
    const origin = "https://native.web-page-origin.test";
    const app = await registerPage([`${origin}/callback`], {
      application_type: "native",
    });
    const { access } = await approve(app);
    await expectRefused(origin, access);
    expect((await grantOf(app))?.origins).toEqual([]);
    // The witness: the same redirect URI registered by a web page is allowed.
    const page = await registerPage([`${origin}/callback`]);
    await approve(page);
    await expectAllowed(origin, access);
  });

  it("issues a narrowed page only what the person chose, though its origin is allowed", async () => {
    const origin = "https://narrowed.web-page-origin.test";
    const { access, scope } = await approve(
      await registerPage([`${origin}/callback`]),
      ["core.note:read"],
    );
    expect(scope.split(" ")).not.toContain("core.note:write");
    await expectAllowed(origin, access);
    const write = await fetch(`${server.apiUrl}/items`, {
      method: "POST",
      headers: {
        origin,
        authorization: `Bearer ${access}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "core.note",
        properties: { title: "narrowed" },
      }),
    });
    expect(write.status).toBe(403);
    expect(write.headers.get("access-control-allow-origin")).toBe(origin);
  });

  it("allows a configured origin, and refuses an unapproved one beside it", async () => {
    await expectAllowed(CONFIGURED, server.workingKey);
    await expectRefused(
      "https://beside-configured.web-page-origin.test",
      server.workingKey,
    );
  });

  it("refuses a loopback origin that nothing names, and allows one cors_origins names", async () => {
    // The witness: the loopback origin the setting names is allowed.
    await expectAllowed(LOOPBACK, server.workingKey);
    for (const origin of [
      "http://localhost:5174",
      "http://127.0.0.1:5173",
      "http://[::1]:5173",
      "http://localhost",
    ]) {
      await expectRefused(origin, server.workingKey);
    }
  });

  it("takes an origin off the next request once cors_origins stops naming it", async () => {
    const removable = "https://removable.web-page-origin.test";
    const name = (origins: string[]) =>
      controlRequest(server.controlSocket, "/config", {
        method: "PATCH",
        body: { cors_origins: origins },
      });
    expect((await name([CONFIGURED, LOOPBACK, removable])).status).toBe(200);
    await expectAllowed(removable, server.workingKey);
    expect((await name([CONFIGURED, LOOPBACK])).status).toBe(200);
    await expectRefused(removable, server.workingKey);
    await expectAllowed(CONFIGURED, server.workingKey);
  });

  it("judges an origin only as a browser writes it, and no origin where a request names two", async () => {
    // The witness: the origin as a browser writes it is allowed.
    await expectAllowed(CONFIGURED, server.workingKey);
    for (const written of [
      "HTTPS://configured.web-page-origin.test",
      "https://Configured.Web-Page-Origin.test",
      "https://configured.web-page-origin.test:443",
      "https://configured.web-page-origin.test/",
      "https://configured.web-page-origin.test/path",
      "null",
    ]) {
      await expectRefused(written, server.workingKey);
    }
    const url = new URL(`${server.apiUrl}/items?limit=1`);
    const twice = (second: string) =>
      new Promise<string | undefined>((resolve, reject) => {
        const asked = httpRequest(
          {
            host: url.hostname,
            port: url.port,
            path: `${url.pathname}${url.search}`,
            headers: [
              "Origin",
              CONFIGURED,
              "Origin",
              second,
              "Authorization",
              `Bearer ${server.workingKey}`,
            ],
          },
          (answer) => {
            answer.resume();
            answer.on("end", () =>
              resolve(answer.headers["access-control-allow-origin"]),
            );
          },
        );
        asked.on("error", reject);
        asked.end();
      });
    expect(await twice(CONFIGURED)).toBeUndefined();
    expect(await twice(LOOPBACK)).toBeUndefined();
  });

  it("answers a preflight for a method an operation at its path takes, naming the methods and headers", async () => {
    const asked = (path: string, method: string, headers: string) =>
      fetch(`${server.apiUrl}${path}`, {
        method: "OPTIONS",
        headers: {
          origin: CONFIGURED,
          "access-control-request-method": method,
          "access-control-request-headers": headers,
        },
      });
    const items = await asked("/items", "POST", "authorization, content-type");
    expect(items.status).toBe(204);
    expect(items.headers.get("access-control-allow-origin")).toBe(CONFIGURED);
    expect(items.headers.get("access-control-allow-methods")).toBe(
      "GET, HEAD, POST",
    );
    expect(items.headers.get("access-control-allow-headers")).toBe(
      "authorization, content-type",
    );
    const one = await asked("/items/abc", "PATCH", "authorization");
    expect(one.status).toBe(204);
    expect(one.headers.get("access-control-allow-methods")).toBe(
      "DELETE, GET, HEAD, PATCH",
    );
  });

  it("refuses a preflight for a method no operation at its path takes, for a path none serves, and for a header that is no name", async () => {
    const asked = (path: string, method: string, headers = "authorization") =>
      fetch(`${server.apiUrl}${path}`, {
        method: "OPTIONS",
        headers: {
          origin: CONFIGURED,
          "access-control-request-method": method,
          "access-control-request-headers": headers,
        },
      });
    // The witness: the same origin is answered for a method the path takes.
    expect((await asked("/health", "GET")).status).toBe(204);
    for (const [path, method, headers] of [
      ["/health", "DELETE", "authorization"],
      ["/items", "PUT", "authorization"],
      ["/items", "TRACE", "authorization"],
      ["/no-such-door", "GET", "authorization"],
      ["/items", "POST", "authorization,,content-type"],
      ["/items", "POST", "bad header"],
    ] as const) {
      const refused = await asked(path, method, headers);
      const label = `${method} ${path} ${headers}`;
      expect(refused.status, label).toBe(404);
      expect(
        ((await refused.json()) as { error: { code: string } }).error.code,
        label,
      ).toBe("not_found");
      expect(
        refused.headers.get("access-control-allow-origin"),
        label,
      ).toBeNull();
    }
  });

  it("names Origin in Vary on every answer, and a preflight's request headers in Vary on its answer", async () => {
    const varies = (response: Response) =>
      (response.headers.get("vary") ?? "")
        .toLowerCase()
        .split(",")
        .map((name) => name.trim());
    const authorization = { authorization: `Bearer ${server.workingKey}` };
    for (const headers of [
      authorization,
      { ...authorization, origin: CONFIGURED },
      { ...authorization, origin: "https://nobody.web-page-origin.test" },
    ]) {
      const read = await fetch(`${server.apiUrl}/items?limit=1`, { headers });
      await read.body?.cancel();
      expect(varies(read), JSON.stringify(headers)).toContain("origin");
    }
    const missing = await fetch(`${server.apiUrl}/no-such-door`, {
      headers: { origin: CONFIGURED },
    });
    await missing.body?.cancel();
    expect(varies(missing)).toContain("origin");

    const preflight = await fetch(`${server.apiUrl}/items`, {
      method: "OPTIONS",
      headers: {
        origin: CONFIGURED,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization",
      },
    });
    expect(preflight.status).toBe(204);
    expect(varies(preflight)).toEqual(
      expect.arrayContaining([
        "origin",
        "access-control-request-method",
        "access-control-request-headers",
      ]),
    );
  });

  it("answers no cross-origin header to a request that names no origin", async () => {
    const authorization = { authorization: `Bearer ${server.workingKey}` };
    const crossOrigin = (response: Response) =>
      [...response.headers.keys()].filter((name) =>
        name.startsWith("access-control-"),
      );
    for (const path of [
      "/health",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/items?limit=1",
    ]) {
      const bare = await fetch(`${server.apiUrl}${path}`, {
        headers: authorization,
      });
      await bare.body?.cancel();
      expect(crossOrigin(bare), path).toEqual([]);
      // The witness: the same request from a page is answered in cross-origin headers.
      const asked = await fetch(`${server.apiUrl}${path}`, {
        headers: { ...authorization, origin: CONFIGURED },
      });
      await asked.body?.cancel();
      expect(crossOrigin(asked), path).toContain("access-control-allow-origin");
    }
    // A preflight that names no origin is no browser's preflight, whether the
    // path takes the method or answers every origin's.
    for (const path of ["/items", "/oauth/register"]) {
      const preflightFrom = (headers: Record<string, string>) =>
        fetch(`${server.apiUrl}${path}`, {
          method: "OPTIONS",
          headers: {
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type",
            ...headers,
          },
        });
      const bare = await preflightFrom({});
      await bare.body?.cancel();
      expect(crossOrigin(bare), `OPTIONS ${path}`).toEqual([]);
      // The witness: the same preflight from an origin is answered in cross-origin headers.
      const asked = await preflightFrom({ origin: CONFIGURED });
      await asked.body?.cancel();
      expect(asked.status, `OPTIONS ${path}`).toBe(204);
      expect(crossOrigin(asked), `OPTIONS ${path}`).toContain(
        "access-control-allow-origin",
      );
    }
  });
});

describe("an approved page's address and the sign-in surface", () => {
  it("trusts only the sign-in address on the browser forms and at sign-in, refusing a configured origin, another address and an approved page", async () => {
    const page = "https://forms.web-page-origin.test";
    await approve(await registerPage([`${page}/callback`]));
    await expectAllowed(page, server.workingKey);
    const elsewhere = "https://elsewhere.web-page-origin.test";
    const addressed = await controlRequest(server.controlSocket, "/config", {
      method: "PATCH",
      body: { addresses: [issuer, elsewhere] },
    });
    expect(addressed.status, JSON.stringify(addressed.body)).toBe(200);

    const signInForm = (from: string) =>
      fetch(`${server.apiUrl}/auth/sign-in`, {
        method: "POST",
        redirect: "manual",
        headers: {
          origin: from,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          username: "",
          password: "",
          return_to: "/",
        }),
      });
    const passwordSignIn = (from: string) =>
      fetch(`${server.apiUrl}/auth/sign-in`, {
        method: "POST",
        headers: { origin: from, "content-type": "application/json" },
        body: JSON.stringify(TEST_OWNER),
      });
    const ownerForm = (path: string, from: string) =>
      fetch(`${server.apiUrl}${path}`, {
        method: "POST",
        redirect: "manual",
        headers: {
          origin: from,
          cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ user_code: "ABCD2345" }),
      });
    const passkeyOptions = (from: string) =>
      fetch(`${server.apiUrl}/auth/passkeys/sign-in/options`, {
        method: "POST",
        headers: { origin: from },
      });

    for (const from of [CONFIGURED, elsewhere, page]) {
      const refused = [
        await signInForm(from),
        await passwordSignIn(from),
        await ownerForm("/auth/consent", from),
        await ownerForm("/auth/device", from),
        await ownerForm("/auth/device/consent", from),
        await passkeyOptions(from),
      ];
      for (const answer of refused) {
        expect(answer.status, `${answer.url} from ${from}`).toBe(403);
        expect(
          ((await answer.json()) as { error: { code: string } }).error.code,
        ).toBe("forbidden");
        expect(answer.headers.get("set-cookie")).toBeNull();
      }
    }

    // The witness: the same posts from the sign-in address are answered.
    const answeredForm = await signInForm(issuer);
    expect(answeredForm.status).toBe(302);
    expect(answeredForm.headers.get("location")).toContain(
      "error=missing_field",
    );
    const accepted = await passwordSignIn(issuer);
    await accepted.body?.cancel();
    expect(accepted.status).toBe(200);
    const device = await ownerForm("/auth/device", issuer);
    await device.body?.cancel();
    expect(device.status).not.toBe(403);
    const options = await passkeyOptions(issuer);
    await options.body?.cancel();
    expect(options.status).toBe(200);

    const reset = await controlRequest(server.controlSocket, "/config", {
      method: "PATCH",
      body: { addresses: null },
    });
    expect(reset.status).toBe(200);
  });
});

describe("where the owner reads a page's address", () => {
  it("names the page's origin on the consent screen and in the grants listing", async () => {
    const origin = "https://named.web-page-origin.test";
    const page = await registerPage([`${origin}/callback`]);
    const screen = await fetch(await consentFor(page), {
      headers: { cookie },
    });
    expect(screen.status).toBe(200);
    const text = visibleText(await screen.text());
    expect(text).toContain(shown(origin));
    expect(text).toContain(REACH_LINE);
    // A native app's screen names no address.
    const app = await registerPage(
      ["https://named-native.web-page-origin.test/cb"],
      { application_type: "native" },
    );
    const nativeScreen = await fetch(await consentFor(app), {
      headers: { cookie },
    });
    expect(nativeScreen.status).toBe(200);
    expect(visibleText(await nativeScreen.text())).not.toContain(REACH_LINE);

    await approve(page);
    const grant = await grantOf(page);
    expect(grant?.origins).toEqual([origin]);
    expect(grant?.client_name).toBe("Web Page Fixture");
  });

  it("names both origins of a page registered on two, on the consent screen and the device approval page", async () => {
    const first = "https://named-first.web-page-origin.test";
    const second = "https://named-second.web-page-origin.test";
    const page = await registerPage(
      [`${first}/callback`, `${second}/callback`],
      {
        grant_types: ["authorization_code", DEVICE_GRANT],
      },
    );
    const consent = await fetch(await consentFor(page), {
      headers: { cookie },
    });
    expect(consent.status).toBe(200);
    const consentText = visibleText(await consent.text());
    expect(consentText).toContain(shown(first));
    expect(consentText).toContain(shown(second));

    const code = await fetch(`${server.apiUrl}/oauth/device-authorization`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: page.clientId,
        scope: "core.note:read",
      }),
    });
    expect(code.status).toBe(200);
    const { user_code: userCode } = (await code.json()) as {
      user_code: string;
    };
    const device = await fetch(
      `${server.apiUrl}/auth/device/consent?user_code=${encodeURIComponent(userCode)}`,
      { headers: { cookie } },
    );
    expect(device.status).toBe(200);
    const deviceText = visibleText(await device.text());
    expect(deviceText).toContain(shown(first));
    expect(deviceText).toContain(shown(second));
  });

  it("names the page's origin on the device approval page, and allows it once approved there", async () => {
    const origin = "https://device.web-page-origin.test";
    const registered = await fetch(`${server.apiUrl}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Web Page Device Fixture",
        redirect_uris: [`${origin}/callback`],
        grant_types: [DEVICE_GRANT],
        response_types: [],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registered.status).toBe(201);
    const { client_id: clientId } = (await registered.json()) as {
      client_id: string;
    };
    const code = await fetch(`${server.apiUrl}/oauth/device-authorization`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        scope: "core.note:read",
      }),
    });
    expect(code.status).toBe(200);
    const { user_code: userCode } = (await code.json()) as {
      user_code: string;
    };
    const screen = await fetch(
      `${server.apiUrl}/auth/device/consent?user_code=${encodeURIComponent(userCode)}`,
      { headers: { cookie } },
    );
    expect(screen.status).toBe(200);
    const text = visibleText(await screen.text());
    expect(text).toContain(shown(origin));
    expect(text).toContain(REACH_LINE);
    await expectRefused(origin, server.workingKey);

    const approved = await fetch(`${server.apiUrl}/auth/device/consent`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: issuer,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        user_code: userCode,
        decision: "approve",
        scopes: "core.note:read",
      }),
    });
    expect(approved.status).toBe(200);
    await expectAllowed(origin, server.workingKey);
  });
});
