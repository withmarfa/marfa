import { Hono } from "hono";
import { findIntegration } from "@withmarfa/shared";
import type { ControlPlaneEnv } from "../env.js";
import { brokerAuthFailure } from "../broker-auth.js";

/**
 * Arm-schedule broker.
 *
 *   POST /connections/:connection_id/arm-schedule
 *     body: { integration_name: string }
 *
 *     Routes the request to the per-Integration Worker via service
 *     binding so the Worker can call `setAlarm()` on the per-Connection
 *     DO. Used by the server's install pipeline at install time, and
 *     can be retried by an operator if the install-time arm dropped.
 *
 *     Authenticates with the `MARFA_RUNTIME_BROKER_KEY` (same gate as
 *     `/lease/...`) so only the server can arm schedules.
 *
 *     Bounded-set assumption: each in-tree integration has a service
 *     binding declared in `wrangler.control.toml`. Marketplace
 *     integrations from third-party Workers will need a different
 *     dispatch path (HTTP fetch by Worker URL); out of scope today.
 */
export function registerArmScheduleRoute(
  app: Hono<{ Bindings: ControlPlaneEnv }>,
): void {
  app.post("/connections/:connection_id/arm-schedule", async (c) => {
    const connectionId = c.req.param("connection_id");

    if (!c.env.MARFA_RUNTIME_BROKER_KEY) {
      return c.json(
        {
          error: "control_plane_misconfigured",
          message: "MARFA_RUNTIME_BROKER_KEY must be set.",
        },
        503,
      );
    }
    const unauthorized = brokerAuthFailure(c, c.env.MARFA_RUNTIME_BROKER_KEY);
    if (unauthorized) return unauthorized;

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

    const binding = resolveServiceBinding(c.env, integrationName);
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

    const inner = new URL(
      `https://integration.invalid/arm-schedule?connection_id=${encodeURIComponent(connectionId)}`,
    );
    let res: Response;
    try {
      res = await binding.fetch(
        new Request(inner.toString(), { method: "POST" }),
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
    return c.json(
      {
        ok: res.ok,
        status: res.status,
        integration_name: integrationName,
        connection_id: connectionId,
        result: parsed,
      },
      res.ok ? 200 : 502,
    );
  });
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
