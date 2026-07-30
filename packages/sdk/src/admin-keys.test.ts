import { describe, it, expect, vi } from "vitest";
import { MarfaClient } from "./client.js";

// ---------------------------------------------------------------------------
// `client.admin.keys` SDK namespace coverage. Mock fetch rather than an
// in-process server: the route's behavior is covered end-to-end in
// `packages/server/src/routes/admin.test.ts`, so what needs pinning here is
// the wiring — method, path, space-id encoding, and body pass-through.
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

describe("client.admin.keys.create", () => {
  it("POSTs to the space-scoped mint route and returns the raw key", async () => {
    const mockFetch = vi.fn(
      (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        expect(urlOf(url)).toBe(
          "http://example.test/admin/spaces/ten_abc/keys",
        );
        expect(init?.method).toBe("POST");
        expect(JSON.parse(init?.body as string)).toEqual({
          label: "support-readonly",
          source: "support-readonly",
          type_permissions: { "core.note": "read" },
        });
        return Promise.resolve(
          makeJsonResponse(201, {
            id: "api_key_1",
            key: "marfa_k1_minted",
            label: "support-readonly",
            source: "support-readonly",
            role: "member",
            default_tier: "library",
            is_platform: false,
            type_permissions: { "core.note": "read" },
            created_at: "2026-01-01T00:00:00.000Z",
            last_used_at: null,
          }),
        );
      },
    );

    const client = makeClient(mockFetch);
    const minted = await client.admin.keys.create("ten_abc", {
      label: "support-readonly",
      source: "support-readonly",
      type_permissions: { "core.note": "read" },
    });

    expect(minted.key).toBe("marfa_k1_minted");
    expect(minted.role).toBe("member");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("percent-encodes the space id into the path", async () => {
    const mockFetch = vi.fn(
      (url: string | URL | Request): Promise<Response> => {
        expect(urlOf(url)).toBe(
          "http://example.test/admin/spaces/ten%2Fslash/keys",
        );
        return Promise.resolve(
          makeJsonResponse(201, {
            id: "api_key_2",
            key: "marfa_k1_minted",
            label: "l",
            source: "s",
            role: "member",
            default_tier: "library",
            is_platform: false,
            type_permissions: {},
            created_at: "2026-01-01T00:00:00.000Z",
            last_used_at: null,
          }),
        );
      },
    );

    const client = makeClient(mockFetch);
    await client.admin.keys.create("ten/slash", { label: "l", source: "s" });
  });
});

describe("client.admin.spaces.create", () => {
  it("POSTs the name and returns the created space", async () => {
    const mockFetch = vi.fn(
      (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        expect(urlOf(url)).toBe("http://example.test/admin/spaces");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(init?.body as string)).toEqual({ name: "acme" });
        return Promise.resolve(
          makeJsonResponse(201, {
            id: "ten_new",
            name: "acme",
            created_at: "2026-07-30T00:00:00.000Z",
            status: "active",
          }),
        );
      },
    );
    const space = await makeClient(mockFetch).admin.spaces.create({
      name: "acme",
    });
    expect(space.id).toBe("ten_new");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("sends an empty body when no name is given", async () => {
    // Not `undefined`: the route validates a JSON body, so omitting one
    // entirely would be a 400 rather than an unnamed space.
    const mockFetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        expect(JSON.parse(init?.body as string)).toEqual({});
        return Promise.resolve(
          makeJsonResponse(201, {
            id: "ten_unnamed",
            name: null,
            created_at: "2026-07-30T00:00:00.000Z",
            status: "active",
          }),
        );
      },
    );
    const space = await makeClient(mockFetch).admin.spaces.create();
    expect(space.name).toBeNull();
  });
});
