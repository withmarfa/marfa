/**
 * Uninstall must tear down the connection's hosted-substrate schedule.
 *
 * Before this was wired, uninstalling a scheduled integration left its
 * per-Connection Durable Object alarm armed. The alarm re-arms itself on
 * every fire, so the schedule kept running indefinitely against a
 * connection that no longer existed.
 *
 * These tests stub `globalThis.fetch` to stand in for the runtime-control
 * plane and assert on the request the pipeline makes plus how it reports
 * the outcome.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { performInstall } from "./install-pipeline.js";
import { performUninstall } from "./uninstall-pipeline.js";
import type { IntegrationManifest } from "@withmarfa/shared";

let ctx: TestContext;
let originalFetch: typeof fetch;

beforeAll(async () => {
  ctx = await createTestContext();
  originalFetch = globalThis.fetch;
});

afterAll(async () => {
  await ctx.cleanup();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const CONTROL_PLANE_URL = "https://runtime.test";
const BROKER_KEY = "broker-key-test";

function scheduledManifest(name: string): IntegrationManifest {
  return {
    name,
    version: "1.0.0",
    publisher: "Acme",
    description: "scheduled uninstall test",
    direction: "both",
    triggers: [{ type: "schedule", config: { cron: "0 * * * *" } }],
    target_types: ["core.note"],
    runtime_compatibility: ["hosted"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "prompt-user",
      partial_write_mode: "all-or-nothing",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    manifest_schema_version: "1.0.0",
  };
}

async function installScheduled(): Promise<{
  apiKeyId: string;
  connectionId: string;
  manifestName: string;
}> {
  const adminKey = await ctx.storage.keys
    .list()
    .then((keys) => keys.find((k) => k.role === "admin"));
  if (!adminKey) throw new Error("admin key not found in test ctx");

  const manifestName = `acme.scheduled-${Date.now().toString()}-${Math.random().toString(36).slice(2, 8)}`;
  const manifest = scheduledManifest(manifestName);

  const integration = await ctx.storage.items.create(
    {
      type: "system.integration",
      properties: {
        manifest_name: manifestName,
        manifest_version: "1.0.0",
        publisher: "Acme",
        direction: "both",
        runtime_compatibility: ["hosted"],
        manifest,
        registered_at: new Date().toISOString(),
      },
    },
    undefined,
  );

  const result = await performInstall(ctx.storage, "test-salt", {
    apiKeyId: adminKey.id,
    tenantId: undefined,
    integrationItemId: integration.id,
    manifest,
    label: `scheduled uninstall test ${Date.now().toString()}`,
  });

  return {
    apiKeyId: adminKey.id,
    connectionId: result.connection_id,
    manifestName,
  };
}

interface CapturedCall {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

function stubControlPlane(
  captured: CapturedCall[],
  respond: () => Response,
): void {
  globalThis.fetch = (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const headers = new Headers(init?.headers);
    captured.push({
      url,
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      body,
    });
    return Promise.resolve(respond());
  };
}

function okDisarm(): Response {
  return new Response(JSON.stringify({ ok: true, dispatched: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("performUninstall — schedule disarm", () => {
  it("disarms the connection's schedule via the control plane", async () => {
    const installed = await installScheduled();
    const captured: CapturedCall[] = [];
    stubControlPlane(captured, okDisarm);

    const result = await performUninstall(ctx.storage, {
      apiKeyId: installed.apiKeyId,
      tenantId: undefined,
      connectionId: installed.connectionId,
      controlPlaneUrl: CONTROL_PLANE_URL,
      runtimeBrokerKey: BROKER_KEY,
    });

    expect(result.schedules_disarmed).toBe(true);
    expect(result.schedule_disarm_error).toBeUndefined();

    const call = captured.find((c) => c.url.includes("/disarm-schedule"));
    expect(call).toBeDefined();
    expect(call!.method).toBe("POST");
    expect(call!.url).toBe(
      `${CONTROL_PLANE_URL}/connections/${installed.connectionId}/disarm-schedule`,
    );
    expect(call!.authorization).toBe(`Bearer ${BROKER_KEY}`);
    expect(call!.body).toEqual({ integration_name: installed.manifestName });
  });

  it("records a disarm failure loudly instead of silently completing", async () => {
    const installed = await installScheduled();
    const captured: CapturedCall[] = [];
    stubControlPlane(
      captured,
      () =>
        new Response(JSON.stringify({ error: "binding_fetch_failed" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await performUninstall(ctx.storage, {
      apiKeyId: installed.apiKeyId,
      tenantId: undefined,
      connectionId: installed.connectionId,
      controlPlaneUrl: CONTROL_PLANE_URL,
      runtimeBrokerKey: BROKER_KEY,
    });

    // Uninstall still completes — it is monotonic toward "uninstalled" —
    // but the residue is surfaced, not swallowed.
    expect(result.schedules_disarmed).toBe(false);
    expect(result.schedule_disarm_error).toBeTruthy();

    const connection = await ctx.storage.items.getIncludingTrashed(
      installed.connectionId,
      undefined,
    );
    expect(connection?.state).toBe("revoked");

    const activities = await ctx.storage.items.list({
      type: "system.activity",
      limit: 100,
    });
    const alarm = activities.data.find(
      (item) =>
        item.properties.connection_id === installed.connectionId &&
        item.properties.severity === "action_required",
    );
    expect(alarm).toBeDefined();
    expect(String(alarm?.properties.summary)).toMatch(/disarm/i);

    const auditRows = await ctx.storage.audit.list({
      action: "integration.uninstall",
      resource_id: installed.connectionId,
      limit: 5,
    });
    expect(auditRows.data[0]?.details.schedules_disarmed).toBe(false);
  });

  it("skips the disarm step when no control plane is configured", async () => {
    const installed = await installScheduled();
    const captured: CapturedCall[] = [];
    stubControlPlane(captured, okDisarm);

    const result = await performUninstall(ctx.storage, {
      apiKeyId: installed.apiKeyId,
      tenantId: undefined,
      connectionId: installed.connectionId,
    });

    // Local-substrate deployments have no control plane; the schedule
    // walker there gates on connection state, so there is nothing to
    // tear down and nothing to warn about.
    expect(result.schedules_disarmed).toBe(false);
    expect(result.schedule_disarm_error).toBeUndefined();
    expect(captured.filter((c) => c.url.includes("/disarm-schedule"))).toEqual(
      [],
    );
  });
});
