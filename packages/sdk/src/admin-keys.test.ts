import { describe, it, expect, vi } from "vitest";
import { MarfaClient } from "./client.js";

// ---------------------------------------------------------------------------
// `client.admin.keys` SDK namespace coverage. Mock fetch rather than an
// in-process server: the route's behavior is covered end-to-end in
// `packages/server/src/routes/admin.test.ts`, so what needs pinning here is
// the wiring — method, path, tenant-id encoding, and body pass-through.
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
  it("POSTs to the tenant-scoped mint route and returns the raw key", async () => {
    const mockFetch = vi.fn(
      (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        expect(urlOf(url)).toBe(
          "http://example.test/admin/tenants/ten_abc/keys",
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

  it("percent-encodes the tenant id into the path", async () => {
    const mockFetch = vi.fn(
      (url: string | URL | Request): Promise<Response> => {
        expect(urlOf(url)).toBe(
          "http://example.test/admin/tenants/ten%2Fslash/keys",
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
