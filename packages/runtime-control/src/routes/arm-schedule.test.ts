/**
 * Arm-schedule route — inbound gate plus the credential it presents
 * onward.
 *
 * The route is the only caller of a per-Integration Worker's
 * `/arm-schedule`, and that Worker gates its whole fetch surface on the
 * broker key. Both ends of the hop are pinned here so a change to one
 * cannot silently break the other: dropping the header would leave
 * schedule arming failing after install, which surfaces only as an
 * `action_required` activity row nobody is watching for.
 */
import { describe, it, expect } from "vitest";
import { buildApp } from "../app.js";
import type { ControlPlaneEnv } from "../env.js";

const BROKER_KEY = "broker-key-test";

interface BindingCall {
  url: string;
  method: string;
  authorization: string | null;
}

function mockBinding(): {
  fetch: (req: Request) => Promise<Response>;
  calls: BindingCall[];
} {
  const calls: BindingCall[] = [];
  return {
    calls,
    fetch(req: Request) {
      calls.push({
        url: req.url,
        method: req.method,
        authorization: req.headers.get("authorization"),
      });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, armed: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  };
}

function armRequest(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  };
}

describe("POST /connections/:id/arm-schedule", () => {
  it("rejects a caller with no Authorization header", async () => {
    const binding = mockBinding();
    const env: ControlPlaneEnv = {
      MARFA_RUNTIME_BROKER_KEY: BROKER_KEY,
      INTEGRATION_RSS_WATCHER: binding,
    };
    const app = buildApp();
    const res = await app.request(
      "/connections/conn_1/arm-schedule",
      armRequest({ integration_name: "withmarfa.rss-watcher" }),
      env,
    );
    expect(res.status).toBe(401);
    expect(binding.calls).toHaveLength(0);
  });

  it("rejects a caller presenting the wrong key", async () => {
    const binding = mockBinding();
    const env: ControlPlaneEnv = {
      MARFA_RUNTIME_BROKER_KEY: BROKER_KEY,
      INTEGRATION_RSS_WATCHER: binding,
    };
    const app = buildApp();
    const res = await app.request(
      "/connections/conn_1/arm-schedule",
      armRequest(
        { integration_name: "withmarfa.rss-watcher" },
        { authorization: "Bearer not-the-key" },
      ),
      env,
    );
    expect(res.status).toBe(401);
    expect(binding.calls).toHaveLength(0);
  });

  it("rejects when the control plane has no broker key configured", async () => {
    const app = buildApp();
    const res = await app.request(
      "/connections/conn_1/arm-schedule",
      armRequest(
        { integration_name: "withmarfa.rss-watcher" },
        { authorization: `Bearer ${BROKER_KEY}` },
      ),
      {},
    );
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: "control_plane_misconfigured",
    });
  });

  it("requires integration_name", async () => {
    const env: ControlPlaneEnv = { MARFA_RUNTIME_BROKER_KEY: BROKER_KEY };
    const app = buildApp();
    const res = await app.request(
      "/connections/conn_1/arm-schedule",
      armRequest({}, { authorization: `Bearer ${BROKER_KEY}` }),
      env,
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "missing_integration_name",
    });
  });

  it("returns 503 when no service binding is declared for the integration", async () => {
    const env: ControlPlaneEnv = { MARFA_RUNTIME_BROKER_KEY: BROKER_KEY };
    const app = buildApp();
    const res = await app.request(
      "/connections/conn_1/arm-schedule",
      armRequest(
        { integration_name: "acme.unknown" },
        { authorization: `Bearer ${BROKER_KEY}` },
      ),
      env,
    );
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: "no_service_binding",
      integration_name: "acme.unknown",
    });
  });

  it("dispatches over the service binding and presents the broker key onward", async () => {
    const binding = mockBinding();
    const env: ControlPlaneEnv = {
      MARFA_RUNTIME_BROKER_KEY: BROKER_KEY,
      INTEGRATION_RSS_WATCHER: binding,
    };
    const app = buildApp();
    const res = await app.request(
      "/connections/conn_1/arm-schedule",
      armRequest(
        { integration_name: "withmarfa.rss-watcher" },
        { authorization: `Bearer ${BROKER_KEY}` },
      ),
      env,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      integration_name: "withmarfa.rss-watcher",
      connection_id: "conn_1",
    });
    expect(binding.calls).toHaveLength(1);
    expect(binding.calls[0]!.method).toBe("POST");
    expect(binding.calls[0]!.url).toContain("connection_id=conn_1");
    expect(binding.calls[0]!.authorization).toBe(`Bearer ${BROKER_KEY}`);
  });

  it("percent-encodes the connection id into the dispatch URL", async () => {
    const binding = mockBinding();
    const env: ControlPlaneEnv = {
      MARFA_RUNTIME_BROKER_KEY: BROKER_KEY,
      INTEGRATION_RSS_WATCHER: binding,
    };
    const app = buildApp();
    const res = await app.request(
      "/connections/conn%201%26x/arm-schedule",
      armRequest(
        { integration_name: "withmarfa.rss-watcher" },
        { authorization: `Bearer ${BROKER_KEY}` },
      ),
      env,
    );
    expect(res.status).toBe(200);
    const url = new URL(binding.calls[0]!.url);
    expect(url.searchParams.get("connection_id")).toBe("conn 1&x");
  });
});
