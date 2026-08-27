import { describe, it, expect, vi } from "vitest";
import { MarfaClient } from "./client.js";

// ---------------------------------------------------------------------------
// `client.admin.platformTypes` SDK namespace coverage. Mock fetch rather than
// an in-process server: the route's behavior is covered end-to-end in
// `packages/server/src/routes/admin-platform-types.test.ts`, so what needs
// pinning here is the wiring — method, path, identifier encoding, and the
// unwrap of the listing envelope.
// ---------------------------------------------------------------------------

function makeClient(fetchImpl: typeof globalThis.fetch): MarfaClient {
  return new MarfaClient({
    url: "http://example.test",
    apiKey: "marfa_k1_test",
    fetch: fetchImpl,
  });
}

function makeJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function urlOf(url: string | URL | Request): string {
  return typeof url === "string"
    ? url
    : url instanceof URL
      ? url.href
      : url.url;
}

describe("client.admin.platformTypes.drift", () => {
  it("GETs the admin drift route", async () => {
    const mockFetch = vi.fn(
      (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        expect(urlOf(url)).toBe(
          "http://example.test/admin/platform-types/drift",
        );
        expect(init?.method).toBe("GET");
        return Promise.resolve(makeJsonResponse(200, { types: [] }));
      },
    );

    await makeClient(mockFetch).admin.platformTypes.drift();
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("unwraps `types` and returns a bare array", async () => {
    const rows = [
      {
        id: "withmarfa.captured_email",
        item_count: 3,
        child_types: [],
        removable: false,
      },
      {
        id: "core.media",
        item_count: 0,
        child_types: ["core.media.photo", "core.media.video"],
        removable: false,
      },
    ];
    const mockFetch = vi.fn((): Promise<Response> =>
      Promise.resolve(makeJsonResponse(200, { types: rows })),
    );

    const drifted = await makeClient(mockFetch).admin.platformTypes.drift();

    expect(Array.isArray(drifted)).toBe(true);
    expect(drifted).toEqual(rows);
    expect(drifted[0]!.id).toBe("withmarfa.captured_email");
    expect(drifted[1]!.child_types).toEqual([
      "core.media.photo",
      "core.media.video",
    ]);
  });

  it("returns an empty array when nothing has drifted", async () => {
    const mockFetch = vi.fn((): Promise<Response> =>
      Promise.resolve(makeJsonResponse(200, { types: [] })),
    );

    await expect(
      makeClient(mockFetch).admin.platformTypes.drift(),
    ).resolves.toEqual([]);
  });
});

describe("client.admin.platformTypes.remove", () => {
  it("POSTs to the per-type remove route", async () => {
    const mockFetch = vi.fn(
      (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        expect(urlOf(url)).toBe(
          "http://example.test/admin/platform-types/withmarfa.captured_email/remove",
        );
        expect(init?.method).toBe("POST");
        return Promise.resolve(
          makeJsonResponse(200, {
            removed: true,
            id: "withmarfa.captured_email",
          }),
        );
      },
    );

    const result = await makeClient(mockFetch).admin.platformTypes.remove(
      "withmarfa.captured_email",
    );

    expect(result).toEqual({
      removed: true,
      id: "withmarfa.captured_email",
    });
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("percent-encodes the type identifier into the path", async () => {
    // A type id is caller-supplied and reaches the path segment directly,
    // so a slash would otherwise re-target the request at another route.
    const mockFetch = vi.fn(
      (url: string | URL | Request): Promise<Response> => {
        expect(urlOf(url)).toBe(
          "http://example.test/admin/platform-types/acme%2Fdeal%3Fx%3D1/remove",
        );
        return Promise.resolve(
          makeJsonResponse(200, { removed: true, id: "acme/deal?x=1" }),
        );
      },
    );

    await makeClient(mockFetch).admin.platformTypes.remove("acme/deal?x=1");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("surfaces the server's 409 as a thrown error carrying its details", async () => {
    const mockFetch = vi.fn((): Promise<Response> =>
      Promise.resolve(
        makeJsonResponse(409, {
          error: {
            code: "conflict",
            message:
              '3 item(s) still carry "withmarfa.captured_email". The row is what makes them resolve, so it stays registered until they move.',
            details: { type: "withmarfa.captured_email", item_count: 3 },
          },
        }),
      ),
    );

    await expect(
      makeClient(mockFetch).admin.platformTypes.remove(
        "withmarfa.captured_email",
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "conflict",
      details: { type: "withmarfa.captured_email", item_count: 3 },
    });
  });
});
