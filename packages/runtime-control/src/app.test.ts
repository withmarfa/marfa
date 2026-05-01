import { describe, it, expect } from "vitest";
import { buildApp, VERSION } from "./app.js";
import type { ControlPlaneEnv } from "./env.js";

const TEST_ENV: ControlPlaneEnv = {
  MYME_API_URL: "http://localhost:8602",
  ENVIRONMENT: "test",
};

describe("control plane app", () => {
  it("returns ok=true on /health with environment + version surfaced", async () => {
    const app = buildApp();
    const res = await app.request("/health", { method: "GET" }, TEST_ENV);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      service: "runtime-control",
      version: VERSION,
      environment: "test",
      myme_api_url_configured: true,
    });
  });

  it("flags MYME_API_URL absence in /health", async () => {
    const app = buildApp();
    const res = await app.request("/health", { method: "GET" }, {});
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      myme_api_url_configured: false,
      environment: "unknown",
    });
  });

  it("returns 501 for inbound webhook (PR 3 wires it)", async () => {
    const app = buildApp();
    const res = await app.request(
      "/webhooks/inbound/conn_123",
      { method: "POST", body: "{}" },
      TEST_ENV,
    );
    expect(res.status).toBe(501);
    await expect(res.json()).resolves.toMatchObject({
      error: "not_implemented",
      connection_id: "conn_123",
    });
  });

  it("returns 501 for runtime lease (PR 4 wires it)", async () => {
    const app = buildApp();
    const res = await app.request(
      "/lease/conn_123/runtime",
      { method: "POST" },
      TEST_ENV,
    );
    expect(res.status).toBe(501);
    await expect(res.json()).resolves.toMatchObject({
      connection_id: "conn_123",
    });
  });

  it("returns 501 for OAuth lease (PR 4 wires it)", async () => {
    const app = buildApp();
    const res = await app.request(
      "/lease/conn_123/oauth/cap_calendar_read",
      { method: "POST" },
      TEST_ENV,
    );
    expect(res.status).toBe(501);
    await expect(res.json()).resolves.toMatchObject({
      capability_id: "cap_calendar_read",
    });
  });

  it("returns 501 for install callback (Layer 2 wires it)", async () => {
    const app = buildApp();
    const res = await app.request(
      "/install-callback",
      { method: "POST", body: "{}" },
      TEST_ENV,
    );
    expect(res.status).toBe(501);
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
