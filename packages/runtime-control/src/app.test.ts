import { describe, it, expect } from "vitest";
import { buildApp, VERSION } from "./app.js";
import type { ControlPlaneEnv } from "./env.js";

const TEST_ENV: ControlPlaneEnv = {
  MARFA_API_URL: "http://localhost:8602",
  MARFA_RUNTIME_BROKER_KEY: "marfa_k1_broker_test",
  ENVIRONMENT: "test",
};

describe("control plane app — base routes", () => {
  it("returns ok=true on /health with environment + version surfaced", async () => {
    const app = buildApp();
    const res = await app.request("/health", { method: "GET" }, TEST_ENV);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      service: "runtime-control",
      version: VERSION,
      environment: "test",
      marfa_api_url_configured: true,
    });
  });

  it("flags MARFA_API_URL absence in /health", async () => {
    const app = buildApp();
    const res = await app.request("/health", { method: "GET" }, {});
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      marfa_api_url_configured: false,
      environment: "unknown",
    });
  });

  it("returns 503 for inbound webhook when control plane env is missing", async () => {
    const app = buildApp();
    const res = await app.request(
      "/webhooks/inbound/conn_123",
      { method: "POST", body: "{}" },
      {},
    );
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: "control_plane_misconfigured",
    });
  });

  it("returns 503 for inbound webhook when WEBHOOK_RECEIPT_QUEUE is unbound", async () => {
    const app = buildApp();
    const res = await app.request(
      "/webhooks/inbound/conn_123",
      { method: "POST", body: "{}" },
      TEST_ENV,
    );
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: "queue_unbound",
    });
  });

  it("returns 503 for runtime lease when env is missing", async () => {
    const app = buildApp();
    const res = await app.request(
      "/lease/conn_123/runtime",
      { method: "POST", body: "{}" },
      {},
    );
    expect(res.status).toBe(503);
  });

  it("returns 501 for OAuth lease (not yet implemented)", async () => {
    const app = buildApp();
    const res = await app.request(
      "/lease/conn_123/oauth/cap_calendar_read",
      {
        method: "POST",
        headers: { authorization: "Bearer marfa_k1_broker_test" },
      },
      TEST_ENV,
    );
    expect(res.status).toBe(501);
    await expect(res.json()).resolves.toMatchObject({
      capability_id: "cap_calendar_read",
    });
  });

  it("returns 404 for unknown routes", async () => {
    const app = buildApp();
    const res = await app.request(
      "/does-not-exist",
      { method: "GET" },
      TEST_ENV,
    );
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: "not_found",
    });
  });
});
