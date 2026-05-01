import { Hono } from "hono";
import type { ControlPlaneEnv } from "../env.js";

/**
 * Install-time callback. Layer 2 (install pipeline) wires this to
 * receive the OAuth code-exchange result back from the user's browser
 * after a Connection install flow, persist the OAuth provider config
 * onto a `system.credential` (replacing PR 6's plaintext-on-
 * configuration storage), and finalise the `system.connection` row.
 */
export function registerInstallCallbackRoute(
  app: Hono<{ Bindings: ControlPlaneEnv }>,
): void {
  app.post("/install-callback", (c) => {
    return c.json(
      {
        error: "not_implemented",
        message:
          "Install callback lands in Layer 2; routes the OAuth code-exchange + system.credential mint.",
      },
      501,
    );
  });
}
