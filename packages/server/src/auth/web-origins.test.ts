import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ensureInstanceId } from "../storage/instance-id.js";
import {
  createTestContext,
  seedOauthBearer,
  type TestApp,
  type TestContext,
} from "../test-utils.js";
import { webOriginsOf } from "./web-origins.js";

vi.setConfig({ testTimeout: 45_000 });

const PAGE = "https://page.example";
const CONFIGURED = "https://configured.example";
const LOCALHOST = "http://localhost:5173";

let ctx: TestContext | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.cleanup();
  ctx = undefined;
});

describe("webOriginsOf", () => {
  it("takes each https redirect URI's origin once, whatever path, query, port or case it carries", () => {
    expect(
      webOriginsOf({
        applicationType: "web",
        redirectUris: [
          "https://Page.Example/app/callback/",
          "https://page.example:443/other?from=page",
          "https://page.example:8443/callback",
          "https://second.example/",
        ],
      }),
    ).toEqual([
      "https://page.example",
      "https://page.example:8443",
      "https://second.example",
    ]);
  });

  it("names no origin for a native app, a custom scheme, plain http or an unparseable URI", () => {
    expect(
      webOriginsOf({
        applicationType: "native",
        redirectUris: ["https://page.example/callback"],
      }),
    ).toEqual([]);
    expect(
      webOriginsOf({
        applicationType: null,
        redirectUris: ["https://page.example/callback"],
      }),
    ).toEqual([]);
    expect(
      webOriginsOf({
        applicationType: "web",
        redirectUris: [
          "com.example.app:/callback",
          "http://page.example/callback",
          "not a url",
        ],
      }),
    ).toEqual([]);
  });
});

/** A second app over the same database, under another configuration. */
async function appWith(
  c: TestContext,
  overrides: { isProduction: boolean; corsOrigins: string[] },
): Promise<TestApp> {
  return createApp(
    c.storage,
    c.blobs,
    c.housekeeping,
    { ...c.config, ...overrides },
    await ensureInstanceId(c.storage.settings),
  );
}

async function allowedOrigin(
  app: TestApp,
  origin: string,
  credential: string,
): Promise<{ preflight: string | null; read: string | null }> {
  const preflight = await app.request("/items", {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    },
  });
  const read = await app.request("/items?limit=1", {
    headers: { origin, authorization: `Bearer ${credential}` },
  });
  expect(read.status).toBe(200);
  return {
    preflight: preflight.headers.get("access-control-allow-origin"),
    read: read.headers.get("access-control-allow-origin"),
  };
}

describe("the origin layer", () => {
  it("allows an approved web page's origin in production, where an approved native app's loopback origin stays refused, and forgets it on disconnect", async () => {
    ctx = await createTestContext();
    const page = await seedOauthBearer(ctx, ["core.note:read"], {
      webRedirectUri: `${PAGE}/app/callback`,
    });
    await seedOauthBearer(ctx, ["core.note:read"]);
    const production = await appWith(ctx, {
      isProduction: true,
      corsOrigins: [CONFIGURED],
    });

    expect(await allowedOrigin(production, PAGE, page.token)).toEqual({
      preflight: PAGE,
      read: PAGE,
    });
    expect(await allowedOrigin(production, LOCALHOST, page.token)).toEqual({
      preflight: null,
      read: null,
    });
    expect(await allowedOrigin(production, CONFIGURED, page.token)).toEqual({
      preflight: CONFIGURED,
      read: CONFIGURED,
    });

    const revoked = await ctx.ownerRequest(`/auth/grants/${page.grantId}`, {
      method: "DELETE",
      headers: { origin: new URL(ctx.config.authBaseUrl).origin },
    });
    expect(revoked.status).toBe(204);
    expect(await allowedOrigin(production, PAGE, ctx.workingKey)).toEqual({
      preflight: null,
      read: null,
    });
  });

  it("allows an approved page where no origin is configured, and reflects no localhost origin there", async () => {
    ctx = await createTestContext();
    expect(ctx.config.corsOrigins).toEqual([]);
    expect(ctx.config.isProduction).not.toBe(true);
    const page = await seedOauthBearer(ctx, ["core.note:read"], {
      webRedirectUri: `${PAGE}/callback`,
    });
    expect(await allowedOrigin(ctx.app, PAGE, page.token)).toEqual({
      preflight: PAGE,
      read: PAGE,
    });
    expect(await allowedOrigin(ctx.app, LOCALHOST, page.token)).toEqual({
      preflight: null,
      read: null,
    });
    // The witness: beside a configured origin, outside production, the same
    // localhost origin is reflected.
    const configured = await appWith(ctx, {
      isProduction: false,
      corsOrigins: [CONFIGURED],
    });
    expect(await allowedOrigin(configured, LOCALHOST, page.token)).toEqual({
      preflight: LOCALHOST,
      read: LOCALHOST,
    });
  });

  it("refuses an approved page's origin when the approvals cannot be read", async () => {
    ctx = await createTestContext();
    const page = await seedOauthBearer(ctx, ["core.note:read"], {
      webRedirectUri: `${PAGE}/callback`,
    });
    expect((await allowedOrigin(ctx.app, PAGE, page.token)).read).toBe(PAGE);
    const store = ctx.storage.oauthProvider;
    if (!store) throw new Error("the test context has no OAuth store");
    vi.spyOn(store, "listLiveGrantClients").mockRejectedValue(
      new Error("database unavailable"),
    );
    expect(await allowedOrigin(ctx.app, PAGE, page.token)).toEqual({
      preflight: null,
      read: null,
    });
  });

  it("sends nothing of its own to a request that carries no Origin", async () => {
    ctx = await createTestContext();
    await seedOauthBearer(ctx, ["core.note:read"], {
      webRedirectUri: `${PAGE}/callback`,
    });
    const read = await ctx.app.request("/items?limit=1", {
      headers: { authorization: `Bearer ${ctx.workingKey}` },
    });
    expect(read.status).toBe(200);
    expect(read.headers.get("access-control-allow-origin")).toBeNull();
    expect(read.headers.get("access-control-expose-headers")).toBeNull();
  });
});
