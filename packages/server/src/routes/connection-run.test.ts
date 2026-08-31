/**
 * `POST /connections/{id}/run` — the manual dispatch surface.
 *
 * The declaration has to mean something, which is the whole reason this
 * route exists: `manual` validated in the manifest schema, parsed into
 * the runtime's trigger set, and was fired by nothing, so an integration
 * declaring it behaved exactly like one that did not.
 *
 * Two refusals matter more than the happy path. A manifest that does not
 * declare `manual` is refused, or the declaration is decoration. And an
 * integration this deployment does not run is refused rather than queued,
 * because the supervisor acks an envelope naming an unknown integration
 * and skips it silently: accepting would report a run that never happens,
 * which is the exact failure shape this wave exists to remove.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { IntegrationManifest } from "@withmarfa/shared";
import { registerIntegrationManifest } from "../integrations/register-manifest.js";
import { connectionRoutes } from "./connections.js";
import type { LocalRuntime } from "../integrations/local-runtime/types.js";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../middleware/auth.js";
import { createErrorHandler } from "../middleware/error-handler.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

let seq = 0;
function manifest(
  over: Partial<IntegrationManifest> = {},
): IntegrationManifest {
  seq += 1;
  return {
    name: `acme/run-${String(seq)}`,
    version: "1.0.0",
    manifest_schema_version: "2.0.0",
    publisher: "acme",
    description: "manual run test",
    direction: "read",
    triggers: [
      { type: "schedule", config: { cron: "0 * * * *" } },
      { type: "manual" },
    ],
    target_types: ["core.note"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "ignore",
      partial_write_mode: "accept-partial",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    ...over,
  } as unknown as IntegrationManifest;
}

/** A runtime that records what it was asked to enqueue. */
function fakeRuntime(options?: {
  registered?: boolean;
  triggerKinds?: string[];
}): { runtime: LocalRuntime; enqueued: unknown[] } {
  const enqueued: unknown[] = [];
  const registered = options?.registered ?? true;
  const kinds = new Set(options?.triggerKinds ?? ["schedule", "manual"]);
  const runtime = {
    start: vi.fn(),
    stop: vi.fn(),
    enqueue: vi.fn((envelope: unknown) => {
      enqueued.push(envelope);
      return Promise.resolve();
    }),
    dispatchForTest: vi.fn(),
    getRegistration: (name: string) =>
      registered
        ? ({
            name,
            handlerModulePath: "/dev/null",
            echo: { echo_ttl_seconds: 60, lag_window_seconds: 60 },
            triggerKinds: kinds,
          } as never)
        : undefined,
  } as unknown as LocalRuntime;
  return { runtime, enqueued };
}

async function scenario(
  m: IntegrationManifest,
  connectionOverrides: Record<string, unknown> = {},
): Promise<string> {
  const reg = await registerIntegrationManifest(ctx.storage, m, undefined);
  const conn = await ctx.storage.items.create(
    {
      type: "system.connection",
      properties: {
        kind: "integration",
        status: "active",
        granted_at: new Date().toISOString(),
        runtime_status: "healthy",
        integration_ref: reg.item.id,
        configuration: {},
        ...connectionOverrides,
      },
    },
    undefined,
  );
  return conn.id;
}

function appWith(runtime: LocalRuntime | null): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();
  // The real app's error handler, so a MarfaError lands on the wire as
  // its own status rather than as a 500. Without it these assertions
  // would pass or fail on the wrong thing entirely.
  app.onError(createErrorHandler({ errorWebhookUrl: "" }));
  // Stand in for the auth middleware: the route reads the key off the
  // context, and the gate under test is the manifest, not the caller.
  app.use("*", async (c, next) => {
    c.set("apiKey", {
      id: "key-under-test",
      role: "instance_admin",
      is_platform: true,
      space_id: undefined,
    } as never);
    c.set("clientIp", null as never);
    await next();
  });
  app.route("/connections", connectionRoutes(ctx.storage, runtime));
  return app;
}

describe("POST /connections/{id}/run", () => {
  it("queues a manual message for a connection that declares the trigger", async () => {
    const id = await scenario(manifest());
    const { runtime, enqueued } = fakeRuntime();
    const res = await appWith(runtime).request(`/connections/${id}/run`, {
      method: "POST",
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ connection_id: id, queued: true });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      message: { kind: "manual", connection_id: id },
    });
  });

  it("refuses a connection whose manifest does not declare manual", async () => {
    const id = await scenario(
      manifest({
        triggers: [{ type: "schedule", config: { cron: "0 * * * *" } }],
      }),
    );
    const { runtime, enqueued } = fakeRuntime();
    const res = await appWith(runtime).request(`/connections/${id}/run`, {
      method: "POST",
    });

    expect(res.status).toBe(400);
    const body = JSON.stringify(await res.json());
    expect(body).toContain("declares no ");
    expect(body).toContain("manual");
    expect(enqueued).toHaveLength(0);
  });

  it("refuses an integration this deployment does not run, rather than queueing a run that never happens", async () => {
    const id = await scenario(manifest());
    const { runtime, enqueued } = fakeRuntime({ registered: false });
    const res = await appWith(runtime).request(`/connections/${id}/run`, {
      method: "POST",
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(
      "does not run on this deployment",
    );
    expect(enqueued).toHaveLength(0);
  });

  it("refuses when the running build's trigger set disagrees with the stored manifest", async () => {
    const id = await scenario(manifest());
    const { runtime, enqueued } = fakeRuntime({ triggerKinds: ["schedule"] });
    const res = await appWith(runtime).request(`/connections/${id}/run`, {
      method: "POST",
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(
      "does not accept manual runs",
    );
    expect(enqueued).toHaveLength(0);
  });

  it("refuses a paused connection instead of queueing work that evaporates", async () => {
    const id = await scenario(manifest(), { runtime_status: "paused" });
    const { runtime, enqueued } = fakeRuntime();
    const res = await appWith(runtime).request(`/connections/${id}/run`, {
      method: "POST",
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("is paused");
    expect(enqueued).toHaveLength(0);
  });

  it("answers 503 when the instance has no integration runtime", async () => {
    const id = await scenario(manifest());
    const res = await appWith(null).request(`/connections/${id}/run`, {
      method: "POST",
    });
    expect(res.status).toBe(503);
  });

  it("refuses a connection that is not an integration", async () => {
    const conn = await ctx.storage.items.create(
      {
        type: "system.connection",
        properties: {
          kind: "app",
          status: "active",
          granted_at: new Date().toISOString(),
        },
      },
      undefined,
    );
    const { runtime } = fakeRuntime();
    const res = await appWith(runtime).request(`/connections/${conn.id}/run`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });
});
