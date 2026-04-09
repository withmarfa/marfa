import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { BlobBackend } from "../storage/blob-backend.js";
import type { AppConfig } from "../config.js";

interface ComponentStatus {
  status: "ok" | "degraded" | "down";
  latency_ms?: number;
  error?: string;
}

export function healthRoutes(
  storage: Storage,
  blobBackend: BlobBackend,
  config: AppConfig,
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
