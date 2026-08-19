import { beforeEach, describe, it, expect } from "vitest";
import { startDeviceFlow } from "./device-flow.js";
import { InMemoryTokenStorage } from "./storage.js";
import { OAuthError } from "./errors.js";
import { __resetDiscoveryCache } from "./discovery.js";

/**
 * Unit tests for startDeviceFlow. Uses a mock fetch to drive the flow
 * deterministically without a running server. The server-side suite at
 * packages/server/src/routes/device-grant.test.ts covers the wire
 * behavior against a real Hono app.
 */

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function makeMockFetch(responses: Response[]): {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetch: typeof globalThis.fetch = (input, init) => {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.href;
    else url = input.url;
    calls.push({ url, init });
    const next = responses[i++];
    if (!next) {
      return Promise.reject(new Error(`unexpected fetch call to ${url}`));
    }
    return Promise.resolve(next);
  };
  return { fetch, calls };
}

const ISSUER = "http://example.test:8602";
const CLIENT_ID = "test-client";

const initiateResponse = (): Response =>
  new Response(
    JSON.stringify({
      device_code: "marfa_dc_abc",
      user_code: "WDJB-MJHT",
      verification_uri: `${ISSUER}/auth/device`,
      verification_uri_complete: `${ISSUER}/auth/device?user_code=WDJB-MJHT`,
      expires_in: 600,
      interval: 0, // 0s polling so the test runs fast
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const tokenResponse = (): Response =>
  new Response(
    JSON.stringify({
      access_token: "marfa_at_xyz",
      refresh_token: "marfa_rt_qrs",
      token_type: "bearer",
      expires_in: 3600,
      scope: "core.note:read",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const errorResponse = (errCode: string, status = 400): Response =>
  new Response(JSON.stringify({ error: errCode, error_description: errCode }), {
    status,
    headers: { "content-type": "application/json" },
  });

const discoveryResponse = (): Response =>
  new Response(
    JSON.stringify({
      issuer: `${ISSUER}/auth`,
      authorization_endpoint: `${ISSUER}/auth/oauth2/authorize`,
      token_endpoint: `${ISSUER}/auth/oauth2/token`,
      device_authorization_endpoint: `${ISSUER}/auth/device`,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("startDeviceFlow", () => {
  beforeEach(() => {
    __resetDiscoveryCache();
  });

  it("initiates and returns a handle exposing user_code + URLs", async () => {
    const { fetch, calls } = makeMockFetch([
      discoveryResponse(),
      initiateResponse(),
    ]);
    const handle = await startDeviceFlow({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      scopes: ["core.note:read"],
      storage: new InMemoryTokenStorage(),
      fetch,
    });
    expect(handle.user_code).toBe("WDJB-MJHT");
    expect(handle.verification_uri).toBe(`${ISSUER}/auth/device`);
    expect(handle.verification_uri_complete).toContain("user_code=WDJB-MJHT");
    expect(handle.expires_in).toBe(600);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(
      `${ISSUER}/.well-known/oauth-authorization-server/auth`,
    );
    expect(calls[1]?.url).toBe(`${ISSUER}/auth/device`);
    const rawBody = calls[1]?.init?.body;
    const bodyStr = typeof rawBody === "string" ? rawBody : "{}";
    const initBody = JSON.parse(bodyStr) as {
      client_id: string;
      scope: string;
    };
    expect(initBody.client_id).toBe(CLIENT_ID);
    expect(initBody.scope).toBe("core.note:read");
  });

  it("polls until approved, then returns a TokenProvider", async () => {
    const { fetch } = makeMockFetch([
      discoveryResponse(),
      initiateResponse(),
      errorResponse("authorization_pending"),
      errorResponse("authorization_pending"),
      tokenResponse(),
    ]);
    const handle = await startDeviceFlow({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      scopes: ["core.note:read"],
      storage: new InMemoryTokenStorage(),
      fetch,
    });
    const provider = await handle.pollForToken();
    const accessToken = await provider.getAccessToken();
    expect(accessToken).toBe("marfa_at_xyz");
  });

  it("refuses an approval that carries no refresh token", async () => {
    // The server issues one only when the approved scopes carry
    // `offline_access`, so this is the shape of a grant that did not ask to
    // stay signed in. Persisting it would build a provider that cannot
    // refresh and fails at the first expiry, naming neither the cause nor
    // the scope; the authorization-code path already refuses the same shape.
    const noRefresh = new Response(
      JSON.stringify({
        access_token: "marfa_at_xyz",
        token_type: "bearer",
        expires_in: 3600,
        scope: "core.note:read",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const { fetch } = makeMockFetch([
      discoveryResponse(),
      initiateResponse(),
      noRefresh,
    ]);
    const handle = await startDeviceFlow({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      scopes: ["core.note:read"],
      storage: new InMemoryTokenStorage(),
      fetch,
    });
    const caught = await handle.pollForToken().then(
      () => null,
      (err: unknown) => err,
    );
    expect(caught).toBeInstanceOf(OAuthError);
    expect((caught as OAuthError).code).toBe("invalid_grant");
    // The message names the scope, because "no refresh token" on its own
    // leaves the reader nothing to go and change.
    expect((caught as OAuthError).message).toContain("offline_access");
  });

  it("bumps interval on slow_down and continues polling", async () => {
    // SLOW_DOWN_BUMP_MS adds 5s to the interval, so after the
    // slow_down response the next sleep is ~5s. Allow 10s for the
    // test to absorb that bump.
    const { fetch, calls } = makeMockFetch([
      discoveryResponse(),
      initiateResponse(),
      errorResponse("slow_down"),
      tokenResponse(),
    ]);
    const handle = await startDeviceFlow({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      scopes: ["core.note:read"],
      storage: new InMemoryTokenStorage(),
      fetch,
    });
    await handle.pollForToken();
    // Four calls: discovery + initiate + 2 token-endpoint hits.
    expect(calls).toHaveLength(4);
  }, 10_000);

  it("throws OAuthError(access_denied) when user denies", async () => {
    const { fetch } = makeMockFetch([
      discoveryResponse(),
      initiateResponse(),
      errorResponse("access_denied"),
    ]);
    const handle = await startDeviceFlow({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      scopes: ["core.note:read"],
      storage: new InMemoryTokenStorage(),
      fetch,
    });
    let caught: unknown;
    try {
      await handle.pollForToken();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OAuthError);
    expect(caught).toMatchObject({ code: "access_denied" });
  });

  it("throws OAuthError(expired_token) on terminal expired_token error", async () => {
    const { fetch } = makeMockFetch([
      discoveryResponse(),
      initiateResponse(),
      errorResponse("expired_token"),
    ]);
    const handle = await startDeviceFlow({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      scopes: ["core.note:read"],
      storage: new InMemoryTokenStorage(),
      fetch,
    });
    await expect(handle.pollForToken()).rejects.toMatchObject({
      code: "expired_token",
    });
  });

  it("respects an AbortSignal", async () => {
    const { fetch } = makeMockFetch([
      discoveryResponse(),
      initiateResponse(),
      errorResponse("authorization_pending"),
    ]);
    const controller = new AbortController();
    const handle = await startDeviceFlow({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      scopes: ["core.note:read"],
      storage: new InMemoryTokenStorage(),
      fetch,
    });
    setTimeout(() => {
      controller.abort();
    }, 5);
    await expect(
      handle.pollForToken({ signal: controller.signal }),
    ).rejects.toThrow();
  });
});
