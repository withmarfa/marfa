import { describe, expect, it, vi } from "vitest";
import { HttpTransport } from "./transport.js";
import { MymeError } from "./errors.js";

// ---------------------------------------------------------------------------
// Adversarial coverage for HttpTransport — transport-layer edge cases that
// happy-path tests in client.test.ts do not exercise. Every case injects a
// mock fetch via TransportConfig.fetch; no server is booted.
//
// These tests document the SDK's *current* behaviour. Three gaps are flagged
// in the PR body (timeout/network/parse errors escape as raw DOMException /
// TypeError / SyntaxError rather than being wrapped as MymeError). Locking
// that in here ensures any future wrapping change is a deliberate choice.
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
        err instanceof DOMException && err.name === "AbortError",
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(150);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("HttpTransport — network errors", () => {
  it("propagates the original TypeError when fetch rejects", async () => {
    const networkError = new TypeError("fetch failed");
    const mockFetch = vi.fn().mockRejectedValue(networkError);
    const transport = makeTransport(
      mockFetch as unknown as typeof globalThis.fetch,
    );

    await expect(transport.request("GET", "/items")).rejects.toBe(networkError);
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

describe("HttpTransport — body-parse failures (current behaviour, flagged)", () => {
  it("surfaces a SyntaxError when an error response body is not valid JSON", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("<html>internal error</html>", {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    const transport = makeTransport(
      mockFetch as unknown as typeof globalThis.fetch,
    );

    await expect(transport.request("GET", "/items")).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });

  it("surfaces a SyntaxError when a 200 response body is not valid JSON", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("plain text", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    const transport = makeTransport(
      mockFetch as unknown as typeof globalThis.fetch,
    );

    await expect(transport.request("GET", "/items")).rejects.toBeInstanceOf(
      SyntaxError,
    );
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

    await expect(transport.request("GET", "/items")).rejects.toBeDefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
