import { directAuthorityMiddleware } from "../middleware/direct-authority.js";
import { loadConfig } from "../config.js";
import { issueSetupCode } from "./instance-claim.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { createMarfaAuth } from "./instance.js";
import { ownerRoutes } from "../routes/owner.js";
import { setupRoutes } from "../routes/setup.js";
import { authRoutes } from "../routes/auth-pages.js";
import { authStaticRoutes } from "../routes/auth-static.js";
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
    apiKeySalt: "claim-route-test-salt",
    baseURL,
    secret: "claim-route-test-secret-at-least-thirty-two-characters",
  });
  await auth.ready;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("config", loadConfig({ MARFA_AUTH_BASE_URL: baseURL }));
    await next();
  });
  app.use("*", pageSecurityPolicy);
  app.use("*", loggerMiddleware());
  app.onError(createErrorHandler({ errorWebhookUrl: "" }));
  app.use("*", directAuthorityMiddleware(storage, auth, baseURL));
  app.route("/setup", setupRoutes(storage, auth));
  app.route("/owner", ownerRoutes(storage, auth));
  app.route("/auth/owner", ownerPages(storage, auth));
  app.route("/auth/static", authStaticRoutes());
  app.route("/auth", authRoutes(storage, auth));
  app.all("/auth/*", (c) => auth.handler(c.req.raw, "127.0.0.1"));
  const { code: setupCode } = await issueSetupCode(storage);
  return {
    setupCode,
    app,
    storage,
    auth,
    cleanup: async () => {
      await storage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
