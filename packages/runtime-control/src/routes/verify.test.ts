/**
 * Verify route (T-082) — tests the synchronous service-binding dispatch
 * with a mocked Marfa server (verify-context + activity poll) and a
 * mocked service binding.
 */
import { describe, it, expect } from "vitest";
import { buildApp } from "../app.js";
import type { ControlPlaneEnv } from "../env.js";

interface BindingCall {
  url: string;
  method: string;
  body: unknown;
}

function mockBinding(
  handlerOk: boolean,
  opts: { reason?: string } = {},
): {
  fetch: (req: Request) => Promise<Response>;
  calls: BindingCall[];
} {
  const calls: BindingCall[] = [];
  return {
    calls,
    async fetch(req: Request) {
      const body = await req.json<{ envelope: unknown }>();
      calls.push({ url: req.url, method: req.method, body });
      const handlerResult = handlerOk
        ? { ok: true }
        : { ok: false, retry: false, reason: opts.reason ?? "boom" };
      return new Response(
        JSON.stringify({
          ok: handlerOk,
          handler_result: handlerResult,
          envelope_used: body.envelope,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  };
}

interface MarfaFetchOptions {
  verifyContext?: {
    integration_name: string;
    tenant_id: string | null;
  };
  verifyContextStatus?: number;
  verifyContextErrorMessage?: string;
  activityRows?: {
    id: string;
    type: string;
    properties: { connection_id: string; severity: string; summary: string };
    created_at: string;
  }[];
}

function mockMarfaFetch(opts: MarfaFetchOptions = {}): typeof fetch {
  return ((input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (
      url.includes("/system/connections/") &&
      url.includes("/verify-context")
    ) {
      const status = opts.verifyContextStatus ?? 200;
      if (status !== 200) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: "forbidden",
                message: opts.verifyContextErrorMessage ?? "denied",
              },
            }),
            { status, headers: { "content-type": "application/json" } },
          ),
        );
      }
      const body = opts.verifyContext ?? {
        integration_name: "withmarfa.rss-watcher",
        tenant_id: null,
      };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            connection_id: "conn_test_verify",
            ...body,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    if (url.includes("/items") && url.includes("system.activity")) {
      return Promise.resolve(
        new Response(JSON.stringify({ data: opts.activityRows ?? [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
}

describe("POST /connections/:id/verify", () => {
  it("rejects unauthenticated callers (no Authorization header)", async () => {
    const env: ControlPlaneEnv = { MARFA_API_URL: "http://localhost:0" };
    const app = buildApp();
    const res = await app.request(
      "/connections/conn_x/verify",
      { method: "POST", body: JSON.stringify({ event: {} }) },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects when MARFA_API_URL is missing", async () => {
    const app = buildApp();
    const res = await app.request(
      "/connections/conn_x/verify",
      {
        method: "POST",
        body: "{}",
        headers: { authorization: "Bearer myme_k1_op" },
      },
      {},
    );
    expect(res.status).toBe(503);
  });

  it("rejects invalid JSON body", async () => {
    const env: ControlPlaneEnv = { MARFA_API_URL: "http://localhost:0" };
    const app = buildApp();
    const res = await app.request(
      "/connections/conn_x/verify",
      {
        method: "POST",
        body: "not-json",
        headers: { authorization: "Bearer myme_k1_op" },
      },
      env,
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_json" });
  });

  it("rejects missing event field", async () => {
    const env: ControlPlaneEnv = { MARFA_API_URL: "http://localhost:0" };
    const app = buildApp();
    const res = await app.request(
      "/connections/conn_x/verify",
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { authorization: "Bearer myme_k1_op" },
      },
      env,
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "missing_event" });
  });

  it("rejects missing event.item_id", async () => {
    const env: ControlPlaneEnv = { MARFA_API_URL: "http://localhost:0" };
    const app = buildApp();
    const res = await app.request(
      "/connections/conn_x/verify",
      {
        method: "POST",
        body: JSON.stringify({ event: { event_type: "item.created" } }),
        headers: { authorization: "Bearer myme_k1_op" },
      },
      env,
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "missing_event_field",
      field: "item_id",
    });
  });

  it("forwards 403 from the verify-context endpoint when caller lacks is_platform", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockMarfaFetch({
      verifyContextStatus: 403,
      verifyContextErrorMessage:
        "Verify context lookup requires a platform credential",
    });
    try {
      const env: ControlPlaneEnv = { MARFA_API_URL: "http://localhost:0" };
      const app = buildApp();
      const res = await app.request(
        "/connections/conn_x/verify",
        {
          method: "POST",
          body: JSON.stringify({
            event: { item_id: "item_1", event_type: "item.created" },
          }),
          headers: { authorization: "Bearer myme_k1_member" },
        },
        env,
      );
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ error: "forbidden" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("forwards 404 from the verify-context endpoint when the connection is missing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockMarfaFetch({
      verifyContextStatus: 404,
      verifyContextErrorMessage: "Connection not found",
    });
    try {
      const env: ControlPlaneEnv = { MARFA_API_URL: "http://localhost:0" };
      const app = buildApp();
      const res = await app.request(
        "/connections/conn_missing/verify",
        {
          method: "POST",
          body: JSON.stringify({
            event: { item_id: "item_1", event_type: "item.created" },
          }),
          headers: { authorization: "Bearer myme_k1_op" },
        },
        env,
      );
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toMatchObject({
        error: "connection_not_found",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 503 when no service binding is declared for the integration", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockMarfaFetch({
      verifyContext: { integration_name: "acme.unknown", tenant_id: null },
    });
    try {
      const env: ControlPlaneEnv = { MARFA_API_URL: "http://localhost:0" };
      const app = buildApp();
      const res = await app.request(
        "/connections/conn_x/verify",
        {
          method: "POST",
          body: JSON.stringify({
            event: { item_id: "item_1", event_type: "item.created" },
          }),
          headers: { authorization: "Bearer myme_k1_op" },
        },
        env,
      );
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toMatchObject({
        error: "no_service_binding",
        integration_name: "acme.unknown",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("dispatches via the service binding and returns the combined response", async () => {
    const originalFetch = globalThis.fetch;
    const activity = [
      {
        id: "act_1",
        type: "system.activity",
        properties: {
          connection_id: "conn_test_verify",
          severity: "info",
          summary: "verify run",
        },
        created_at: new Date().toISOString(),
      },
    ];
    globalThis.fetch = mockMarfaFetch({
      verifyContext: {
        integration_name: "withmarfa.rss-watcher",
        tenant_id: null,
      },
      activityRows: activity,
    });
    const binding = mockBinding(true);
    try {
      const env: ControlPlaneEnv = {
        MARFA_API_URL: "http://localhost:0",
        INTEGRATION_RSS_WATCHER: binding,
      };
      const app = buildApp();
      const res = await app.request(
        "/connections/conn_test_verify/verify",
        {
          method: "POST",
          body: JSON.stringify({
            event: {
              item_id: "item_1",
              event_type: "item.created",
              payload: { item: { id: "item_1" }, metadata: null },
            },
          }),
          headers: { authorization: "Bearer myme_k1_op" },
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        ok: boolean;
        handler_result: { ok: boolean };
        activity_emitted: unknown[];
        items_created: string[];
        envelope_used: {
          kind: string;
          integration_name: string;
          connection_id: string;
          item_id: string;
          event_type: string;
          cycle: {
            originating_connection_id: string | null;
            hop_count: number;
          };
        };
      }>();
      expect(body.ok).toBe(true);
      expect(body.handler_result).toEqual({ ok: true });
      expect(body.envelope_used.kind).toBe("item-event");
      expect(body.envelope_used.integration_name).toBe("withmarfa.rss-watcher");
      expect(body.envelope_used.connection_id).toBe("conn_test_verify");
      expect(body.envelope_used.item_id).toBe("item_1");
      expect(body.envelope_used.event_type).toBe("item.created");
      expect(body.envelope_used.cycle).toEqual({
        originating_connection_id: null,
        hop_count: 0,
      });
      expect(body.activity_emitted).toHaveLength(1);
      expect(body.items_created).toEqual([]);
      expect(binding.calls).toHaveLength(1);
      expect(binding.calls[0]!.method).toBe("POST");
      expect(binding.calls[0]!.url).toContain("/verify");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces a permanent handler failure verbatim", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockMarfaFetch({
      verifyContext: {
        integration_name: "withmarfa.rss-watcher",
        tenant_id: null,
      },
    });
    const binding = mockBinding(false, { reason: "upstream_500" });
    try {
      const env: ControlPlaneEnv = {
        MARFA_API_URL: "http://localhost:0",
        INTEGRATION_RSS_WATCHER: binding,
      };
      const app = buildApp();
      const res = await app.request(
        "/connections/conn_test_verify/verify",
        {
          method: "POST",
          body: JSON.stringify({
            event: { item_id: "item_1", event_type: "item.created" },
          }),
          headers: { authorization: "Bearer myme_k1_op" },
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        ok: boolean;
        handler_result:
          | { ok: true }
          | { ok: false; retry: boolean; reason: string };
      }>();
      expect(body.ok).toBe(false);
      if (!body.handler_result.ok) {
        expect(body.handler_result.reason).toBe("upstream_500");
      } else {
        throw new Error("expected handler failure");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("threads operator-supplied cycle metadata into the envelope", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockMarfaFetch({
      verifyContext: {
        integration_name: "withmarfa.rss-watcher",
        tenant_id: null,
      },
    });
    const binding = mockBinding(true);
    try {
      const env: ControlPlaneEnv = {
        MARFA_API_URL: "http://localhost:0",
        INTEGRATION_RSS_WATCHER: binding,
      };
      const app = buildApp();
      const res = await app.request(
        "/connections/conn_test_verify/verify",
        {
          method: "POST",
          body: JSON.stringify({
            event: {
              item_id: "item_1",
              event_type: "item.created",
              cycle: {
                originating_connection_id: "conn_origin",
                hop_count: 2,
              },
            },
          }),
          headers: { authorization: "Bearer myme_k1_op" },
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        envelope_used: {
          cycle: {
            originating_connection_id: string | null;
            hop_count: number;
          };
        };
      }>();
      expect(body.envelope_used.cycle).toEqual({
        originating_connection_id: "conn_origin",
        hop_count: 2,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
