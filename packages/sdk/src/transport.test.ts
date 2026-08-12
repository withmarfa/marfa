import { describe, expect, it, vi } from "vitest";
import { HttpTransport } from "./transport.js";
import {
  ForbiddenError,
  MarfaError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "./errors.js";
import { StoredTokenProvider } from "./auth/token-provider.js";
import { InMemoryTokenStorage } from "./auth/storage.js";
import { OAuthError } from "./auth/errors.js";

// ---------------------------------------------------------------------------
// Adversarial coverage for HttpTransport — transport-layer edge cases that
// happy-path tests in client.test.ts do not exercise. Every case injects a
// mock fetch via TransportConfig.fetch; no server is booted.
//
// These tests pin the SDK's wrapped-error contract: timeouts, network
// failures, and body-parse failures all surface as `MarfaError` with a
// stable `code`, `status: 0`, and the original platform error preserved
// on `err.cause`. Server-reported errors (4xx/5xx with a JSON body) map
// to `MarfaError` with the real HTTP status and the server's `error.code`.
// ---------------------------------------------------------------------------

function makeJsonResponse(
  status: number,
  body: unknown,
  init?: ResponseInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function makeTransport(fetchImpl: typeof globalThis.fetch, timeoutMs?: number) {
  return new HttpTransport({
    baseUrl: "http://example.test",
    apiKey: "test-key",
    fetch: fetchImpl,
    timeoutMs,
  });
}

describe("HttpTransport — timeout wiring", () => {
  it("aborts the request when timeoutMs elapses before the response resolves", async () => {
    const mockFetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new DOMException("Aborted before dispatch", "AbortError"));
            return;
          }
          const timer = setTimeout(() => {
            resolve(makeJsonResponse(200, { ok: true }));
          }, 200);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        }),
    );

    const transport = makeTransport(mockFetch, 50);

    // No wall-clock bound: the rejection shape is itself the proof that
    // the timeout beat the response, because the mock resolves with a
    // 200 unless the abort lands first. Asserting elapsed time on top
    // measured the machine's scheduling margin, not the transport, and
    // failed under load by a millisecond.
    await expect(transport.request("GET", "/items")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof MarfaError &&
        err.code === "timeout" &&
        err.status === 0 &&
        err.cause instanceof DOMException &&
        err.cause.name === "AbortError",
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("HttpTransport — network errors", () => {
  it("wraps a rejected fetch in MarfaError with code='network_error' and preserves the original on err.cause", async () => {
    const networkError = new TypeError("fetch failed");
    const mockFetch = vi.fn().mockRejectedValue(networkError);
    const transport = makeTransport(mockFetch);

    await expect(transport.request("GET", "/items")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof MarfaError &&
        err.code === "network_error" &&
        err.status === 0 &&
        err.cause === networkError,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("HttpTransport — error-body mapping", () => {
  it("maps 5xx responses to MarfaError with status, code, and message preserved", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse(503, {
        error: { code: "service_unavailable", message: "down" },
      }),
    );
    const transport = makeTransport(mockFetch);

    await expect(transport.request("GET", "/items")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof MarfaError &&
        err.status === 503 &&
        err.code === "service_unavailable" &&
        err.message === "down",
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to code='unknown' and message='HTTP <status>' when the error body omits both fields", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeJsonResponse(500, {}));
    const transport = makeTransport(mockFetch);

    await expect(transport.request("GET", "/items")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof MarfaError &&
        err.status === 500 &&
        err.code === "unknown" &&
        err.message === "HTTP 500",
    );
  });
});

describe("HttpTransport — typed error subclasses preserve server code", () => {
  // 4xx responses surface as the right `instanceof` class (so `catch (e as
  // NotFoundError)` still works) AND carry the server's real `code` so
  // callers can branch on specific codes like `bulk_cap_exceeded`,
  // `edge_not_found`, `reset_disabled` instead of regexing on message.

  it("400 with a specific server code throws ValidationError with that code, not the generic 'validation_error'", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse(400, {
        error: {
          code: "bulk_cap_exceeded",
          message: "Matched 12000 items; cap is 10000.",
          details: { matched: 12000, cap: 10000 },
        },
      }),
    );
    const transport = makeTransport(mockFetch);

    await expect(
      transport.request("POST", "/items/bulk-actions"),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ValidationError &&
        err.code === "bulk_cap_exceeded" &&
        err.status === 400 &&
        err.message === "Matched 12000 items; cap is 10000." &&
        err.details?.matched === 12000 &&
        err.details.cap === 10000,
    );
  });

  it("400 without a server code falls back to the canonical 'validation_error'", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeJsonResponse(400, { error: { message: "bad" } }));
    const transport = makeTransport(mockFetch);

    await expect(transport.request("GET", "/items")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ValidationError &&
        err.code === "validation_error" &&
        err.status === 400 &&
        err.message === "bad",
    );
  });

  it("404 with a specific server code throws NotFoundError with that code", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse(404, {
        error: { code: "edge_not_found", message: "Edge edg_123 not found" },
      }),
    );
    const transport = makeTransport(mockFetch);

    await expect(
      transport.request("DELETE", "/edges/edg_123"),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof NotFoundError &&
        err.code === "edge_not_found" &&
        err.status === 404,
    );
  });

  it("404 without a server code falls back to the canonical 'not_found'", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeJsonResponse(404, { error: { message: "gone" } }));
    const transport = makeTransport(mockFetch);

    await expect(transport.request("GET", "/items/x")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof NotFoundError &&
        err.code === "not_found" &&
        err.status === 404,
    );
  });

  it("403 with a specific server code throws ForbiddenError with that code", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse(403, {
        error: {
          code: "edge_permission_denied",
          message: "No write on edge type about",
        },
      }),
    );
    const transport = makeTransport(mockFetch);

    await expect(transport.request("POST", "/edges")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ForbiddenError &&
        err.code === "edge_permission_denied" &&
        err.status === 403,
    );
  });

  it("401 with a specific server code throws UnauthorizedError with that code", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse(401, {
        error: { code: "token_expired", message: "Access token expired" },
      }),
    );
    const transport = makeTransport(mockFetch);

    await expect(transport.request("GET", "/items")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof UnauthorizedError &&
        err.code === "token_expired" &&
        err.status === 401,
    );
  });
});

