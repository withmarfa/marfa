import { describe, expect, it, vi } from "vitest";
import { HttpTransport } from "./transport.js";
import {
  ForbiddenError,
  MymeError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Adversarial coverage for HttpTransport — transport-layer edge cases that
// happy-path tests in client.test.ts do not exercise. Every case injects a
// mock fetch via TransportConfig.fetch; no server is booted.
//
// These tests pin the SDK's wrapped-error contract: timeouts, network
// failures, and body-parse failures all surface as `MymeError` with a
// stable `code`, `status: 0`, and the original platform error preserved
// on `err.cause`. Server-reported errors (4xx/5xx with a JSON body) map
// to `MymeError` with the real HTTP status and the server's `error.code`.
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

    const transport = makeTransport(
      mockFetch as unknown as typeof globalThis.fetch,
      50,
    );

    const start = Date.now();
    await expect(transport.request("GET", "/items")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof MymeError &&
        err.code === "timeout" &&
        err.status === 0 &&
        err.cause instanceof DOMException &&
        err.cause.name === "AbortError",
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(150);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("HttpTransport — network errors", () => {
  it("wraps a rejected fetch in MymeError with code='network_error' and preserves the original on err.cause", async () => {
    const networkError = new TypeError("fetch failed");
    const mockFetch = vi.fn().mockRejectedValue(networkError);
    const transport = makeTransport(
      mockFetch as unknown as typeof globalThis.fetch,
    );

    await expect(transport.request("GET", "/items")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof MymeError &&
        err.code === "network_error" &&
        err.status === 0 &&
        err.cause === networkError,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("HttpTransport — error-body mapping", () => {
  it("maps 5xx responses to MymeError with status, code, and message preserved", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse(503, {
        error: { code: "service_unavailable", message: "down" },
      }),
    );
    const transport = makeTransport(
      mockFetch as unknown as typeof globalThis.fetch,
    );

    await expect(transport.request("GET", "/items")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof MymeError &&
        err.status === 503 &&
        err.code === "service_unavailable" &&
        err.message === "down",
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to code='unknown' and message='HTTP <status>' when the error body omits both fields", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeJsonResponse(500, {}));
    const transport = makeTransport(
      mockFetch as unknown as typeof globalThis.fetch,
    );

    await expect(transport.request("GET", "/items")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof MymeError &&
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
    const transport = makeTransport(
      mockFetch as unknown as typeof globalThis.fetch,
    );

    await expect(
      transport.request("POST", "/items/bulk_action"),
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
    const transport = makeTransport(
      mockFetch as unknown as typeof globalThis.fetch,
    );

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
    const transport = makeTransport(
      mockFetch as unknown as typeof globalThis.fetch,
    );

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
    const transport = makeTransport(
      mockFetch as unknown as typeof globalThis.fetch,
    );

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
    const transport = makeTransport(
      mockFetch as unknown as typeof globalThis.fetch,
    );

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
    const transport = makeTransport(
      mockFetch as unknown as typeof globalThis.fetch,
    );

    await expect(transport.request("GET", "/items")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof UnauthorizedError &&
        err.code === "token_expired" &&
        err.status === 401,
    );
  });
});

describe("HttpTransport — body-parse failures", () => {
  it("wraps a malformed JSON error body in MymeError with code='parse_error' and records the real HTTP status in details", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("<html>internal error</html>", {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    const transport = makeTransport(
      mockFetch as unknown as typeof globalThis.fetch,
    );

    await expect(transport.request("GET", "/items")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof MymeError &&
        err.code === "parse_error" &&
        err.status === 0 &&
        err.cause instanceof SyntaxError &&
        err.details?.httpStatus === 500,
    );
  });

  it("wraps a non-JSON 200 body in MymeError with code='parse_error' and records the real HTTP status in details", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("plain text", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    const transport = makeTransport(
      mockFetch as unknown as typeof globalThis.fetch,
    );

    await expect(transport.request("GET", "/items")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof MymeError &&
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
    const transport = makeTransport(
      mockFetch as unknown as typeof globalThis.fetch,
    );

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
    const transport = makeTransport(
      mockFetch as unknown as typeof globalThis.fetch,
    );

    const result = await transport.requestWithStatus<{ item: { id: string } }>(
      "POST",
      "/items",
    );
    expect(result.status).toBe(201);
    expect(result.data).toEqual({ item: { id: "itm_2" } });
  });

  it("returns { data: undefined, status: 204 } on No Content responses (matches request<T> behaviour)", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const transport = makeTransport(
      mockFetch as unknown as typeof globalThis.fetch,
    );

    const result = await transport.requestWithStatus<undefined>(
      "DELETE",
      "/items/x",
    );
    expect(result.status).toBe(204);
    expect(result.data).toBeUndefined();
  });

  it("4xx responses throw the typed MymeError subclass — never resolve", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse(404, {
        error: { code: "not_found", message: "x" },
      }),
    );
    const transport = makeTransport(
      mockFetch as unknown as typeof globalThis.fetch,
    );

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
    const transport = makeTransport(
      mockFetch as unknown as typeof globalThis.fetch,
    );

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
    const transport = makeTransport(
      mockFetch as unknown as typeof globalThis.fetch,
    );

    await expect(transport.request("GET", "/items")).rejects.toBeInstanceOf(
      MymeError,
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
    const transport = makeTransport(
      mockFetch as unknown as typeof globalThis.fetch,
      20,
    );

    await expect(transport.request("GET", "/items")).rejects.toBeInstanceOf(
      MymeError,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
