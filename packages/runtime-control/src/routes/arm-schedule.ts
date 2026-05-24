import { Hono } from "hono";
import type { ControlPlaneEnv } from "../env.js";

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
 *     Authenticates with the `MYME_RUNTIME_BROKER_KEY` (same gate as
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

    if (!c.env.MYME_RUNTIME_BROKER_KEY) {
      return c.json(
        {
          error: "control_plane_misconfigured",
          message: "MYME_RUNTIME_BROKER_KEY must be set.",
        },
        503,
      );
    }
    const auth = c.req.header("authorization");
    if (auth !== `Bearer ${c.env.MYME_RUNTIME_BROKER_KEY}`) {
      return c.json({ error: "unauthorized" }, 401);
    }

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
 * Map a manifest-name to its service binding. The mapping is hard-
 * coded for the in-tree set; new integrations need an entry here AND
 * a binding in `wrangler.control.toml`.
 */
function resolveServiceBinding(
  env: ControlPlaneEnv,
  integrationName: string,
): { fetch(request: Request): Promise<Response> } | undefined {
  switch (integrationName) {
    case "mymehq.rss-watcher":
      return env.INTEGRATION_RSS_WATCHER;
    case "mymehq.github-webhooks":
      return env.INTEGRATION_GITHUB_WEBHOOKS;
    case "mymehq.task-auto-archive":
      return env.INTEGRATION_TASK_AUTO_ARCHIVE;
    case "google.calendar":
      return env.INTEGRATION_GOOGLE_CALENDAR;
    case "google.tasks":
      return env.INTEGRATION_GOOGLE_TASKS;
    case "google.drive":
      return env.INTEGRATION_GOOGLE_DRIVE;
    case "google.contacts":
      return env.INTEGRATION_GOOGLE_CONTACTS;
    case "todoist.tasks":
      return env.INTEGRATION_TODOIST_TASKS;
    default:
      return undefined;
  }
}
