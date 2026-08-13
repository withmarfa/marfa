import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { BlobBackend } from "../storage/blob-backend.js";
import type { AppConfig } from "../config.js";
import type { MarfaAuth } from "../auth/instance.js";
import type { OidcProviderHealth } from "../auth/oidc-availability.js";

interface ComponentStatus {
  status: "ok" | "degraded" | "down";
  latency_ms?: number;
  error?: string;
  /** Per-provider detail, present only on `identity_providers`. */
  providers?: OidcProviderHealth[];
}

export function healthRoutes(
  storage: Storage,
  blobBackend: BlobBackend,
  config: AppConfig,
  getAuth?: () => MarfaAuth | undefined,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get("/", async (c) => {
    const components: Record<string, ComponentStatus> = {};
    let overall: "ok" | "degraded" = "ok";

    // Check database connectivity
    try {
      const start = performance.now();
      await storage.keys.count();
      components.database = {
        status: "ok",
        latency_ms: Math.round(performance.now() - start),
      };
    } catch (err) {
      components.database = {
        status: "down",
        error: err instanceof Error ? err.message : "unknown",
      };
      overall = "degraded";
    }

    // Check blob storage reachability
    try {
      const start = performance.now();
      await blobBackend.exists("sha256:healthcheck");
      components.blob_storage = {
        status: "ok",
        latency_ms: Math.round(performance.now() - start),
      };
    } catch (err) {
      components.blob_storage = {
        status: "down",
        error: err instanceof Error ? err.message : "unknown",
      };
      overall = "degraded";
    }

    // Federated identity providers. A provider whose discovery could not
    // be reached degrades rather than taking the server down, so this is
    // the surface that says so — without it the degradation would only
    // be visible in container output, which is the failure mode the rule
    // against silent degradation exists to prevent. Absent entirely when
    // no federated provider is configured.
    const providers = getAuth?.()?.oidcHealth() ?? [];
    if (providers.length > 0) {
      const unavailable = providers.filter((p) => p.status === "unavailable");
      components.identity_providers = {
        status: unavailable.length === 0 ? "ok" : "degraded",
        providers,
        ...(unavailable.length > 0 && {
          error: `${String(unavailable.length)} of ${String(providers.length)} unavailable: ${unavailable
            .map((p) => p.provider_id)
            .join(", ")}`,
        }),
      };
      if (unavailable.length > 0) overall = "degraded";
    }

    // Read version file (best-effort — absent in dev)
    let version: Record<string, unknown> | undefined;
    try {
      const versionPath = resolve(process.cwd(), "version.json");
      const raw = await readFile(versionPath, "utf-8");
      version = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // No version file — normal in development
    }

    return c.json({
      status: overall,
      auth_mode: config.authMode,
      components,
      ...(version && { version }),
    });
  });

  return router;
}
