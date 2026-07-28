/**
 * Schedule arm/disarm broker routes — the inbound gate, the credential
 * presented onward, and the disarm contract.
 *
 * Disarm is the teardown counterpart to arm: the server calls it when a
 * Connection is uninstalled so the per-Connection alarm stops firing.
 * Without it, an uninstalled Connection's schedule runs forever against
 * a Connection that no longer exists.
 *
 * Both verbs run through one dispatch helper, so the gate and the
 * outbound header are pinned on each of them rather than on the pair.
 * A route that stopped presenting a credential would be refused by every
 * per-Integration Worker in the fleet, and the only symptom is an
 * `action_required` activity row nobody is watching for.
 *
 * The two credentials on this route are different and deliberately so.
 * Inbound, the caller is the Marfa server presenting the platform broker
 * key. Outbound, the Worker receives a key derived for that Worker
 * alone. Forwarding the inbound one would put a credential that mints
 * against any Connection in any tenant onto every Worker in the fleet.
 *
 * The tests mount the real Hono app with a stubbed service binding, so
 * they pin the auth gate, the idempotency contract, and the dispatch
 * shape the per-Integration Worker receives.
 */
import { describe, it, expect } from "vitest";
import { deriveWorkerIdentityKey } from "@withmarfa/shared";
import { buildApp } from "../app.js";
import type { ControlPlaneEnv } from "../env.js";

const BROKER_KEY = "broker-key-test";
const IDENTITY_ROOT = "worker-identity-root-test";
const INTEGRATION = "withmarfa.rss-watcher";
const CONNECTION_ID = "conn_schedule";

/** What the target Worker holds, and therefore what it must receive. */
function expectedDispatchKey(): Promise<string> {
  return deriveWorkerIdentityKey(IDENTITY_ROOT, INTEGRATION);
}

interface BindingCall {
  url: string;
  method: string;
  authorization: string | null;
}