describe("HttpTransport — body-parse failures", () => {
  it("wraps a malformed JSON error body in MarfaError with code='parse_error' and records the real HTTP status in details", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("<html>internal error</html>", {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    const transport = makeTransport(mockFetch);

    await expect(transport.request("GET", "/items")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof MarfaError &&
        err.code === "parse_error" &&
        err.status === 0 &&
        err.cause instanceof SyntaxError &&
        err.details?.httpStatus === 500,
    );
  });

  it("wraps a non-JSON 200 body in MarfaError with code='parse_error' and records the real HTTP status in details", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("plain text", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    const transport = makeTransport(mockFetch);

    await expect(transport.request("GET", "/items")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof MarfaError &&
        err.code === "parse_error" &&
        err.status === 0 &&
        err.cause instanceof SyntaxError &&
        err.details?.httpStatus === 200,
    );
  });
});

describe("HttpTransport — requestWithStatus", () => {
  // The status-passing sibling of `request<T>` exists so callers (today
  // just `client.items.upsert`) can branch on 200 vs 201 without
  // re-implementing fetch handling. Pin the contract here: success body
  // is parsed identically, the response status is surfaced, and the
  // error paths fall through to the same typed-error mapping as
  // `request<T>`.

  it("surfaces status 200 alongside the parsed body", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeJsonResponse(200, { item: { id: "itm_1" } }));
    const transport = makeTransport(mockFetch);

    const result = await transport.requestWithStatus<{ item: { id: string } }>(
      "POST",
      "/items",
    );
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ item: { id: "itm_1" } });
  });

  it("surfaces status 201 alongside the parsed body — distinguishes natural-key create from update", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeJsonResponse(201, { item: { id: "itm_2" } }));
    const transport = makeTransport(mockFetch);

    const result = await transport.requestWithStatus<{ item: { id: string } }>(
      "POST",
      "/items",
    );
    expect(result.status).toBe(201);
    expect(result.data).toEqual({ item: { id: "itm_2" } });
  });

  it("returns { data: undefined, status: 204 } on No Content responses (matches request<T> behavior)", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const transport = makeTransport(mockFetch);

    const result = await transport.requestWithStatus<undefined>(
      "DELETE",
      "/items/x",
    );
    expect(result.status).toBe(204);
    expect(result.data).toBeUndefined();
  });

  it("4xx responses throw the typed MarfaError subclass — never resolve", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse(404, {
        error: { code: "not_found", message: "x" },
      }),
    );
    const transport = makeTransport(mockFetch);

    await expect(
      transport.requestWithStatus<unknown>("GET", "/items/x"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("request<T> delegates to requestWithStatus<T> — returning the body unchanged", async () => {
    // Belt-and-braces: the refactor moved request<T>'s body onto
    // requestWithStatus<T>. Confirm the public request<T> contract is
    // unchanged — same body shape, same error mapping.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(makeJsonResponse(200, { hello: "world" }));
    const transport = makeTransport(mockFetch);

    const body = await transport.request<{ hello: string }>("GET", "/x");
    expect(body).toEqual({ hello: "world" });
  });
});

