import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { createMarfaAuth } from "./instance.js";
import { ownerRoutes } from "../routes/owner.js";
import { setupRoutes } from "../routes/setup.js";
import { ownerPages } from "../routes/owner-pages.js";
import { pageSecurityPolicy } from "../routes/content-security-policy.js";
import { createErrorHandler } from "../middleware/error-handler.js";
import { loggerMiddleware } from "../middleware/logger.js";

export async function createClaimTestApp(baseURL = "http://localhost:8600") {
  const directory = await mkdtemp(join(tmpdir(), "marfa-claim-routes-"));
  const storage = await createSqliteStorage(join(directory, "db.sqlite"));
  const auth = createMarfaAuth({
    db: storage.betterAuthDb as Parameters<typeof createMarfaAuth>[0]["db"],
    storage,
    baseURL,
    secret: "claim-route-test-secret-at-least-thirty-two-characters",
  });
  await auth.ready;
  const app = new Hono<AppEnv>();
  app.use("*", pageSecurityPolicy);
  app.use("*", loggerMiddleware());
  app.onError(createErrorHandler({ errorWebhookUrl: "" }));
  app.route("/setup", setupRoutes(storage, auth));
  app.route("/owner", ownerRoutes(storage, auth));
  app.route("/auth/owner", ownerPages(storage, auth));
  app.all("/auth/*", (c) => auth.handler(c.req.raw, "127.0.0.1"));
  return {
    app,
    storage,
    auth,
    cleanup: async () => {
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