function buildEnvWithBinding(
  calls: BindingCall[],
  response: () => Response,
): ControlPlaneEnv {
  return {
    MARFA_API_URL: "https://staging.test",
    MARFA_RUNTIME_BROKER_KEY: BROKER_KEY,
    MARFA_WORKER_IDENTITY_SECRET: IDENTITY_ROOT,
    INTEGRATION_RSS_WATCHER: {
      fetch(request: Request): Promise<Response> {
        calls.push({
          url: request.url,
          method: request.method,
          authorization: request.headers.get("authorization"),
        });
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

function armResponse(): Response {
  return new Response(JSON.stringify({ ok: true, next_run_at_ms: 1 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * `auth` defaults to the correct key. Pass `null` to send no
 * `Authorization` header at all — a different refusal path from
 * presenting the wrong value, and the one an unauthenticated caller
 * takes.
 */
function post(
  app: ReturnType<typeof buildApp>,
  env: ControlPlaneEnv,
  path: string,
  body: unknown,
  auth: string | null = `Bearer ${BROKER_KEY}`,
): Promise<Response> {
  return Promise.resolve(
    app.request(
      path,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth === null ? {} : { authorization: auth }),
        },
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

  /**
   * The per-Integration Worker authenticates its whole fetch surface on
   * its own identity key. A headerless dispatch is refused there, and
   * the uninstall pipeline reads the refusal as "the alarm was not
   * cancelled" — leaving a schedule ticking on a revoked connection,
   * which is the exact failure the disarm route exists to prevent.
   */
  it("carries the target Worker's identity key on the outbound disarm dispatch", async () => {
    const calls: BindingCall[] = [];
    const env = buildEnvWithBinding(calls, okResponse);
    await post(
      buildApp(),
      env,
      `/connections/${CONNECTION_ID}/disarm-schedule`,
      { integration_name: INTEGRATION },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.authorization).toBe(
      `Bearer ${await expectedDispatchKey()}`,
    );
    // The credential the server presented inbound stops at this route.
    expect(calls[0]!.authorization).not.toBe(`Bearer ${BROKER_KEY}`);
  });

  it("rejects a request presenting the wrong broker key", async () => {
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

  it("rejects a caller with no Authorization header", async () => {
    const calls: BindingCall[] = [];
    const env = buildEnvWithBinding(calls, okResponse);
    const res = await post(
      buildApp(),
      env,
      `/connections/${CONNECTION_ID}/disarm-schedule`,
      { integration_name: "withmarfa.rss-watcher" },
      null,
    );
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("rejects when the control plane has no broker key configured", async () => {
    const res = await post(
      buildApp(),
      {},
      `/connections/${CONNECTION_ID}/disarm-schedule`,
      { integration_name: "withmarfa.rss-watcher" },
    );
    expect(res.status).toBe(503);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("control_plane_misconfigured");
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

  it("reports failure with an error code when the Worker has no disarm route", async () => {
    // A Worker deployed before the disarm route existed answers its
    // catch-all. That must not read as a completed disarm anywhere in
    // the chain, and the failure needs a code a caller can match on.
    const calls: BindingCall[] = [];
    const env = buildEnvWithBinding(
      calls,
      () =>
        new Response(
          JSON.stringify({ ok: false, error: "not_found", integration: "x" }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    );
    const res = await post(
      buildApp(),
      env,
      `/connections/${CONNECTION_ID}/disarm-schedule`,
      { integration_name: "withmarfa.rss-watcher" },
    );

    expect(res.status).toBe(502);
    const body = await res.json<{
      error: string;
      ok: boolean;
      result: { disarmed?: boolean };
    }>();
    expect(body.error).toBe("dispatch_failed");
    expect(body.ok).toBe(false);
    expect(body.result.disarmed).toBeUndefined();
  });

  it("passes the Worker's disarmed attestation through on success", async () => {
    // `result.disarmed` is the only field that attests the Durable
    // Object actually ran deleteAlarm(); the server asserts on it, so
    // the control plane must not drop or synthesize it.
    const calls: BindingCall[] = [];
    const env = buildEnvWithBinding(calls, okResponse);
    const res = await post(
      buildApp(),
      env,
      `/connections/${CONNECTION_ID}/disarm-schedule`,
      { integration_name: "withmarfa.rss-watcher" },
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ result: { disarmed: boolean } }>();
    expect(body.result.disarmed).toBe(true);
  });

  it("surfaces a missing service binding as 503", async () => {
    const env = {
      MARFA_API_URL: "https://staging.test",
      MARFA_RUNTIME_BROKER_KEY: BROKER_KEY,
      MARFA_WORKER_IDENTITY_SECRET: IDENTITY_ROOT,
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

  it("percent-encodes the connection id into the dispatch URL", async () => {
    const calls: BindingCall[] = [];
    const env = buildEnvWithBinding(calls, okResponse);
    const res = await post(
      buildApp(),
      env,
      "/connections/conn%201%26x/disarm-schedule",
      { integration_name: "withmarfa.rss-watcher" },
    );

    expect(res.status).toBe(200);
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("connection_id")).toBe("conn 1&x");
  });
});

describe("POST /connections/:connection_id/arm-schedule", () => {
  it("still dispatches arm to the integration Worker", async () => {
    const calls: BindingCall[] = [];
    const env = buildEnvWithBinding(calls, armResponse);
    const res = await post(
      buildApp(),
      env,
      `/connections/${CONNECTION_ID}/arm-schedule`,
      { integration_name: "withmarfa.rss-watcher" },
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; integration_name: string }>();
    expect(body.ok).toBe(true);
    expect(body.integration_name).toBe("withmarfa.rss-watcher");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/arm-schedule");
    expect(calls[0]!.url).toContain(`connection_id=${CONNECTION_ID}`);
  });

  it("carries the target Worker's identity key on the outbound arm dispatch", async () => {
    const calls: BindingCall[] = [];
    const env = buildEnvWithBinding(calls, armResponse);
    await post(buildApp(), env, `/connections/${CONNECTION_ID}/arm-schedule`, {
      integration_name: INTEGRATION,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.authorization).toBe(
      `Bearer ${await expectedDispatchKey()}`,
    );
    expect(calls[0]!.authorization).not.toBe(`Bearer ${BROKER_KEY}`);
  });

  it("refuses to dispatch when the Worker identity root is unset", async () => {
    // Deriving from an empty root would produce a key every equally
    // misconfigured deployment computes identically, which is the
    // fleet-wide shared secret the derived keys exist to remove.
    const calls: BindingCall[] = [];
    const env = buildEnvWithBinding(calls, armResponse);
    delete (env as { MARFA_WORKER_IDENTITY_SECRET?: string })
      .MARFA_WORKER_IDENTITY_SECRET;
    const res = await post(
      buildApp(),
      env,
      `/connections/${CONNECTION_ID}/arm-schedule`,
      { integration_name: INTEGRATION },
    );
    expect(res.status).toBe(503);
    expect((await res.json<{ error: string }>()).error).toBe(
      "control_plane_misconfigured",
    );
    expect(calls).toHaveLength(0);
  });

  it("rejects a caller with no Authorization header", async () => {
    const calls: BindingCall[] = [];
    const env = buildEnvWithBinding(calls, armResponse);
    const res = await post(
      buildApp(),
      env,
      `/connections/${CONNECTION_ID}/arm-schedule`,
      { integration_name: "withmarfa.rss-watcher" },
      null,
    );
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("rejects a caller presenting the wrong key", async () => {
    const calls: BindingCall[] = [];
    const env = buildEnvWithBinding(calls, armResponse);
    const res = await post(
      buildApp(),
      env,
      `/connections/${CONNECTION_ID}/arm-schedule`,
      { integration_name: "withmarfa.rss-watcher" },
      "Bearer not-the-key",
    );
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("rejects when the control plane has no broker key configured", async () => {
    const res = await post(
      buildApp(),
      {},
      `/connections/${CONNECTION_ID}/arm-schedule`,
      { integration_name: "withmarfa.rss-watcher" },
    );
    expect(res.status).toBe(503);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("control_plane_misconfigured");
  });

  it("requires integration_name", async () => {
    const env = buildEnvWithBinding([], armResponse);
    const res = await post(
      buildApp(),
      env,
      `/connections/${CONNECTION_ID}/arm-schedule`,
      {},
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("missing_integration_name");
  });

  it("returns 503 when no service binding is declared for the integration", async () => {
    const env = buildEnvWithBinding([], armResponse);
    const res = await post(
      buildApp(),
      env,
      `/connections/${CONNECTION_ID}/arm-schedule`,
      { integration_name: "acme.unknown" },
    );
    expect(res.status).toBe(503);
    const body = await res.json<{
      error: string;
      integration_name: string;
    }>();
    expect(body.error).toBe("no_service_binding");
    expect(body.integration_name).toBe("acme.unknown");
  });

  it("percent-encodes the connection id into the dispatch URL", async () => {
    const calls: BindingCall[] = [];
    const env = buildEnvWithBinding(calls, armResponse);
    const res = await post(
      buildApp(),
      env,
      "/connections/conn%201%26x/arm-schedule",
      { integration_name: "withmarfa.rss-watcher" },
    );

    expect(res.status).toBe(200);
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("connection_id")).toBe("conn 1&x");
  });
});
