import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createTestContext,
  request,
  seedOauthBearer,
  type TestContext,
} from "../test-utils.js";
import { buildAllowedScopes } from "./oauth-provider.js";
let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.cleanup();
});
const forbidden = "profile.name:read profile.email:write";
it("does not advertise email write, or silently drop it from registration, authorize, device, consent or token requests", async () => {
  expect(buildAllowedScopes()).not.toContain("profile.email:write");
  const registration = {
    client_name: "profile app",
    redirect_uris: ["http://localhost:5173/callback"],
    application_type: "native",
    grant_types: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:device_code",
    ],
    token_endpoint_auth_method: "none",
    response_types: ["code"],
  };
  const good = await request(ctx.app, "POST", "/auth/oauth2/register", {
    body: registration,
  });
  expect(good.status).toBe(201);
  const { client_id } = (await good.json()) as { client_id: string };
  const bad = await request(ctx.app, "POST", "/auth/oauth2/register", {
    body: { ...registration, scope: forbidden },
  });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toMatchObject({ error: "invalid_scope" });
  const query = new URLSearchParams({
    client_id,
    scope: forbidden,
    response_type: "code",
    redirect_uri: registration.redirect_uris[0]!,
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
  });
  const get = await ctx.ownerRequest(
    `/auth/oauth2/authorize?${query.toString()}`,
  );
  expect(get.status).toBe(400);
  expect(await get.json()).toMatchObject({ error: "invalid_scope" });
  for (const path of [
    "/auth/oauth2/authorize",
    "/auth/device/code",
    "/auth/oauth2/token",
  ]) {
    const res = await request(ctx.app, "POST", path, {
      headers: {
        origin: new URL(ctx.config.authBaseUrl).origin,
        cookie: ctx.owner.cookie,
      },
      form: {
        ...Object.fromEntries(query),
        scope: forbidden,
        grant_type: "refresh_token",
        refresh_token: "irrelevant",
        accept: "true",
      },
    });
    expect(res.status, path).toBe(400);
    expect(await res.json(), path).toMatchObject({ error: "invalid_scope" });
  }
});
it("refuses a stored email-write refresh grant instead of narrowing it", async () => {
  const app = await seedOauthBearer(ctx, [
    "openid",
    "profile:write",
    "offline_access",
  ]);
  const raw = ctx.storage as typeof ctx.storage & {
    __sqliteRun(query: string, args: unknown[]): Promise<unknown>;
  };
  await raw.__sqliteRun(
    "UPDATE auth_oauth_refresh_token SET scopes = ? WHERE client_id = ?",
    [
      JSON.stringify([
        "openid",
        "profile:write",
        "profile.email:write",
        "offline_access",
      ]),
      app.clientId,
    ],
  );
  const refused = await request(ctx.app, "POST", "/auth/oauth2/token", {
    form: {
      client_id: app.clientId,
      grant_type: "refresh_token",
      refresh_token: app.refreshToken!,
    },
  });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ error: "invalid_scope" });
});

it.each(["authorization_code", "device_code"] as const)(
  "refuses stored email-write at the %s exchange",
  async (kind) => {
    const origin = new URL(ctx.config.authBaseUrl).origin;
    const registration = await request(
      ctx.app,
      "POST",
      "/auth/oauth2/register",
      {
        body: {
          client_name: "stored scope app",
          redirect_uris: ["http://localhost:5173/callback"],
          application_type: "native",
          grant_types: [
            "authorization_code",
            "urn:ietf:params:oauth:grant-type:device_code",
          ],
          token_endpoint_auth_method: "none",
          response_types: ["code"],
        },
      },
    );
    expect(registration.status).toBe(201);
    const { client_id } = (await registration.json()) as { client_id: string };
    const raw = ctx.storage as typeof ctx.storage & {
      __sqliteRun(query: string, args: unknown[]): Promise<unknown>;
    };
    const { createHash } = await import("node:crypto");
    for (const bad of [false, true]) {
      let form: Record<string, string>;
      if (kind === "authorization_code") {
        const verifier = "v".repeat(43);
        const query = new URLSearchParams({
          client_id,
          scope: "openid profile:write",
          prompt: "consent",
          response_type: "code",
          redirect_uri: "http://localhost:5173/callback",
          code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
          code_challenge_method: "S256",
        });
        const begun = await ctx.ownerRequest(
          "/auth/oauth2/authorize?" + query.toString(),
        );
        const consent = new URL(begun.headers.get("location")!, origin);
        const decision = await request(
          ctx.app,
          "POST",
          "/auth/authorize/decision",
          {
            headers: { origin, cookie: ctx.owner.cookie },
            form: {
              accept: "true",
              client_id,
              oauth_query: consent.search.slice(1),
              scopes: ["openid", "profile:write"],
            },
          },
        );
        expect(decision.status).toBe(302);
        const code = new URL(
          decision.headers.get("location")!,
        ).searchParams.get("code")!;
        form = {
          client_id,
          code,
          code_verifier: verifier,
          redirect_uri: "http://localhost:5173/callback",
          grant_type: "authorization_code",
        };
        if (bad)
          await raw.__sqliteRun(
            "UPDATE auth_verification SET value = json_set(value, '$.query.scope', ?) WHERE json_extract(value, '$.type') = 'authorization_code'",
            ["openid profile.email:write"],
          );
      } else {
        const issued = await request(ctx.app, "POST", "/auth/device/code", {
          form: { client_id, scope: "openid profile:write" },
        });
        expect(issued.status).toBe(200);
        const code = (await issued.json()) as {
          device_code: string;
          user_code: string;
        };
        const approved = await request(
          ctx.app,
          "POST",
          "/auth/device/consent",
          {
            headers: { origin, cookie: ctx.owner.cookie },
            form: {
              user_code: code.user_code,
              decision: "approve",
              scopes: ["openid", "profile:write"],
            },
          },
        );
        expect(approved.status).toBe(200);
        form = {
          client_id,
          device_code: code.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        };
        if (bad)
          await raw.__sqliteRun(
            "UPDATE auth_oauth_device_code SET scope = ? WHERE oauth_client_id = ?",
            ["openid profile.email:write", client_id],
          );
      }
      const exchanged = await request(ctx.app, "POST", "/auth/oauth2/token", {
        form,
      });
      expect(exchanged.status).toBe(bad ? 400 : 200);
      const body = (await exchanged.json()) as Record<string, unknown>;
      if (bad) expect(body).toMatchObject({ error: "invalid_scope" });
      else expect(body.access_token).toBeTypeOf("string");
    }
  },
);
