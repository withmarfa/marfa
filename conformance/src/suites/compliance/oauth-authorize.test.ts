import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
  decide,
  issuerOrigin,
  pkce,
  registerApp,
  sentTo,
  signIn,
  token,
} from "../../utils/signed-in.js";

/**
 * An app asking a person for access in a browser: the consent screen, the
 * person's decision, the code it sends back, and the requests a standing
 * consent answers without asking again. A person has to be signed in, and an
 * instance has one owner, so this file boots a server of its own.
 */
let server: FreshServer;
let origin: string;
let cookie: string;

const NOTES = "core.note:read";
const BOOKMARKS = "core.bookmark:read";

beforeAll(async () => {
  server = await bootFreshServer("oauth-authorize");
  origin = await issuerOrigin(server);
  cookie = await signIn(server, origin);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

/** Where an authorization request from the signed-in person lands. */
async function landing(
  query: URLSearchParams,
  as: string | null = cookie,
): Promise<URL | undefined> {
  return sentTo(server, await authorize(server, query, as ?? undefined));
}

/** The consent screen a request lands on, which a person can read. */
async function consentScreen(query: URLSearchParams): Promise<URL> {
  const consent = await landing(query);
  expect(consent?.pathname, `landed on ${String(consent)}`).toBe(
    "/auth/authorize",
  );
  return consent!;
}

describe("authorization with consent", () => {
  it("shows a signed-in person a consent screen offering each scope the request names", async () => {
    const app = await registerApp(server, `${NOTES} ${BOOKMARKS}`);
    const consent = await consentScreen(
      authorizeQuery(app.clientId, `${NOTES} ${BOOKMARKS}`, pkce()),
    );
    const page = await fetch(consent, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    const offered = [
      ...html.matchAll(/name="scopes"[^>]*value="([^"]+)"/g),
    ].map((m) => m[1]);
    expect(new Set(offered)).toEqual(new Set([NOTES, BOOKMARKS]));
  });

  it("sends the code for an accepted consent to the redirect URI with the request's state", async () => {
    const app = await registerApp(server, NOTES);
    const consent = await consentScreen(
      authorizeQuery(app.clientId, NOTES, pkce()),
    );
    const sent = await decide(server, origin, cookie, consent, true, [NOTES]);
    expect(sent?.href.startsWith(CALLBACK), String(sent)).toBe(true);
    expect(sent?.searchParams.get("code")).toBeTruthy();
    expect(sent?.searchParams.get("state")).toBe("signed-in-fixture");
  });

  it("sends a declined consent to the redirect URI as access_denied with the request's state", async () => {
    const app = await registerApp(server, NOTES);
    const consent = await consentScreen(
      authorizeQuery(app.clientId, NOTES, pkce()),
    );
    const sent = await decide(server, origin, cookie, consent, false, [NOTES]);
    expect(sent?.href.startsWith(CALLBACK), String(sent)).toBe(true);
    expect(sent?.searchParams.get("error")).toBe("access_denied");
    expect(sent?.searchParams.get("state")).toBe("signed-in-fixture");
    expect(sent?.searchParams.get("code")).toBeNull();
  });

  it("issues a token for only the scopes the person left ticked", async () => {
    const app = await registerApp(server, `${NOTES} ${BOOKMARKS}`);
    const proof = pkce();
    const consent = await consentScreen(
      authorizeQuery(app.clientId, `${NOTES} ${BOOKMARKS}`, proof),
    );
    const sent = await decide(server, origin, cookie, consent, true, [NOTES]);
    const exchanged = await token(server, {
      grant_type: "authorization_code",
      code: sent?.searchParams.get("code") ?? "",
      redirect_uri: CALLBACK,
      code_verifier: proof.verifier,
      client_id: app.clientId,
    });
    expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
    expect(exchanged.body.scope?.split(" ").sort()).toEqual([NOTES]);
  });

  it("answers a request a standing consent covers with a code and no consent screen", async () => {
    const app = await registerApp(server, `${NOTES} ${BOOKMARKS}`);
    // The witness: the first request has no consent to stand on.
    expect((await codeFor(server, origin, cookie, app, NOTES)).silent).toBe(
      false,
    );
    expect((await codeFor(server, origin, cookie, app, NOTES)).silent).toBe(
      true,
    );
  });

  it("asks again for a request reaching past the standing consent", async () => {
    const app = await registerApp(server, `${NOTES} ${BOOKMARKS}`);
    await codeFor(server, origin, cookie, app, NOTES);
    await consentScreen(
      authorizeQuery(app.clientId, `${NOTES} ${BOOKMARKS}`, pkce()),
    );
  });

  it("asks again under prompt=consent, whatever the standing consent covers", async () => {
    const app = await registerApp(server, NOTES);
    await codeFor(server, origin, cookie, app, NOTES);
    await consentScreen(
      authorizeQuery(app.clientId, NOTES, pkce(), { prompt: "consent" }),
    );
  });

  it("drops a requested scope the instance cannot grant, and authorizes the rest", async () => {
    const app = await registerApp(server, NOTES);
    const unknown = "user.nothing_registered_here:read";
    const proof = pkce();
    const consent = await consentScreen(
      authorizeQuery(app.clientId, `${NOTES} ${unknown}`, proof),
    );
    const page = await (await fetch(consent, { headers: { cookie } })).text();
    expect(page).not.toContain(unknown);
    const sent = await decide(server, origin, cookie, consent, true, [NOTES]);
    const exchanged = await token(server, {
      grant_type: "authorization_code",
      code: sent?.searchParams.get("code") ?? "",
      redirect_uri: CALLBACK,
      code_verifier: proof.verifier,
      client_id: app.clientId,
    });
    expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
    expect(exchanged.body.scope).toBe(NOTES);
  });

  it("sends a request in which no scope can be granted to the redirect URI as invalid_scope", async () => {
    const app = await registerApp(server, NOTES);
    const sent = await landing(
      authorizeQuery(app.clientId, "user.nothing_registered_here:read", pkce()),
    );
    expect(sent?.href.startsWith(CALLBACK), String(sent)).toBe(true);
    expect(sent?.searchParams.get("error")).toBe("invalid_scope");
  });
});

describe("prompt=none", () => {
  it("sends a request from nobody signed in to the redirect URI as login_required", async () => {
    const app = await registerApp(server, NOTES);
    const sent = await landing(
      authorizeQuery(app.clientId, NOTES, pkce(), { prompt: "none" }),
      null,
    );
    expect(sent?.href.startsWith(CALLBACK), String(sent)).toBe(true);
    expect(sent?.searchParams.get("error")).toBe("login_required");
    expect(sent?.searchParams.get("state")).toBe("signed-in-fixture");
  });

  it("sends a request no consent covers to the redirect URI as consent_required", async () => {
    const app = await registerApp(server, NOTES);
    const sent = await landing(
      authorizeQuery(app.clientId, NOTES, pkce(), { prompt: "none" }),
    );
    expect(sent?.href.startsWith(CALLBACK), String(sent)).toBe(true);
    expect(sent?.searchParams.get("error")).toBe("consent_required");
    expect(sent?.searchParams.get("state")).toBe("signed-in-fixture");
  });

  it("answers a request a standing consent covers with a code", async () => {
    const app = await registerApp(server, NOTES);
    await codeFor(server, origin, cookie, app, NOTES);
    const sent = await landing(
      authorizeQuery(app.clientId, NOTES, pkce(), { prompt: "none" }),
    );
    expect(sent?.href.startsWith(CALLBACK), String(sent)).toBe(true);
    expect(sent?.searchParams.get("code")).toBeTruthy();
  });
});

describe("the request an app sends", () => {
  it("is refused at the redirect URI without a PKCE challenge", async () => {
    const app = await registerApp(server, NOTES);
    const sent = await landing(authorizeQuery(app.clientId, NOTES, undefined));
    expect(sent?.href.startsWith(CALLBACK), String(sent)).toBe(true);
    expect(sent?.searchParams.get("error")).toBe("invalid_request");
  });

  it("is sent to the error page, never to a redirect URI the app did not register", async () => {
    const app = await registerApp(server, NOTES);
    const query = authorizeQuery(app.clientId, NOTES, pkce());
    query.set("redirect_uri", "http://127.0.0.1:9/elsewhere");
    const response = await authorize(server, query, cookie);
    const sent = await sentTo(server, response);
    expect(sent?.origin).toBe(new URL(server.apiUrl).origin);
    expect(sent?.pathname).toBe("/auth/error");
    expect(sent?.searchParams.get("error")).toBe("invalid_redirect");
    // The witness: the registered redirect URI is answered there.
    const registered = await sentTo(
      server,
      await authorize(
        server,
        authorizeQuery(app.clientId, NOTES, pkce()),
        cookie,
      ),
    );
    expect(registered?.pathname).toBe("/auth/authorize");
  });
});

describe("the code exchange", () => {
  it("refuses a code verifier that does not match the challenge 400 invalid_grant, and issues no token", async () => {
    const app = await registerApp(server, NOTES);
    const { code } = await codeFor(server, origin, cookie, app, NOTES);
    const refused = await token(server, {
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      code_verifier: pkce().verifier,
      client_id: app.clientId,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body.error).toBe("invalid_grant");
    expect(refused.body.access_token).toBeUndefined();
  });

  it("refuses a code issued with a challenge and exchanged with no verifier 400 invalid_request, whether or not the app sends a secret", async () => {
    const open = await registerApp(server, NOTES);
    const secret = await registerApp(server, NOTES, {
      token_endpoint_auth_method: "client_secret_basic",
    });
    expect(secret.clientSecret, "the app was given no secret").toBeDefined();
    for (const app of [open, secret]) {
      const { code } = await codeFor(server, origin, cookie, app, NOTES);
      const refused = await token(
        server,
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: CALLBACK,
          client_id: app.clientId,
        },
        app,
      );
      expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      expect(refused.body.error).toBe("invalid_request");
      expect(refused.body.access_token).toBeUndefined();
    }
  });

  it("exchanges a code once, and refuses it again with invalid_grant", async () => {
    const app = await registerApp(server, NOTES);
    const { code, verifier } = await codeFor(
      server,
      origin,
      cookie,
      app,
      NOTES,
    );
    const form = {
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
      client_id: app.clientId,
    };
    const first = await token(server, form);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.token_type?.toLowerCase()).toBe("bearer");
    expect(first.body.access_token).toMatch(/^marfa_at_/);
    const again = await token(server, form);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("invalid_grant");
  });
});
