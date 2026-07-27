/**
 * Lease route — pins two things.
 *
 * First, the auth gate. The route mints a real tenant-scoped credential
 * and the Worker is routed to public hostnames, so it must refuse a
 * caller that does not present the broker key. A Connection ID is not a
 * secret, so without the gate anyone who has seen one can mint against
 * it.
 *
 * Second, the mint shape: the broker mints with **wildcard write on all
 * three permission axes** (`type_permissions`, `edge_permissions`,
 * `extension_permissions`). All three axes must be granted because
 * `edge_permissions` and `extension_permissions` both default to `{}`
 * and block the call — a credential with only `type_permissions` can
 * write items but silently fails every `createEdge` / extension write.
 *
 * The test patches `globalThis.fetch` to capture the body the broker
 * POSTs to Marfa's `/system/runtime-credentials` endpoint, then asserts
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

function mockMarfaFetch(captured: FetchCall[]): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
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
            api_key: "marfa_k1_runtime_test",
            connection_id: "conn_x",
            expires_at: new Date(Date.now() + 600_000).toISOString(),
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("nope", { status: 404 }));
  };
}

function buildTestEnv(): ControlPlaneEnv {
  return {
    MARFA_API_URL: "https://staging.test",
    MARFA_RUNTIME_BROKER_KEY: "broker-key-test",
  };
}

const AUTHORIZED_HEADERS = {
  "content-type": "application/json",
  authorization: "Bearer broker-key-test",
};

describe("POST /lease/:connection_id/runtime", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("mints with wildcard write on type_permissions, edge_permissions, AND extension_permissions", async () => {
    const captured: FetchCall[] = [];
    globalThis.fetch = mockMarfaFetch(captured);
    const app = buildApp();
    const env = buildTestEnv();

    const res = await app.request(
      "/lease/conn_x/runtime",
      {
        method: "POST",
        headers: AUTHORIZED_HEADERS,
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

  /**
   * Terminal-vs-transient classification starts here. The Worker reads
   * the `error` code off this body to decide whether to tear a
   * Connection's schedule down, so flattening every mint failure to 502
   * (or emitting an unlabelled 404) would make a deleted Connection
   * indistinguishable from a cold server — and nothing re-arms a
   * schedule that was torn down by mistake.
   */
  function stubMintStatus(status: number, message: string): typeof fetch {
    return (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.endsWith("/system/runtime-credentials")) {
        return Promise.resolve(new Response(message, { status }));
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    };
  }

  it("labels a missing connection 404 connection_not_found", async () => {
    globalThis.fetch = stubMintStatus(404, "no such connection");
    const res = await buildApp().request(
      "/lease/conn_missing/runtime",
      {
        method: "POST",
        headers: AUTHORIZED_HEADERS,
        body: JSON.stringify({}),
      },
      buildTestEnv(),
    );

    expect(res.status).toBe(404);
    const json = await res.json<{ error: string; connection_id: string }>();
    expect(json.error).toBe("connection_not_found");
    expect(json.connection_id).toBe("conn_missing");
  });

  it("labels an inactive connection 403 connection_not_active", async () => {
    globalThis.fetch = stubMintStatus(403, "connection revoked");
    const res = await buildApp().request(
      "/lease/conn_revoked/runtime",
      {
        method: "POST",
        headers: AUTHORIZED_HEADERS,
        body: JSON.stringify({}),
      },
      buildTestEnv(),
    );

    expect(res.status).toBe(403);
    const json = await res.json<{ error: string; connection_id: string }>();
    expect(json.error).toBe("connection_not_active");
    expect(json.connection_id).toBe("conn_revoked");
  });

  it("keeps a server-side failure transient as 502 mint_failed", async () => {
    globalThis.fetch = stubMintStatus(500, "database unavailable");
    const res = await buildApp().request(
      "/lease/conn_x/runtime",
      {
        method: "POST",
        headers: AUTHORIZED_HEADERS,
        body: JSON.stringify({}),
      },
      buildTestEnv(),
    );

    expect(res.status).toBe(502);
    const json = await res.json<{ error: string }>();
    expect(json.error).toBe("mint_failed");
  });

  it("answers an unrouted path with a plain not_found, distinct from the lease verdicts", async () => {
    // The catch-all is why status alone can't carry the verdict: a
    // misconfigured control-plane URL lands here with a 404 that means
    // "no such route", not "no such connection".
    const res = await buildApp().request(
      "/lease/conn_x/runtym",
      { method: "POST" },
      buildTestEnv(),
    );

    expect(res.status).toBe(404);
    const json = await res.json<{ error: string }>();
    expect(json.error).toBe("not_found");
    expect(json.error).not.toBe("connection_not_found");
  });

  it("returns 503 when MARFA_API_URL is unset", async () => {
    const app = buildApp();
    const env = {
      MARFA_RUNTIME_BROKER_KEY: "broker-key-test",
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
    const json = await res.json<{ error: string }>();
    expect(json.error).toBe("control_plane_misconfigured");
  });

  // The mint must never happen for an unauthenticated caller, so these
  // assert both the 401 and that no request reached Marfa at all.
  it("refuses a caller that sends no Authorization header", async () => {
    const captured: FetchCall[] = [];
    globalThis.fetch = mockMarfaFetch(captured);
    const res = await buildApp().request(
      "/lease/conn_x/runtime",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "test", ttl_seconds: 600 }),
      },
      buildTestEnv(),
    );
    expect(res.status).toBe(401);
    expect(await res.json<{ error: string }>()).toEqual({
      error: "unauthorized",
    });
    expect(captured).toHaveLength(0);
  });

  it("refuses a caller that sends the wrong bearer", async () => {
    const captured: FetchCall[] = [];
    globalThis.fetch = mockMarfaFetch(captured);
    const res = await buildApp().request(
      "/lease/conn_x/runtime",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer not-the-broker-key",
        },
        body: JSON.stringify({ label: "test", ttl_seconds: 600 }),
      },
      buildTestEnv(),
    );
    expect(res.status).toBe(401);
    expect(captured).toHaveLength(0);
  });
});

describe("POST /lease/:connection_id/oauth/:capability_id", () => {
  // Gated even though it is a 501 stub: an ungated route is how the
  // runtime mint path came to be reachable in the first place, and this
  // one is scheduled to start returning real tokens.
  it("refuses an unauthenticated caller before reporting not-implemented", async () => {
    const res = await buildApp().request(
      "/lease/conn_x/oauth/cap_calendar_read",
      { method: "POST" },
      buildTestEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("still reports not-implemented for an authorized caller", async () => {
    const res = await buildApp().request(
      "/lease/conn_x/oauth/cap_calendar_read",
      { method: "POST", headers: AUTHORIZED_HEADERS },
      buildTestEnv(),
    );
    expect(res.status).toBe(501);
  });
});
