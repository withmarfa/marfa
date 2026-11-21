import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { offeredValues, visibleText } from "../../utils/approval-form.js";
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
    "/auth/consent",
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
    const offered = offeredValues(await page.text(), "scopes");
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

  it("refuses a consent post that names neither approve nor deny, and records no consent and issues no code", async () => {
    const app = await registerApp(server, NOTES);
    const consent = await consentScreen(
      authorizeQuery(app.clientId, NOTES, pkce()),
    );
    const request = consent.search.slice(1);
    const posts: [string, string][][] = [
      [
        ["decision", "accept"],
        ["authorization_request", request],
      ],
      [
        ["decision", "APPROVE"],
        ["authorization_request", request],
      ],
      [
        ["decision", ""],
        ["authorization_request", request],
      ],
      [
        ["accept", "true"],
        ["authorization_request", request],
      ],
      [["authorization_request", request]],
      [["decision", "approve"]],
    ];
    for (const fields of posts) {
      const refused = await fetch(`${server.apiUrl}/auth/consent`, {
        method: "POST",
        redirect: "manual",
        headers: {
          cookie,
          origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams([...fields, ["scopes", NOTES]]),
      });
      const body = (await refused.json()) as { error?: { code?: string } };
      expect(refused.status, JSON.stringify(fields)).toBe(400);
      expect(body.error?.code, JSON.stringify(fields)).toBe("validation_error");
      expect(
        refused.headers.get("location"),
        JSON.stringify(fields),
      ).toBeNull();
    }
    // The witness: no consent was recorded, so the app is asked again, and a
    // post that names its decision is answered with a code.
    await consentScreen(authorizeQuery(app.clientId, NOTES, pkce()));
    const sent = await decide(server, origin, cookie, consent, true, [NOTES]);
    expect(sent?.searchParams.get("code")).not.toBeNull();
  });

  it("issues a token for only the scopes the person chose", async () => {
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

  /** Each response the server sends to a redirect URI: the code, then each error. */
  async function responses(): Promise<
    { name: string; sent: URL | undefined }[]
  > {
    const app = await registerApp(server, NOTES);
    const consent = await consentScreen(
      authorizeQuery(app.clientId, NOTES, pkce()),
    );
    const declined = await consentScreen(
      authorizeQuery(app.clientId, NOTES, pkce()),
    );
    return [
      {
        name: "code",
        sent: await decide(server, origin, cookie, consent, true, [NOTES]),
      },
      {
        name: "access_denied",
        sent: await decide(server, origin, cookie, declined, false, [NOTES]),
      },
      {
        name: "invalid_request",
        sent: await landing(authorizeQuery(app.clientId, NOTES, undefined)),
      },
      {
        name: "invalid_scope",
        sent: await landing(
          authorizeQuery(
            app.clientId,
            "user.nothing_registered_here:read",
            pkce(),
          ),
        ),
      },
      {
        name: "login_required",
        sent: await landing(
          authorizeQuery(app.clientId, NOTES, pkce(), { prompt: "none" }),
          null,
        ),
      },
      {
        name: "consent_required",
        sent: await landing(
          authorizeQuery(app.clientId, `${NOTES} ${BOOKMARKS}`, pkce(), {
            prompt: "none",
          }),
        ),
      },
    ];
  }

  it("sends its issuer with the code and with each error it sends to a redirect URI", async () => {
    const issuer = (
      (await (
        await fetch(`${server.apiUrl}/.well-known/oauth-authorization-server`)
      ).json()) as { issuer: string }
    ).issuer;
    for (const { name, sent } of await responses()) {
      expect(sent?.href.startsWith(CALLBACK), `${name}: ${String(sent)}`).toBe(
        true,
      );
      expect(sent?.searchParams.get("iss"), name).toBe(issuer);
      if (name === "code") {
        expect(sent?.searchParams.get("code")).toBeTruthy();
      } else {
        expect(sent?.searchParams.get("error"), String(sent)).toBe(name);
      }
    }
  });

  it("says why in an error_description with each error it sends to a redirect URI", async () => {
    for (const { name, sent } of await responses()) {
      if (name === "code") {
        // The witness: a code is no error, and carries no description.
        expect(sent?.searchParams.get("code")).toBeTruthy();
        expect(sent?.searchParams.get("error_description")).toBeNull();
        continue;
      }
      expect(sent?.searchParams.get("error"), String(sent)).toBe(name);
      const why = sent?.searchParams.get("error_description") ?? "";
      expect(why.trim().length, `${name}: ${String(sent)}`).toBeGreaterThan(0);
    }
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

  it("sends a refusal for a web app nobody approved to the error page, and to its redirect URI once the person approves it", async () => {
    const web = "https://app.example/callback";
    const app = await registerApp(server, NOTES, {
      application_type: "web",
      redirect_uris: [web],
    });
    const asked = (proof: ReturnType<typeof pkce> | undefined) => {
      const query = authorizeQuery(app.clientId, NOTES, proof);
      query.set("redirect_uri", web);
      return query;
    };
    const ownPage = new URL(server.apiUrl).origin;
    for (const [query, as, error] of [
      [asked(undefined), cookie, "invalid_request"],
      [
        (() => {
          const silent = asked(pkce());
          silent.set("prompt", "none");
          return silent;
        })(),
        null,
        "login_required",
      ],
    ] as const) {
      const sent = await landing(query, as);
      expect(sent?.origin, String(sent)).toBe(ownPage);
      expect(sent?.pathname).toBe("/auth/error");
      expect(sent?.searchParams.get("error")).toBe(error);
    }
    // The witness: once the person approves the app there, the same refusal goes to it.
    const consent = await consentScreen(asked(pkce()));
    const approved = await decide(server, origin, cookie, consent, true, [
      NOTES,
    ]);
    expect(approved?.href.startsWith(web), String(approved)).toBe(true);
    const sent = await landing(asked(undefined));
    expect(sent?.href.startsWith(web), String(sent)).toBe(true);
    expect(sent?.searchParams.get("error")).toBe("invalid_request");
    expect(sent?.searchParams.get("state")).toBe("signed-in-fixture");
  });

  it("sends a refusal from nobody signed in to the error page for a web app the person approved, and to its redirect URI once they are signed in", async () => {
    const web = "https://approved.example/callback";
    const app = await registerApp(server, NOTES, {
      application_type: "web",
      redirect_uris: [web],
    });
    const asked = (
      proof: ReturnType<typeof pkce> | undefined,
      extra: Record<string, string> = {},
    ) => {
      const query = authorizeQuery(app.clientId, NOTES, proof, extra);
      query.set("redirect_uri", web);
      return query;
    };
    const approved = await decide(
      server,
      origin,
      cookie,
      await consentScreen(asked(pkce())),
      true,
      [NOTES],
    );
    expect(approved?.href.startsWith(web), String(approved)).toBe(true);
    const ownPage = new URL(server.apiUrl).origin;
    for (const [refused, error] of [
      [() => asked(undefined), "invalid_request"],
      [() => asked(pkce(), { prompt: "none" }), "login_required"],
      [
        () => asked(pkce(), { response_type: "token" }),
        "unsupported_response_type",
      ],
      [
        () => asked(pkce(), { scope: "nothing.grantable:read" }),
        "invalid_scope",
      ],
    ] as const) {
      // The witness: the person signed in, whose consent covers the address,
      // is sent the same refusal there, except the one signed-in answer a
      // silent request has instead.
      if (error !== "login_required") {
        const witness = await landing(refused());
        expect(witness?.href.startsWith(web), String(witness)).toBe(true);
        expect(witness?.searchParams.get("error")).toBe(error);
      }
      const sent = await landing(refused(), null);
      expect(sent?.origin, String(sent)).toBe(ownPage);
      expect(sent?.pathname).toBe("/auth/error");
      expect(sent?.searchParams.get("error")).toBe(error);
    }
  });

  it("sends a request for a response type other than code to the redirect URI as unsupported_response_type", async () => {
    const app = await registerApp(server, NOTES);
    for (const type of ["token", "id_token", ""]) {
      const sent = await landing(
        authorizeQuery(app.clientId, NOTES, pkce(), { response_type: type }),
      );
      expect(sent?.href.startsWith(CALLBACK), String(sent)).toBe(true);
      expect(sent?.searchParams.get("error")).toBe("unsupported_response_type");
    }
    const missing = authorizeQuery(app.clientId, NOTES, pkce());
    missing.delete("response_type");
    const sent = await landing(missing);
    expect(sent?.searchParams.get("error")).toBe("unsupported_response_type");
    // The witness: the same request with the code type reaches the consent screen.
    const asked = await landing(authorizeQuery(app.clientId, NOTES, pkce()));
    expect(asked?.pathname).toBe("/auth/consent");
  });

  it("sends a request from an app not registered for the authorization code grant to the redirect URI as unauthorized_client", async () => {
    const device = "urn:ietf:params:oauth:grant-type:device_code";
    const app = await registerApp(server, NOTES, { grant_types: [device] });
    const sent = await landing(authorizeQuery(app.clientId, NOTES, pkce()));
    expect(sent?.href.startsWith(CALLBACK), String(sent)).toBe(true);
    expect(sent?.searchParams.get("error")).toBe("unauthorized_client");
    // The witness: an app registered for the grant reaches the consent screen.
    const registered = await registerApp(server, NOTES);
    const asked = await landing(
      authorizeQuery(registered.clientId, NOTES, pkce()),
    );
    expect(asked?.pathname).toBe("/auth/consent");
  });

  it("answers a device code request from an app not registered for the device grant 400 unauthorized_client", async () => {
    const ask = (clientId: string): Promise<Response> =>
      fetch(`${server.apiUrl}/oauth/device-authorization`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, scope: NOTES }),
      });
    const app = await registerApp(server, NOTES);
    const refused = await ask(app.clientId);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "unauthorized_client",
    );
    // The witness: an app registered for the grant is issued a code.
    const registered = await registerApp(server, NOTES, {
      grant_types: ["urn:ietf:params:oauth:grant-type:device_code"],
    });
    const issued = await ask(registered.clientId);
    expect(issued.status, await issued.clone().text()).toBe(200);
    await issued.body?.cancel();
  });

  it("answers a token request for a grant the app is not registered for 400 unauthorized_client", async () => {
    const app = await registerApp(server, NOTES, {
      grant_types: ["authorization_code"],
    });
    const refused = await token(server, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "not-a-code",
      client_id: app.clientId,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("unauthorized_client");
    // The witness: a grant the app is registered for gets as far as judging the code.
    const registered = await token(server, {
      grant_type: "authorization_code",
      code: "not-a-code",
      redirect_uri: CALLBACK,
      code_verifier: pkce().verifier,
      client_id: app.clientId,
    });
    expect(registered.status).toBe(400);
    expect(registered.body.error).toBe("invalid_grant");

    // A refresh token needs the refresh grant or the authorization code grant,
    // which allows it.
    const device = await registerApp(server, NOTES, {
      grant_types: ["urn:ietf:params:oauth:grant-type:device_code"],
    });
    const refresh = (clientId: string) =>
      token(server, {
        grant_type: "refresh_token",
        refresh_token: "not-a-token",
        client_id: clientId,
      });
    const deviceOnly = await refresh(device.clientId);
    expect(deviceOnly.status).toBe(400);
    expect(deviceOnly.body.error).toBe("unauthorized_client");
    // The witness: an app registered for the authorization code grant alone
    // gets as far as judging the token.
    const allowed = await refresh(app.clientId);
    expect(allowed.status).toBe(400);
    expect(allowed.body.error).toBe("invalid_grant");
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
    expect(registered?.pathname).toBe("/auth/consent");
  });
});

