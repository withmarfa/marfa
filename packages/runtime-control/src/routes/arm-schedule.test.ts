/**
 * Schedule arm/disarm broker routes.
 *
 * Disarm is the teardown counterpart to arm: the server calls it when a
 * Connection is uninstalled so the per-Connection alarm stops firing.
 * Without it, an uninstalled Connection's schedule runs forever against
 * a Connection that no longer exists.
 *
 * The tests mount the real Hono app with a stubbed service binding, so
 * they pin the auth gate, the idempotency contract, and the dispatch
 * shape the per-Integration Worker receives.
 */
import { describe, it, expect } from "vitest";
import { buildApp } from "../app.js";
import type { ControlPlaneEnv } from "../env.js";

const BROKER_KEY = "broker-key-test";
const CONNECTION_ID = "conn_schedule";

interface BindingCall {
  url: string;
  method: string;
}

function buildEnvWithBinding(
  calls: BindingCall[],
  response: () => Response,
): ControlPlaneEnv {
  return {
    MARFA_API_URL: "https://staging.test",
    MARFA_RUNTIME_BROKER_KEY: BROKER_KEY,
    INTEGRATION_RSS_WATCHER: {
      fetch(request: Request): Promise<Response> {
        calls.push({ url: request.url, method: request.method });
        return Promise.resolve(response());
      },
    },
  };
}

function okResponse(): Response {
  return new Response(JSON.stringify({ ok: true, disarmed: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function post(
  app: ReturnType<typeof buildApp>,
  env: ControlPlaneEnv,
  path: string,
  body: unknown,
  auth = `Bearer ${BROKER_KEY}`,
): Promise<Response> {
  return Promise.resolve(
    app.request(
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth },
        body: JSON.stringify(body),
      },
      env,
    ),
  );
}

describe("POST /connections/:connection_id/disarm-schedule", () => {
  it("dispatches disarm to the integration Worker", async () => {
    const calls: BindingCall[] = [];
    const env = buildEnvWithBinding(calls, okResponse);
    const res = await post(
      buildApp(),
      env,
      `/connections/${CONNECTION_ID}/disarm-schedule`,
      { integration_name: "withmarfa.rss-watcher" },
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; connection_id: string }>();
    expect(body.ok).toBe(true);
    expect(body.connection_id).toBe(CONNECTION_ID);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/disarm-schedule");
    expect(calls[0]!.url).toContain(`connection_id=${CONNECTION_ID}`);
  });

  it("rejects a request without the broker key", async () => {
    const env = buildEnvWithBinding([], okResponse);
    const res = await post(
      buildApp(),
      env,
      `/connections/${CONNECTION_ID}/disarm-schedule`,
      { integration_name: "withmarfa.rss-watcher" },
      "Bearer wrong",
    );
    expect(res.status).toBe(401);
  });

  it("requires an integration_name", async () => {
    const env = buildEnvWithBinding([], okResponse);
    const res = await post(
      buildApp(),
      env,
      `/connections/${CONNECTION_ID}/disarm-schedule`,
      {},
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("missing_integration_name");
  });

  it("is idempotent — a second disarm is still a success", async () => {
    const calls: BindingCall[] = [];
    const env = buildEnvWithBinding(
      calls,
      () =>
        new Response(
          JSON.stringify({
            ok: true,
            disarmed: true,
            previous_next_run_at_ms: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const app = buildApp();
    const path = `/connections/${CONNECTION_ID}/disarm-schedule`;
    const first = await post(app, env, path, {
      integration_name: "withmarfa.rss-watcher",
    });
    const second = await post(app, env, path, {
      integration_name: "withmarfa.rss-watcher",
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("succeeds without dispatch for an integration that ships no Worker", async () => {
    const calls: BindingCall[] = [];
    const env = buildEnvWithBinding(calls, okResponse);
    const res = await post(
      buildApp(),
      env,
      `/connections/${CONNECTION_ID}/disarm-schedule`,
      { integration_name: "withmarfa.sync" },
    );

    // `withmarfa.sync` is in-tree but local-only — it can never hold a
    // Durable Object alarm, so "nothing to disarm" is success, not 503.
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; dispatched: boolean }>();
    expect(body.ok).toBe(true);
    expect(body.dispatched).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("surfaces a missing service binding as 503", async () => {
    const env = {
      MARFA_API_URL: "https://staging.test",
      MARFA_RUNTIME_BROKER_KEY: BROKER_KEY,
    } as unknown as ControlPlaneEnv;
    const res = await post(
      buildApp(),
      env,
      `/connections/${CONNECTION_ID}/disarm-schedule`,
      { integration_name: "withmarfa.rss-watcher" },
    );
    expect(res.status).toBe(503);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("no_service_binding");
  });
});

describe("POST /connections/:connection_id/arm-schedule", () => {
  it("still dispatches arm to the integration Worker", async () => {
    const calls: BindingCall[] = [];
    const env = buildEnvWithBinding(
      calls,
      () =>
        new Response(JSON.stringify({ ok: true, next_run_at_ms: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const res = await post(
      buildApp(),
      env,
      `/connections/${CONNECTION_ID}/arm-schedule`,
      { integration_name: "withmarfa.rss-watcher" },
    );

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/arm-schedule");
  });
});
