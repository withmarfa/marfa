import { Hono } from "hono";
import type { ControlPlaneEnv } from "./env.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerLeaseRoutes } from "./routes/lease.js";
import { registerInstallCallbackRoute } from "./routes/install-callback.js";
import { registerArmScheduleRoute } from "./routes/arm-schedule.js";

export const VERSION = "0.0.1";

/**
 * Builds the Hono app for the control plane. Exported as a factory so
 * tests can mount it without going through the Worker `fetch` entry.
 */
export function buildApp(): Hono<{ Bindings: ControlPlaneEnv }> {
  const app = new Hono<{ Bindings: ControlPlaneEnv }>();

  registerHealthRoute(app, VERSION);
  registerWebhookRoutes(app);
  registerLeaseRoutes(app);
  registerInstallCallbackRoute(app);
  registerArmScheduleRoute(app);

  app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));

  app.onError((err, c) => {
    return c.json(
      {
        error: "internal_error",
        message: err instanceof Error ? err.message : "unknown error",
      },
      500,
    );
  });

  return app;
}