describe("HttpTransport — no silent retry", () => {
  it("calls fetch exactly once on a 500 response", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        makeJsonResponse(500, { error: { code: "boom", message: "x" } }),
      );
    const transport = makeTransport(mockFetch);

    await expect(transport.request("GET", "/items")).rejects.toBeInstanceOf(
      MarfaError,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("calls fetch exactly once when the request times out", async () => {
    const mockFetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const transport = makeTransport(mockFetch, 20);

    await expect(transport.request("GET", "/items")).rejects.toBeInstanceOf(
      MarfaError,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 401 on the static API key path", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse(401, {
        error: { code: "invalid_token", message: "nope" },
      }),
    );
    const transport = makeTransport(mockFetch);

    // An API key has nothing to renew, so a retry would just resend the
    // rejected credential.
    await expect(transport.request("GET", "/items")).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Refresh on 401 — exercised through the real StoredTokenProvider.
//
// A stub provider that mints a new token on every call would make a broken
// transport look correct: the retry picks up a fresh credential whether or not
// anything forced a renewal. Everything below drives the shipping provider
// against a mock OAuth token endpoint, seeded with an access token whose clock
// expiry is an hour out, so the proactive-refresh window never fires and
// reacting to the 401 is the only route to recovery.
// ---------------------------------------------------------------------------

const ISSUER = "http://auth.test";
const TOKEN_ENDPOINT = `${ISSUER}/auth/oauth2/token`;
const AUTH_ENDPOINTS = {
  token: TOKEN_ENDPOINT,
  authorize: `${ISSUER}/auth/oauth2/authorize`,
  deviceAuthorize: `${ISSUER}/auth/device`,
  as: { issuer: ISSUER, token_endpoint: TOKEN_ENDPOINT },
};
const STORAGE_KEY = "marfa.auth.tokens:transport-test";
const SEEDED_ACCESS_TOKEN = "seeded_at";
const SEEDED_REFRESH_TOKEN = "seeded_rt";

function tokenEndpointSuccess(access: string, refresh: string): Response {
  return makeJsonResponse(200, {
    access_token: access,
    // RFC 6749 requires it and the library enforces it; the real server
    // sends "Bearer", so the double does too.
    token_type: "Bearer",
    refresh_token: refresh,
    expires_in: 3600,
    scope: "core.note:read",
  });
}

function tokenEndpointFailure(error: string, status: number): Response {
  return makeJsonResponse(status, { error });
}

function sentBearer(init?: RequestInit): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.Authorization;
}

interface AuthFixture {
  transport: HttpTransport;
  storage: InMemoryTokenStorage;
  /** Bearer header seen on each API call, in order. */
  apiCalls: (string | undefined)[];
  /** Refresh token presented on each token-endpoint exchange, in order. */
  tokenExchanges: string[];
  signOuts: number[];
}

async function makeAuthFixture(options: {
  /** Whether the API accepts a given access token; anything else gets 401. */
  accepts: (accessToken: string) => boolean;
  /** Token-endpoint response for each exchange. */
  tokenResponse: () => Response;
}): Promise<AuthFixture> {
  const apiCalls: (string | undefined)[] = [];
  const tokenExchanges: string[] = [];
  const signOuts: number[] = [];
  const storage = new InMemoryTokenStorage();

  const fetchImpl: typeof globalThis.fetch = (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    if (url === TOKEN_ENDPOINT) {
      // `fetch` accepts either a pre-encoded string or URLSearchParams,
      // and the caller's choice is not the transport's business — so the
      // double reads both rather than assuming one.
      const raw = init?.body;
      const form =
        raw instanceof URLSearchParams
          ? raw
          : new URLSearchParams(typeof raw === "string" ? raw : "");
      tokenExchanges.push(form.get("refresh_token") ?? "");
      return Promise.resolve(options.tokenResponse());
    }

    const header = sentBearer(init);
    apiCalls.push(header);
    const token = header?.replace(/^Bearer /, "") ?? "";
    return Promise.resolve(
      options.accepts(token)
        ? makeJsonResponse(200, { ok: true })
        : makeJsonResponse(401, {
            error: { code: "invalid_token", message: "token revoked" },
          }),
    );
  };

  await storage.set(
    STORAGE_KEY,
    JSON.stringify({
      access_token: SEEDED_ACCESS_TOKEN,
      refresh_token: SEEDED_REFRESH_TOKEN,
      access_expires_at: Date.now() + 3_600_000,
      scope: "core.note:read",
    }),
  );

  const provider = new StoredTokenProvider({
    issuer: ISSUER,
    clientId: "test-client",
    storage,
    storageKey: STORAGE_KEY,
    fetch: fetchImpl,
    endpoints: AUTH_ENDPOINTS,
  });
  provider.onSignOut(() => signOuts.push(1));

  const transport = new HttpTransport({
    baseUrl: "http://example.test",
    tokenProvider: provider,
    fetch: fetchImpl,
  });

  return { transport, storage, apiCalls, tokenExchanges, signOuts };
}

describe("HttpTransport — refresh on 401", () => {
  it("recovers a clock-valid but server-revoked token with one refresh and one retry", async () => {
    const fixture = await makeAuthFixture({
      accepts: (token) => token === "fresh_at",
      tokenResponse: () => tokenEndpointSuccess("fresh_at", "rotated_rt"),
    });

    await expect(
      fixture.transport.request("GET", "/items"),
    ).resolves.toStrictEqual({ ok: true });

    expect(fixture.apiCalls).toStrictEqual([
      `Bearer ${SEEDED_ACCESS_TOKEN}`,
      "Bearer fresh_at",
    ]);
    expect(fixture.tokenExchanges).toStrictEqual([SEEDED_REFRESH_TOKEN]);
    // The grant was alive the whole time; nothing justified ending the session.
    expect(fixture.signOuts).toHaveLength(0);
  });

  it("persists the rotated tokens so the next request starts from the new pair", async () => {
    const fixture = await makeAuthFixture({
      accepts: (token) => token === "fresh_at",
      tokenResponse: () => tokenEndpointSuccess("fresh_at", "rotated_rt"),
    });

    await fixture.transport.request("GET", "/items");
    await fixture.transport.request("GET", "/items");

    expect(fixture.apiCalls).toStrictEqual([
      `Bearer ${SEEDED_ACCESS_TOKEN}`,
      "Bearer fresh_at",
      "Bearer fresh_at",
    ]);
    expect(fixture.tokenExchanges).toStrictEqual([SEEDED_REFRESH_TOKEN]);
  });

  it("collapses concurrent 401s onto a single token exchange", async () => {
    const fixture = await makeAuthFixture({
      accepts: (token) => token === "fresh_at",
      tokenResponse: () => tokenEndpointSuccess("fresh_at", "rotated_rt"),
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        fixture.transport.request("GET", "/items"),
      ),
    );

    expect(results).toHaveLength(8);
    // Eight attempts, eight retries — but one exchange. Refresh tokens rotate,
    // so eight exchanges would replay a spent token and read as reuse, which
    // revokes the whole grant.
    expect(fixture.apiCalls).toHaveLength(16);
    expect(fixture.tokenExchanges).toStrictEqual([SEEDED_REFRESH_TOKEN]);
  });

  it("fails fast on a dead refresh token — one exchange, then no traffic at all", async () => {
    const fixture = await makeAuthFixture({
      accepts: () => false,
      tokenResponse: () => tokenEndpointFailure("invalid_grant", 400),
    });

    await expect(
      fixture.transport.request("GET", "/items"),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    for (let i = 0; i < 4; i++) {
      // The provider has latched: it refuses to hand out a bearer at all, so
      // these never reach the network.
      await expect(
        fixture.transport.request("GET", "/items"),
      ).rejects.toBeInstanceOf(OAuthError);
    }

    expect(fixture.apiCalls).toHaveLength(1);
    expect(fixture.tokenExchanges).toStrictEqual([SEEDED_REFRESH_TOKEN]);
    expect(fixture.signOuts).toHaveLength(1);
    expect(await fixture.storage.get(STORAGE_KEY)).toBeNull();
  });

  it("stops forcing exchanges once a refresh has failed to clear the 401", async () => {
    let issued = 0;
    const fixture = await makeAuthFixture({
      accepts: () => false,
      tokenResponse: () => {
        issued += 1;
        return tokenEndpointSuccess(`rotated_at_${String(issued)}`, "next_rt");
      },
    });

    for (let i = 0; i < 3; i++) {
      await expect(
        fixture.transport.request("GET", "/items"),
      ).rejects.toBeInstanceOf(UnauthorizedError);
    }

    // First call: attempt, exchange, retry. The retry's 401 proves a stale
    // credential is not what the server is objecting to, so the two later
    // calls make one attempt each and no exchange. A 401 loop must not become
    // a token-endpoint loop.
    expect(fixture.apiCalls).toHaveLength(4);
    expect(fixture.tokenExchanges).toHaveLength(1);
    // Nothing here says the grant is gone, so the session survives.
    expect(fixture.signOuts).toHaveLength(0);
  });

  it("resumes refreshing on 401 once a request has succeeded again", async () => {
    let accepted = "nothing-yet";
    let issued = 0;
    const fixture = await makeAuthFixture({
      accepts: (token) => token === accepted,
      tokenResponse: () => {
        issued += 1;
        return tokenEndpointSuccess(`rotated_at_${String(issued)}`, "next_rt");
      },
    });

    await expect(
      fixture.transport.request("GET", "/items"),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(fixture.tokenExchanges).toHaveLength(1);

    // A healthy response is the signal that the credential works again.
    accepted = "rotated_at_1";
    await expect(
      fixture.transport.request("GET", "/items"),
    ).resolves.toStrictEqual({ ok: true });

    // So a later revocation is recoverable rather than suppressed forever.
    accepted = "rotated_at_2";
    await expect(
      fixture.transport.request("GET", "/items"),
    ).resolves.toStrictEqual({ ok: true });
    expect(fixture.tokenExchanges).toHaveLength(2);
  });
});
