/**
 * Lease route (T-260) — pins the runtime-credential mint shape, in
 * particular that the broker mints with **wildcard write on all three
 * permission axes** (`type_permissions`, `edge_permissions`,
 * `extension_permissions`). Pre-T-260 only `type_permissions` was set,
 * so the per-Connection runtime credential could write items but
 * silently failed every `createEdge` / extension-namespace write —
 * `edge_permissions` and `extension_permissions` both default to
 * `{}` and block the call. T-249's `google.youtube` was the first
 * integration manifest to declare `permissions.edge: { "parent-of":
 * "write" }` and surfaced the gap.
 *
 * The test patches `globalThis.fetch` to capture the body the broker
 * POSTs to Myme's `/system/runtime-credentials` endpoint, then asserts
 * all three permission maps are present and wildcard-write.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../app.js";
import type { ControlPlaneEnv } from "../env.js";

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function mockMymeFetch(captured: FetchCall[]): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = init?.method ?? "GET";
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    captured.push({ url, method, body });
    if (url.endsWith("/system/runtime-credentials") && method === "POST") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            api_key: "myme_k1_runtime_test",
            connection_id: "conn_x",
            expires_at: new Date(Date.now() + 600_000).toISOString(),
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("nope", { status: 404 }));
  }) as typeof fetch;
}

function buildTestEnv(): ControlPlaneEnv {
  return {
    MYME_API_URL: "https://staging.test",
    MYME_RUNTIME_BROKER_KEY: "broker-key-test",
  } as unknown as ControlPlaneEnv;
}

describe("POST /lease/:connection_id/runtime (T-260)", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("mints with wildcard write on type_permissions, edge_permissions, AND extension_permissions", async () => {
    const captured: FetchCall[] = [];
    globalThis.fetch = mockMymeFetch(captured);
    const app = buildApp();
    const env = buildTestEnv();

    const res = await app.request(
      "/lease/conn_x/runtime",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "test", ttl_seconds: 600 }),
      },
      env,
    );
    expect(res.status).toBe(200);

    const mintCall = captured.find(
      (c) =>
        c.url.endsWith("/system/runtime-credentials") && c.method === "POST",
    );
    expect(mintCall).toBeDefined();
    const body = mintCall!.body as {
      type_permissions: Record<string, string>;
      edge_permissions: Record<string, string>;
      extension_permissions: Record<string, string>;
    };
    expect(body.type_permissions).toEqual({ "*": "write" });
    expect(body.edge_permissions).toEqual({ "*": "write" });
    expect(body.extension_permissions).toEqual({ "*": "write" });
  });

  it("returns 503 when MYME_API_URL is unset", async () => {
    const app = buildApp();
    const env = {
      MYME_RUNTIME_BROKER_KEY: "broker-key-test",
    } as unknown as ControlPlaneEnv;
    const res = await app.request(
      "/lease/conn_x/runtime",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      env,
    );
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("control_plane_misconfigured");
  });
});
