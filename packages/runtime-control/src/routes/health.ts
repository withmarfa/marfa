import { Hono } from "hono";
import type { ControlPlaneEnv } from "../env.js";

interface HealthResponse {
  ok: true;
  service: "runtime-control";
  version: string;
  environment: string;
  myme_api_url_configured: boolean;
}

export function registerHealthRoute(
  app: Hono<{ Bindings: ControlPlaneEnv }>,
  version: string,
): void {
  app.get("/health", (c) => {
    const body: HealthResponse = {
      ok: true,
      service: "runtime-control",
      version,
      environment: c.env.ENVIRONMENT ?? "unknown",
      myme_api_url_configured: Boolean(c.env.MYME_API_URL),
    };
    return c.json(body);
  });
}
