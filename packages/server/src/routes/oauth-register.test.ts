import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * Tests for the Marfa-owned `POST /auth/oauth2/register` endpoint that
 * fronts the @better-auth/oauth-provider plugin's DCR. See
 * `oauth-register.ts` for the why-we-override doc-block.
 *
 * Coverage:
 *   - 201 happy paths: `authorization_code`, `device_code` URN,
 *     combined `device_code + refresh_token`.
 *   - 400 validation paths matching the plugin's existing rejection
 *     shape so a third-party SDK previously calling the plugin's DCR
 *     sees no regression: missing `redirect_uris` for `authorization_code`,
 *     `client_credentials` (a grant this server does not have),
 *     `refresh_token` standalone,
 *     `javascript:` / non-loopback http: redirect URIs.
 *   - 400 invalid_scope when the body's `scope` literal is not in the
 *     server's allowed-scope set.
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

describe("POST /auth/oauth2/register", () => {
  it("returns 201 for grant_types: ['authorization_code']", async () => {
    // Routes through the Marfa override; the plugin's DCR would 500 on
    // PG due to mishandled string[] columns in Better Auth's Drizzle adapter.
    ctx = await createTestContext({});
    const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: {
        redirect_uris: ["http://localhost/cb"],
        grant_types: ["authorization_code"],
        client_name: "t158-authcode",
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.client_id).toBe("string");
    expect((body.client_id as string).length).toBeGreaterThanOrEqual(20);
    expect(body.grant_types).toEqual(["authorization_code"]);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.public).toBe(true);
    expect(body.disabled).toBe(false);
  });

  it("returns 201 for grant_types: [device_code URN]", async () => {
    // Gap 2 — the plugin's body Zod enum rejected the URN at validation
    // time; the Marfa override accepts it.
    ctx = await createTestContext({});
    const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: {
        grant_types: [DEVICE_CODE_GRANT],
        client_name: "t158-devcode",
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.grant_types).toEqual([DEVICE_CODE_GRANT]);
    // Device-only clients have no browser redirect — empty array is
    // valid and confirms we didn't silently default to anything.
    expect(body.redirect_uris).toEqual([]);
  });

  it("returns 201 for combined grant_types: [device_code, refresh_token]", async () => {
    // The SDK's `startDeviceFlow` expects refresh-token rotation as a
    // first-class part of the device flow, so the device-code +
    // refresh_token combination is the common shape.
    ctx = await createTestContext({});
    const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: {
        grant_types: [DEVICE_CODE_GRANT, "refresh_token"],
        client_name: "t158-dev-rt",
        scope: "core.note:read offline_access",
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.grant_types).toEqual([DEVICE_CODE_GRANT, "refresh_token"]);
    // `offline_access` was named, so it is not added twice; `openid` is what
    // the ceiling gains, since a session scope missing from a registration is
    // unrecoverable once the client_id is persisted.
    expect(body.scope).toBe("core.note:read offline_access openid");
  });

  it("registered client is discoverable via the device-flow initiation path", async () => {
    // A row written by DCR must be readable by
    // `storage.oauthProvider.getClient` (which safeJsonParse's
    // `redirect_uris`). The Marfa override writes the column in the
    // JSON-encoded shape the reader expects.
    ctx = await createTestContext({});
    const regRes = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: {
        grant_types: [DEVICE_CODE_GRANT],
        client_name: "t158-roundtrip",
      },
    });
    expect(regRes.status).toBe(201);
    const reg = (await regRes.json()) as { client_id: string };
    // Initiate the device flow — the handler looks up the client by
    // business key and 200-s with the device_code / user_code pair.
    const initRes = await request(ctx.app, "POST", "/auth/device", {
      body: {
        client_id: reg.client_id,
        scope: "core.note:read",
      },
    });
    expect(initRes.status).toBe(200);
    const init = (await initRes.json()) as { device_code: string };
    expect(init.device_code).toMatch(/^marfa_dc_/);
  });

  it("rejects authorization_code grant without redirect_uris", async () => {
    ctx = await createTestContext({});
    const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: {
        grant_types: ["authorization_code"],
        client_name: "t158-no-redirect",
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("rejects the client_credentials grant, which this server does not have", async () => {
    ctx = await createTestContext({});
    const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: {
        grant_types: ["client_credentials"],
        client_name: "t158-cc",
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("rejects refresh_token grant in isolation", async () => {
    ctx = await createTestContext({});
    const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: {
        grant_types: ["refresh_token"],
        client_name: "t158-rt",
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("rejects javascript: redirect URIs", async () => {
    ctx = await createTestContext({});
    const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: {
        redirect_uris: ["javascript:alert(1)"],
        grant_types: ["authorization_code"],
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("rejects non-loopback http:// redirect URIs", async () => {
    ctx = await createTestContext({});
    const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: {
        redirect_uris: ["http://example.com/cb"],
        grant_types: ["authorization_code"],
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("accepts loopback http:// redirect URIs (127.0.0.1, localhost)", async () => {
    ctx = await createTestContext({});
    for (const uri of [
      "http://127.0.0.1:8080/cb",
      "http://localhost:9999/cb",
      "http://[::1]:1234/cb",
    ]) {
      const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
        body: {
          redirect_uris: [uri],
          grant_types: ["authorization_code"],
        },
      });
      expect(res.status).toBe(201);
    }
  });

  it("persists registered post-logout redirect URIs", async () => {
    ctx = await createTestContext({});
    const postLogoutRedirectUri = "http://localhost:5173/";
    const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: {
        redirect_uris: ["http://localhost:5173/auth/callback"],
        post_logout_redirect_uris: [postLogoutRedirectUri],
        grant_types: ["authorization_code"],
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      client_id: string;
      post_logout_redirect_uris?: string[];
    };
    expect(body.post_logout_redirect_uris).toEqual([postLogoutRedirectUri]);

    const client = await ctx.storage.oauthProvider?.getClient(body.client_id);
    expect(client?.postLogoutRedirectUris).toEqual([postLogoutRedirectUri]);
  });

  it("rejects unsafe post-logout redirect URIs", async () => {
    ctx = await createTestContext({});
    const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: {
        redirect_uris: ["http://localhost:5173/auth/callback"],
        post_logout_redirect_uris: ["javascript:alert(1)"],
        grant_types: ["authorization_code"],
      },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_client_metadata",
    );
  });

  it("accepts http:// redirect URIs whose origin is in the trusted-origin allowlist", async () => {
    // A self-hosted browser client served over plain http on a private
    // network (a LAN host, a Tailscale MagicDNS name) registers a
    // non-loopback http redirect. The operator opts in by listing the
    // origin in CORS_ORIGINS; the DCR validator then accepts it.
    ctx = await createTestContext({
      corsOrigins: ["http://home-server:9021"],
    });
    const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: {
        redirect_uris: ["http://home-server:9021/auth/callback"],
        grant_types: ["authorization_code"],
        client_name: "trusted-origin-http",
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.redirect_uris).toEqual([
      "http://home-server:9021/auth/callback",
    ]);
  });

  it("still rejects http:// redirect URIs whose origin is not trusted", async () => {
    // Same shape, but the origin is absent from CORS_ORIGINS — the
    // exemption must not fire just because some other origin is trusted.
    ctx = await createTestContext({
      corsOrigins: ["http://home-server:9021"],
    });
    const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: {
        redirect_uris: ["http://evil.example.com/cb"],
        grant_types: ["authorization_code"],
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("rejects scopes outside the server's allowed set", async () => {
    ctx = await createTestContext({});
    const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
      body: {
        grant_types: [DEVICE_CODE_GRANT],
        scope: "totally:made:up",
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_scope");
  });

  it("rejects non-JSON content-type", async () => {
    ctx = await createTestContext({});
    const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(400);
  });
});
