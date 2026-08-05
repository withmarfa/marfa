import { beforeEach, describe, expect, it } from "vitest";
import { StoredTokenProvider } from "./token-provider.js";
import { InMemoryTokenStorage } from "./storage.js";
import { __resetDiscoveryCache } from "./discovery.js";
import { OAuthError } from "./errors.js";

/**
 * Unit tests for StoredTokenProvider. Drives a mocked fetch that returns
 * a discovery doc + token responses; asserts refresh hits the discovered
 * endpoint, not the legacy `/auth/token`.
 */

interface FetchCall {
  url: string;
  init?: RequestInit;
}

const ISSUER = "http://example.test:8602";
const CLIENT_ID = "test-client";
const STORAGE_KEY = `marfa.auth.tokens:${ISSUER}:${CLIENT_ID}`;
const TOKEN_ENDPOINT = `${ISSUER}/auth/oauth2/token`;
const AUTHORIZE_ENDPOINT = `${ISSUER}/auth/oauth2/authorize`;
const DEVICE_ENDPOINT = `${ISSUER}/auth/device`;

function discoveryResponse(): Response {
  return new Response(
    JSON.stringify({
      issuer: `${ISSUER}/auth`,
      token_endpoint: TOKEN_ENDPOINT,
      authorization_endpoint: AUTHORIZE_ENDPOINT,
      device_authorization_endpoint: DEVICE_ENDPOINT,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function refreshOkResponse(): Response {
  return new Response(
    JSON.stringify({
      access_token: "fresh_at",
      // RFC 6749 requires it and the library enforces it; the real
      // server sends "Bearer", so the double does too.
      token_type: "Bearer",
      refresh_token: "fresh_rt",
      expires_in: 3600,
      scope: "core.note:read",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function makeMockFetch(queue: Response[]): {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push({ url, init });
    const next = queue[i++];
    if (!next) return Promise.reject(new Error(`unexpected fetch to ${url}`));
    return Promise.resolve(next);
  };
  return { fetch, calls };
}

async function seedExpiredCache(storage: InMemoryTokenStorage): Promise<void> {
  await storage.set(
    STORAGE_KEY,
    JSON.stringify({
      access_token: "expired_at",
      refresh_token: "valid_rt",
      access_expires_at: Date.now() - 60_000,
      scope: "core.note:read",
    }),
  );
}

describe("StoredTokenProvider.refresh", () => {
  beforeEach(() => {
    __resetDiscoveryCache();
  });

  it("discovers endpoints and posts refresh to the discovered token endpoint", async () => {
    const storage = new InMemoryTokenStorage();
    await seedExpiredCache(storage);
    const { fetch, calls } = makeMockFetch([
      discoveryResponse(),
      refreshOkResponse(),
    ]);
    const provider = new StoredTokenProvider({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      storage,
      storageKey: STORAGE_KEY,
      fetch,
    });
    const token = await provider.getAccessToken();
    expect(token).toBe("fresh_at");
    expect(calls[0]?.url).toBe(
      `${ISSUER}/.well-known/oauth-authorization-server/auth`,
    );
    expect(calls[1]?.url).toBe(TOKEN_ENDPOINT);
  });

  it("caches discovery — second refresh skips the well-known fetch", async () => {
    const storage = new InMemoryTokenStorage();
    await seedExpiredCache(storage);
    const { fetch, calls } = makeMockFetch([
      discoveryResponse(),
      refreshOkResponse(),
      refreshOkResponse(),
    ]);
    const provider = new StoredTokenProvider({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      storage,
      storageKey: STORAGE_KEY,
      fetch,
    });
    await provider.hydrateFromStorage();
    await provider.refresh();
    await provider.refresh();
    const discoveryFetches = calls.filter((c) =>
      c.url.includes("/.well-known/oauth-authorization-server"),
    );
    expect(discoveryFetches).toHaveLength(1);
  });

  it("uses pre-resolved endpoints if provided — no discovery fetch", async () => {
    const storage = new InMemoryTokenStorage();
    await seedExpiredCache(storage);
    const { fetch, calls } = makeMockFetch([refreshOkResponse()]);
    const provider = new StoredTokenProvider({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      storage,
      storageKey: STORAGE_KEY,
      fetch,
      endpoints: {
        token: TOKEN_ENDPOINT,
        authorize: AUTHORIZE_ENDPOINT,
        deviceAuthorize: DEVICE_ENDPOINT,
        as: { issuer: ISSUER, token_endpoint: TOKEN_ENDPOINT },
      },
    });
    await provider.hydrateFromStorage();
    await provider.refresh();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(TOKEN_ENDPOINT);
  });

  it("throws OAuthError(invalid_grant) on a 4xx refresh response", async () => {
    const storage = new InMemoryTokenStorage();
    await seedExpiredCache(storage);
    const { fetch } = makeMockFetch([
      discoveryResponse(),
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    ]);
    const provider = new StoredTokenProvider({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      storage,
      storageKey: STORAGE_KEY,
      fetch,
    });
    await expect(provider.refresh()).rejects.toThrow(OAuthError);
  });
});

describe("StoredTokenProvider.refresh failure taxonomy", () => {
  beforeEach(() => {
    __resetDiscoveryCache();
  });

  const endpoints = {
    token: TOKEN_ENDPOINT,
    authorize: AUTHORIZE_ENDPOINT,
    deviceAuthorize: DEVICE_ENDPOINT,
    as: { issuer: ISSUER, token_endpoint: TOKEN_ENDPOINT },
  };

  function rateLimited(): Response {
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "0" },
    });
  }

  function oauthFailure(code: string): Response {
    return new Response(JSON.stringify({ error: code }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  async function makeProvider(
    storage: InMemoryTokenStorage,
    fetch: typeof globalThis.fetch,
  ): Promise<{ provider: StoredTokenProvider; signedOut: () => boolean }> {
    let flag = false;
    const provider = new StoredTokenProvider({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      storage,
      storageKey: STORAGE_KEY,
      fetch,
      endpoints,
    });
    provider.onSignOut(() => {
      flag = true;
    });
    await provider.hydrateFromStorage();
    return { provider, signedOut: () => flag };
  }

  it("retries a 429 and keeps the session", async () => {
    const storage = new InMemoryTokenStorage();
    await seedExpiredCache(storage);
    const { fetch, calls } = makeMockFetch([
      rateLimited(),
      refreshOkResponse(),
    ]);
    const { provider, signedOut } = await makeProvider(storage, fetch);

    expect(await provider.refresh()).toBe("fresh_at");
    expect(calls).toHaveLength(2);
    // A rate limit means the server never reached the grant, so the
    // credentials are still good and the user must stay signed in.
    expect(signedOut()).toBe(false);
    expect(await storage.get(STORAGE_KEY)).not.toBeNull();
  });

  it("does not sign out when 429 retries are exhausted", async () => {
    const storage = new InMemoryTokenStorage();
    await seedExpiredCache(storage);
    const { fetch, calls } = makeMockFetch([
      rateLimited(),
      rateLimited(),
      rateLimited(),
      rateLimited(),
    ]);
    const { provider, signedOut } = await makeProvider(storage, fetch);

    await expect(provider.refresh()).rejects.toThrow(OAuthError);
    // Bounded by the attempt budget rather than looping.
    expect(calls).toHaveLength(3);
    expect(signedOut()).toBe(false);
    expect(await storage.get(STORAGE_KEY)).not.toBeNull();
  });

  it("signs out on token_reuse_detected", async () => {
    const storage = new InMemoryTokenStorage();
    await seedExpiredCache(storage);
    const { fetch, calls } = makeMockFetch([
      oauthFailure("token_reuse_detected"),
    ]);
    const { provider, signedOut } = await makeProvider(storage, fetch);

    await expect(provider.refresh()).rejects.toThrow(OAuthError);
    // Rotation replay invalidates the whole pair, so retrying is pointless.
    expect(calls).toHaveLength(1);
    expect(signedOut()).toBe(true);
    expect(await storage.get(STORAGE_KEY)).toBeNull();
  });

  it("signs out on invalid_grant", async () => {
    const storage = new InMemoryTokenStorage();
    await seedExpiredCache(storage);
    const { fetch } = makeMockFetch([oauthFailure("invalid_grant")]);
    const { provider, signedOut } = await makeProvider(storage, fetch);

    await expect(provider.refresh()).rejects.toThrow(OAuthError);
    expect(signedOut()).toBe(true);
    expect(await storage.get(STORAGE_KEY)).toBeNull();
  });
});
