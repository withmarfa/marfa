import { Hono } from "hono";
import type { Context } from "hono";
import { findIntegration } from "@withmarfa/shared";
import type { ControlPlaneEnv } from "../env.js";
import { brokerAuthFailure } from "../broker-auth.js";
import { workerDispatchAuthorization } from "../worker-identity.js";

type ControlPlaneContext = Context<{ Bindings: ControlPlaneEnv }>;

/**
 * Schedule arm / disarm broker.
 *
 *   POST /connections/:connection_id/arm-schedule
 *   POST /connections/:connection_id/disarm-schedule
 *     body: { integration_name: string }
 *
 *     Routes the request to the per-Integration Worker via service
 *     binding so the Worker can call `setAlarm()` / `deleteAlarm()` on
 *     the per-Connection DO. Arm is used by the server's install
 *     pipeline; disarm by the uninstall pipeline. Either can be retried
 *     by an operator if the pipeline-time call dropped.
 *
 *     Both authenticate their caller with `MARFA_RUNTIME_BROKER_KEY`,
 *     so only the Marfa server can change schedule state. That is the
 *     inbound credential only: what travels onward to the Worker is a
 *     key derived for that Worker alone, so a dispatch never hands a
 *     platform credential to code the control plane does not own.
 *
 *     Disarm is idempotent end to end: the DO's `deleteAlarm()` on an
 *     unarmed alarm is a no-op, so disarming a never-armed or
 *     already-disarmed schedule returns success. An integration that
 *     ships no Worker (local-substrate only) can hold no alarm at all,
 *     so that too is success rather than an error.
 *
 *     Bounded-set assumption: each in-tree integration has a service
 *     binding declared in `wrangler.control.toml`. Marketplace
 *     integrations from third-party Workers will need a different
 *     dispatch path (HTTP fetch by Worker URL); out of scope today.
 */
export function registerArmScheduleRoute(
  app: Hono<{ Bindings: ControlPlaneEnv }>,
): void {
  app.post("/connections/:connection_id/arm-schedule", (c) =>
    handleScheduleDispatch(c, "arm"),
  );
  app.post("/connections/:connection_id/disarm-schedule", (c) =>
    handleScheduleDispatch(c, "disarm"),
  );
}

type ScheduleAction = "arm" | "disarm";

async function handleScheduleDispatch(
  c: ControlPlaneContext,
  action: ScheduleAction,
): Promise<Response> {
  const connectionId = c.req.param("connection_id") ?? "";
  const env = c.env;

  if (!env.MARFA_RUNTIME_BROKER_KEY) {
    return c.json(
      {
        error: "control_plane_misconfigured",
        message: "MARFA_RUNTIME_BROKER_KEY must be set.",
      },
      503,
    );
  }
  // Inbound gate is the platform broker key: the Marfa server's install
  // and uninstall pipelines are the callers, and both hold it. What goes
  // outbound to the Worker is a different credential entirely — see the
  // dispatch below.
  const unauthorized = await brokerAuthFailure(c, env.MARFA_RUNTIME_BROKER_KEY);
  if (unauthorized) return unauthorized;
  if (!env.MARFA_WORKER_IDENTITY_SECRET) {
    return c.json(
      {
        error: "control_plane_misconfigured",
        message: "MARFA_WORKER_IDENTITY_SECRET must be set.",
      },
      503,
    );
  }
  const workerIdentitySecret = env.MARFA_WORKER_IDENTITY_SECRET;

  let body: { integration_name?: string };
  try {
    body = await c.req.json<{ integration_name?: string }>();
  } catch {
    body = {};
  }
  const integrationName = body.integration_name;
  if (!integrationName) {
    return c.json({ error: "missing_integration_name" }, 400);
  }

  const entry = findIntegration(integrationName);
  if (action === "disarm" && entry && !entry.serviceBinding) {
    // Known integration that deploys no Worker — there is no Durable
    // Object and therefore no alarm. Reporting 503 here would make an
    // uninstall look broken when nothing was ever armed.
    return c.json(
      {
        ok: true,
        dispatched: false,
        reason: "no_worker",
        integration_name: integrationName,
        connection_id: connectionId,
      },
      200,
    );
  }

  const binding = resolveServiceBinding(env, integrationName);
  if (!binding) {
    return c.json(
      {
        error: "no_service_binding",
        message: `No service binding declared for integration ${integrationName}.`,
        integration_name: integrationName,
      },
      503,
    );
  }

  const path = action === "arm" ? "arm-schedule" : "disarm-schedule";
  const inner = new URL(
    `https://integration.invalid/${path}?connection_id=${encodeURIComponent(connectionId)}`,
  );
  if (action === "disarm") {
    inner.searchParams.set("reason", "uninstall");
  }
  // The per-Integration Worker authenticates its whole fetch surface on
  // its own identity key. Without this header the dispatch is refused and
  // the uninstall pipeline reads the refusal as "the alarm could not be
  // cancelled" — a schedule left ticking on a revoked connection.
  //
  // Derived for the integration this dispatch is addressed to, so the
  // Worker receives only the key it already holds. The platform broker
  // key used to travel on this hop; sending it meant every Worker in the
  // fleet held a credential that mints against any Connection in any
  // tenant. `MARFA_WORKER_IDENTITY_SECRET` is proven non-empty by the 503
  // guard at the top of this handler.
  const dispatchAuthorization = await workerDispatchAuthorization(
    workerIdentitySecret,
    integrationName,
  );
  let res: Response;
  try {
    res = await binding.fetch(
      new Request(inner.toString(), {
        method: "POST",
        headers: { authorization: dispatchAuthorization },
      }),
    );
  } catch (err) {
    return c.json(
      {
        error: "binding_fetch_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  const envelope = {
    ok: res.ok,
    dispatched: true,
    status: res.status,
    integration_name: integrationName,
    connection_id: connectionId,
    result: parsed,
  };
  if (!res.ok) {
    // Package convention: every error carries an `error` code. Without
    // one, a caller matching on the code has to fall back to sniffing
    // the status, which is exactly the guesswork the convention exists
    // to remove. The Worker's own response stays on `result`.
    return c.json({ error: "dispatch_failed", ...envelope }, 502);
  }
  return c.json(envelope, 200);
}

/**
 * Map a manifest-name to its service binding via the in-tree
 * integration registry (`@withmarfa/shared` → `IN_TREE_INTEGRATIONS`).
 * Adding a new integration means adding one registry entry — the
 * dispatch here picks it up automatically. Marketplace integrations
 * (out of the in-tree set) surface as `no_service_binding` (503) at
 * the call site, same as before.
 */
function resolveServiceBinding(
  env: ControlPlaneEnv,
  integrationName: string,
): { fetch(request: Request): Promise<Response> } | undefined {
  const entry = findIntegration(integrationName);
  if (!entry?.serviceBinding) return undefined;
  return (env as Record<string, unknown>)[entry.serviceBinding] as
    | { fetch(request: Request): Promise<Response> }
    | undefined;
}
