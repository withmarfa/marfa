import {
  createHash,
  createPublicKey,
  verify,
  type JsonWebKeyInput,
} from "node:crypto";
import { afterEach, expect, it } from "vitest";
import * as clock from "../clock.js";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";
import { ACCESS_TOKEN_PREFIX, makeTokenHasher } from "./oauth-provider.js";

let context: TestContext | undefined;
afterEach(async () => {
  clock.resetClockForTests();
  await context?.cleanup();
});

it("issues externally verifiable ID tokens on real time and opaque tokens on server time", async () => {
  const realNow = Date.now.bind(Date);
  clock.installDateShim();
  clock.advanceClock(86_400_000);
  const ctx = (context = await createTestContext());
  const origin = new URL(ctx.config.authBaseUrl).origin;
  const callback = "https://client.example.test/callback";
  const cookie = ctx.owner.cookie;
  const registered = await request(ctx.app, "POST", "/auth/oauth2/register", {
    body: {
      client_name: "Clock verifier",
      application_type: "web",
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: "openid core.note:read",
    },
  });
  expect(registered.status).toBe(201);
  const { client_id: clientId } = (await registered.json()) as {
    client_id: string;
  };
  const verifier = "v".repeat(64);
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callback,
    response_type: "code",
    scope: "openid core.note:read",
    state: "clock-verifier",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const authorised = await request(
    ctx.app,
    "GET",
    `/auth/oauth2/authorize?${query.toString()}`,
    { headers: { cookie } },
  );
  expect(authorised.status).toBe(302);
  const location = authorised.headers.get("location")!;
  const consent = await request(ctx.app, "POST", "/auth/authorize/decision", {
    form: {
      accept: "true",
      oauth_query: location.slice(location.indexOf("?") + 1),
      scopes: ["openid", "core.note:read"],
    },
    headers: { cookie, origin },
  });
  expect(consent.status).toBe(302);
  const code = new URL(consent.headers.get("location")!).searchParams.get(
    "code",
  )!;
  const before = Math.floor(realNow() / 1000);
  const response = await request(ctx.app, "POST", "/auth/oauth2/token", {
    form: {
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: callback,
    },
    headers: { origin },
  });
  expect(response.status).toBe(200);
  const tokens = (await response.json()) as {
    id_token: string;
    access_token: string;
  };
  const [header, payload, signature] = tokens.id_token.split(".") as [
    string,
    string,
    string,
  ];
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
    iat: number;
    exp: number;
    auth_time: number;
  };
  const jwksResponse = await request(ctx.app, "GET", "/auth/jwks");
  expect(jwksResponse.status).toBe(200);
  const jwks = (await jwksResponse.json()) as {
    keys: (JsonWebKeyInput["key"] & { kid: string })[];
  };
  const { kid } = JSON.parse(Buffer.from(header, "base64url").toString()) as {
    kid: string;
  };
  const key = jwks.keys.find((candidate) => candidate.kid === kid)!;
  expect(
    verify(
      null,
      Buffer.from(`${header}.${payload}`),
      createPublicKey({ key, format: "jwk" }),
      Buffer.from(signature, "base64url"),
    ),
  ).toBe(true);
  expect(claims.iat).toBeGreaterThanOrEqual(before);
  expect(claims.iat).toBeLessThanOrEqual(Math.floor(realNow() / 1000));
  expect(claims.exp - claims.iat).toBe(36_000);
  expect(claims.auth_time).toBeLessThanOrEqual(Math.floor(realNow() / 1000));
  const current = await request(ctx.app, "GET", "/items?type=core.note", {
    key: tokens.access_token,
  });
  expect(current.status).toBe(200);
  const digest = makeTokenHasher(TEST_API_KEY_SALT)(
    tokens.access_token.slice(ACCESS_TOKEN_PREFIX.length),
  );
  const access = await ctx.storage.oauthProvider!.validateAccessToken(digest);
  expect(access?.expiresAtMs).toBeGreaterThan((before + 86_400) * 1000);
});