describe("a native app's private-use redirect URI", () => {
  const RETURN = "com.example.marfa-fixture:/callback";

  it("sends the code to the private-use redirect URI the app registered, which the app exchanges there", async () => {
    const app = await registerApp(server, NOTES, { redirect_uris: [RETURN] });
    const proof = pkce();
    const query = authorizeQuery(app.clientId, NOTES, proof, {
      redirect_uri: RETURN,
    });
    const sent = await decide(
      server,
      origin,
      cookie,
      await consentScreen(query),
      true,
      [NOTES],
    );
    expect(sent?.protocol).toBe("com.example.marfa-fixture:");
    expect(sent?.pathname).toBe("/callback");
    expect(sent?.searchParams.get("state")).toBe("signed-in-fixture");
    const code = sent?.searchParams.get("code");
    expect(code, String(sent)).toBeTruthy();
    const exchanged = await token(server, {
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: RETURN,
      code_verifier: proof.verifier,
      client_id: app.clientId,
    });
    expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
    expect(exchanged.body.access_token).toMatch(/^marfa_at_/);
  });

  it("sends a request naming a private-use redirect URI the app did not register to the error page", async () => {
    const app = await registerApp(server, NOTES, { redirect_uris: [RETURN] });
    for (const unregistered of [
      "com.example.marfa-fixture:/other",
      "com.example.marfa-fixture:/callback/",
      "com.example.elsewhere:/callback",
    ]) {
      const query = authorizeQuery(app.clientId, NOTES, pkce(), {
        redirect_uri: unregistered,
      });
      const sent = await landing(query);
      expect(sent?.origin, unregistered).toBe(new URL(server.apiUrl).origin);
      expect(sent?.pathname, unregistered).toBe("/auth/error");
      expect(sent?.searchParams.get("error"), unregistered).toBe(
        "invalid_redirect",
      );
    }
    // The witness: the registered one reaches the consent screen.
    await consentScreen(
      authorizeQuery(app.clientId, NOTES, pkce(), { redirect_uri: RETURN }),
    );
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

  it("refuses a code issued with a challenge and exchanged with no verifier 400 invalid_request", async () => {
    const app = await registerApp(server, NOTES);
    const { code } = await codeFor(server, origin, cookie, app, NOTES);
    const refused = await token(server, {
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      client_id: app.clientId,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body.error).toBe("invalid_request");
    expect(refused.body.access_token).toBeUndefined();
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

describe("a type registered while the server runs", () => {
  it("is offered and granted at once, to an app registered before it", async () => {
    const type = "user.recipe_while_running";
    const scope = `${type}:read`;
    // Registered with no scope, so for the owner's content, which covers it.
    const app = await registerApp(server, NOTES, { scope: undefined });

    // The witness: before the type exists, its scope is dropped.
    const before = await consentScreen(
      authorizeQuery(app.clientId, `${scope} ${NOTES}`, pkce()),
    );
    expect(before.searchParams.get("scope")).toBe(NOTES);

    const registered = await fetch(`${server.apiUrl}/types`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${server.workingKey}`,
      },
      body: JSON.stringify({
        id: type,
        version: 1,
        fields: { title: { type: "string" } },
      }),
    });
    expect(registered.status).toBe(201);

    const proof = pkce();
    const consent = await consentScreen(
      authorizeQuery(app.clientId, scope, proof),
    );
    const page = await (await fetch(consent, { headers: { cookie } })).text();
    expect(offeredValues(page, "scopes")).toContain(scope);
    const sent = await decide(server, origin, cookie, consent, true, [scope]);
    const exchanged = await token(server, {
      grant_type: "authorization_code",
      code: sent?.searchParams.get("code") ?? "",
      redirect_uri: CALLBACK,
      code_verifier: proof.verifier,
      client_id: app.clientId,
    });
    expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
    expect(exchanged.body.scope).toBe(scope);
  });
});

describe("an app's own type namespace", () => {
  async function registerType(id: string): Promise<void> {
    const registered = await fetch(`${server.apiUrl}/types`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${server.workingKey}`,
      },
      body: JSON.stringify({
        id,
        version: 1,
        fields: { title: { type: "string" } },
      }),
    });
    expect(registered.status, id).toBe(201);
  }

  async function createItem(access: string, type: string): Promise<number> {
    const response = await fetch(`${server.apiUrl}/items`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${access}`,
      },
      body: JSON.stringify({ type, properties: { title: "made by the app" } }),
    });
    await response.body?.cancel();
    return response.status;
  }

  it("is offered and granted for app.<vendor>.*, reaches that vendor's types registered before and after, and no other vendor's", async () => {
    await registerType("app.nsone.widget");
    await registerType("app.nsone2.gadget");
    const scope = "app.nsone.*:write";
    const app = await registerApp(server, scope);

    // The witness: a vendor namespace no type sits under is dropped.
    const none = await consentScreen(
      authorizeQuery(app.clientId, `${scope} app.nsnone.*:write`, pkce()),
    );
    expect(none.searchParams.get("scope")).toBe(scope);

    const proof = pkce();
    const consent = await consentScreen(
      authorizeQuery(app.clientId, scope, proof),
    );
    const page = await (await fetch(consent, { headers: { cookie } })).text();
    expect(offeredValues(page, "scopes")).toContain(scope);
    const sent = await decide(server, origin, cookie, consent, true, [scope]);
    const exchanged = await token(server, {
      grant_type: "authorization_code",
      code: sent?.searchParams.get("code") ?? "",
      redirect_uri: CALLBACK,
      code_verifier: proof.verifier,
      client_id: app.clientId,
    });
    expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
    expect(exchanged.body.scope).toBe(scope);
    const access = exchanged.body.access_token!;

    await registerType("app.nsone.gizmo");
    expect(await createItem(access, "app.nsone.widget")).toBe(201);
    expect(await createItem(access, "app.nsone.gizmo")).toBe(201);
    expect(await createItem(access, "app.nsone2.gadget")).toBe(403);
    expect(await createItem(access, "core.note")).toBe(403);
  });

  it("is dropped from a request by an app registered for another vendor's namespace", async () => {
    await registerType("app.nsthree.widget");
    await registerType("app.nsfour.widget");
    const app = await registerApp(server, "app.nsthree.*:write");
    const consent = await consentScreen(
      authorizeQuery(
        app.clientId,
        "app.nsthree.*:write app.nsfour.*:write",
        pkce(),
      ),
    );
    expect(consent.searchParams.get("scope")).toBe("app.nsthree.*:write");
  });

  it("titles the rows for every app's data and for one vendor's data on the consent screen", async () => {
    await registerType("app.nstitled.widget");
    const scope = "app.*:read app.nstitled.*:read";
    const app = await registerApp(server, scope);
    const consent = await consentScreen(
      authorizeQuery(app.clientId, scope, pkce()),
    );
    const text = visibleText(
      await (await fetch(consent, { headers: { cookie } })).text(),
    );
    expect(text).toContain("Every app's data");
    expect(text).toContain("App data from nstitled");
  });

  it("is offered and granted for common.* where no common type is registered, titled Shared types", async () => {
    const scope = "common.*:read";
    const app = await registerApp(server, scope);

    // The witness: a root no type sits under is dropped.
    const dropped = await consentScreen(
      authorizeQuery(app.clientId, `${scope} nowhere.*:read`, pkce()),
    );
    expect(dropped.searchParams.get("scope")).toBe(scope);

    const proof = pkce();
    const consent = await consentScreen(
      authorizeQuery(app.clientId, scope, proof),
    );
    const page = await (await fetch(consent, { headers: { cookie } })).text();
    expect(offeredValues(page, "scopes")).toContain(scope);
    expect(visibleText(page)).toContain("Shared types");
    const sent = await decide(server, origin, cookie, consent, true, [scope]);
    const exchanged = await token(server, {
      grant_type: "authorization_code",
      code: sent?.searchParams.get("code") ?? "",
      redirect_uri: CALLBACK,
      code_verifier: proof.verifier,
      client_id: app.clientId,
    });
    expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
    expect(exchanged.body.scope).toBe(scope);

    // Shared types are item types: no edge scope under `common` is offered,
    // while the same request names `edge.user.*`, which is.
    const edgeScope = "common.*:read edge.common.*:read edge.user.*:read";
    const both = await registerApp(server, edgeScope);
    const narrowed = await consentScreen(
      authorizeQuery(both.clientId, edgeScope, pkce()),
    );
    expect(narrowed.searchParams.get("scope")?.split(" ")).toEqual([
      "common.*:read",
      "edge.user.*:read",
    ]);
    const published = (
      (await (
        await fetch(`${server.apiUrl}/.well-known/oauth-authorization-server`)
      ).json()) as { scopes_supported: string[] }
    ).scopes_supported;
    expect(published).toContain("common.*:read");
    expect(published).toContain("edge.user.*:read");
    expect(published).not.toContain("edge.common.*:read");
  });

  it("is offered on a device code for app.<vendor>.*, and refused for a vendor no type sits under", async () => {
    await registerType("app.nsdevice.widget");
    const app = await registerApp(server, "app.nsdevice.*:write", {
      grant_types: [
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:device_code",
      ],
    });
    const ask = (scope: string): Promise<Response> =>
      fetch(`${server.apiUrl}/oauth/device-authorization`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: app.clientId, scope }),
      });
    const issued = await ask("app.nsdevice.*:write");
    expect(issued.status, await issued.clone().text()).toBe(200);
    await issued.body?.cancel();
    const refused = await ask("app.nsnodevice.*:write");
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "invalid_scope",
    );
  });
});

describe("a client_id that is a metadata document URL", () => {
  it.each([
    "https://127.0.0.1/client.json",
    "https://10.0.0.1/client.json",
    "https://169.254.169.254/client.json",
    "https://[::1]/client.json",
    "https://localhost/client.json",
  ])("is refused 400 invalid_client at %s", async (clientId) => {
    const query = authorizeQuery(clientId, NOTES, pkce());
    query.set("redirect_uri", "https://app.example.test/callback");
    const response = await authorize(server, query, cookie);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("invalid_client");
  });
});
