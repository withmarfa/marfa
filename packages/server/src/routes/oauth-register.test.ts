import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * T-158: tests for the Marfa-owned `POST /auth/oauth2/register` endpoint
 * that fronts the @better-auth/oauth-provider plugin's DCR. See
 * `oauth-register.ts` for the why-we-override doc-block.
 *
 * Coverage:
 *   - 201 happy paths: `authorization_code`, `device_code` URN,
 *     combined `device_code + refresh_token`.
 *   - 400 validation paths matching the plugin's existing rejection
 *     shape so a third-party SDK previously calling the plugin's DCR
 *     sees no regression: missing `redirect_uris` for `authorization_code`,
 *     `client_credentials` (requires auth), `refresh_token` standalone,
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

describe("POST /auth/oauth2/register (T-158)", () => {
  it("returns 201 for grant_types: ['authorization_code']", async () => {
    // Gap 3 — pre-T-158 this path went through the plugin's DCR and
    // 500-ed on PG (string[] columns mishandled by Better Auth's
    // Drizzle adapter). Now routes through the Marfa override.
    ctx = await createTestContext({ authAllowSignup: false });
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
    ctx = await createTestContext({ authAllowSignup: false });
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
    ctx = await createTestContext({ authAllowSignup: false });
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
    expect(body.scope).toBe("core.note:read offline_access");
  });

  it("registered client is discoverable via the device-flow initiation path", async () => {
    // The roundtrip that broke before T-158: a row written by DCR has
    // to be readable by `storage.oauthProvider.getClient` (which
    // safeJsonParse's `redirect_uris`). The Marfa override writes the
    // column in the JSON-encoded shape the reader expects.
    ctx = await createTestContext({ authAllowSignup: false });
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
    ctx = await createTestContext({ authAllowSignup: false });
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

  it("rejects unauthenticated client_credentials grant", async () => {
    ctx = await createTestContext({ authAllowSignup: false });
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
    ctx = await createTestContext({ authAllowSignup: false });
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
    ctx = await createTestContext({ authAllowSignup: false });
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
    ctx = await createTestContext({ authAllowSignup: false });
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
    ctx = await createTestContext({ authAllowSignup: false });
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

  it("rejects scopes outside the server's allowed set", async () => {
    ctx = await createTestContext({ authAllowSignup: false });
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
    ctx = await createTestContext({ authAllowSignup: false });
    const res = await request(ctx.app, "POST", "/auth/oauth2/register", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(400);
  });
});
