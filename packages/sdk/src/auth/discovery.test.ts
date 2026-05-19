import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetDiscoveryCache,
  DiscoveryError,
  discoverEndpoints,
} from "./discovery.js";

/**
 * Unit tests for `discoverEndpoints`. All mocked-fetch — the server-side
 * suite at packages/server/src/routes/auth-better-auth.test.ts covers the
 * actual `.well-known` payload shape via the Better Auth plugin.
 */

interface FetchCall {
  url: string;
}

function makeMockFetch(
  responder: (url: string) => Response | Promise<Response>,
): {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push({ url });
    return responder(url);
  };
  return { fetch, calls };
}

function discoveryDoc(
  overrides: Partial<Record<string, unknown>> = {},
): Response {
  return new Response(
    JSON.stringify({
      issuer: "http://example.test:8602/auth",
      authorization_endpoint: "http://example.test:8602/auth/oauth2/authorize",
      token_endpoint: "http://example.test:8602/auth/oauth2/token",
      device_authorization_endpoint: "http://example.test:8602/auth/device",
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const ISSUER = "http://example.test:8602";

describe("discoverEndpoints", () => {
  beforeEach(() => {
    __resetDiscoveryCache();
  });

  it("fetches and parses the well-known doc", async () => {
    const { fetch, calls } = makeMockFetch(() => discoveryDoc());
    const endpoints = await discoverEndpoints(ISSUER, fetch);
    expect(endpoints.token).toBe("http://example.test:8602/auth/oauth2/token");
    expect(endpoints.authorize).toBe(
      "http://example.test:8602/auth/oauth2/authorize",
    );
    expect(endpoints.deviceAuthorize).toBe(
      "http://example.test:8602/auth/device",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "http://example.test:8602/.well-known/oauth-authorization-server",
    );
  });

  it("strips trailing slashes and lowercases host when caching", async () => {
    const { fetch, calls } = makeMockFetch(() => discoveryDoc());
    await discoverEndpoints("http://Example.Test:8602/", fetch);
    await discoverEndpoints("http://example.test:8602", fetch);
    expect(calls).toHaveLength(1);
  });

  it("de-duplicates concurrent first-calls (single-flight)", async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchPromise = new Promise<Response>((r) => {
      resolveFetch = r;
    });
    const { fetch, calls } = makeMockFetch(() => fetchPromise);

    const a = discoverEndpoints(ISSUER, fetch);
    const b = discoverEndpoints(ISSUER, fetch);
    expect(calls).toHaveLength(1);

    resolveFetch(discoveryDoc());
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
  });

  it("caches the resolved value across sequential calls", async () => {
    const { fetch, calls } = makeMockFetch(() => discoveryDoc());
    await discoverEndpoints(ISSUER, fetch);
    await discoverEndpoints(ISSUER, fetch);
    await discoverEndpoints(ISSUER, fetch);
    expect(calls).toHaveLength(1);
  });

  it("throws DiscoveryError on HTTP non-2xx", async () => {
    const { fetch } = makeMockFetch(
      () => new Response("not found", { status: 404 }),
    );
    await expect(discoverEndpoints(ISSUER, fetch)).rejects.toThrow(
      DiscoveryError,
    );
    await expect(discoverEndpoints(ISSUER, fetch)).rejects.toThrow(/HTTP 404/);
  });

  it("throws DiscoveryError when the response is not valid JSON", async () => {
    const { fetch } = makeMockFetch(
      () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(discoverEndpoints(ISSUER, fetch)).rejects.toThrow(
      DiscoveryError,
    );
    await expect(discoverEndpoints(ISSUER, fetch)).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("throws DiscoveryError when a required field is missing", async () => {
    const { fetch } = makeMockFetch(() =>
      discoveryDoc({ token_endpoint: undefined }),
    );
    await expect(discoverEndpoints(ISSUER, fetch)).rejects.toThrow(
      /missing required field "token_endpoint"/,
    );
  });

  it("throws DiscoveryError on network failure", async () => {
    const fetch: typeof globalThis.fetch = () =>
      Promise.reject(new TypeError("connect ECONNREFUSED"));
    await expect(discoverEndpoints(ISSUER, fetch)).rejects.toThrow(
      /network error/,
    );
  });

  it("evicts the cache on rejection so a later call retries", async () => {
    let firstCall = true;
    const { fetch, calls } = makeMockFetch(() => {
      if (firstCall) {
        firstCall = false;
        return new Response("nope", { status: 500 });
      }
      return discoveryDoc();
    });
    await expect(discoverEndpoints(ISSUER, fetch)).rejects.toThrow(
      DiscoveryError,
    );
    const ok = await discoverEndpoints(ISSUER, fetch);
    expect(ok.token).toBeTruthy();
    expect(calls).toHaveLength(2);
  });
});
