import { Hono } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import type { AppConfig } from "../config.js";
import type { Storage } from "../storage/interface.js";
import type { MarfaAuth } from "../auth/instance.js";
import { requireSecureOwnerTransport } from "../auth/owner-browser.js";
import { accountPages } from "./account-pages.js";
import { appRoutes } from "./app-routes.js";
import { browserRoutes } from "./browser-routes.js";
import type { ConsoleHealth } from "./console-health.js";
import { activityRoutes } from "./activity-routes.js";
import { connectorRoutes } from "./connector-routes.js";
import { consoleGate } from "./console-gate.js";
import { exportPage } from "./export-routes.js";
import { generalRoutes } from "./general-routes.js";
import { healthPageRoutes } from "./health-page-routes.js";
import { trashPageRoutes } from "./trash-page-routes.js";
import { itemPageRoutes } from "./item-page-routes.js";
import { keyRoutes } from "./key-routes.js";
import { setNoStore } from "./no-store.js";
import { settingsRoutes } from "./settings-routes.js";

export function ownerPages(
  storage: Storage,
  auth: MarfaAuth,
  view: { config: AppConfig; health: ConsoleHealth },
) {
  const router = new Hono<AppEnv>();
  router.use("*", async (c, next) => {
    setNoStore(c);
    requireSecureOwnerTransport(auth);
    await next();
  });
  router.use("*", consoleGate(storage, auth));
  router.route("/", accountPages(storage, auth));
  router.route("/", itemPageRoutes(storage));
  router.route("/", trashPageRoutes(storage, view.config));
  router.route("/", keyRoutes(storage));
  router.route("/", appRoutes(storage));
  router.route("/", browserRoutes(storage, auth));
  router.route("/", generalRoutes(storage, view.config));
  router.route("/", healthPageRoutes(storage, view.health));
  router.route("/", activityRoutes(storage, view.config));
  router.route("/", settingsRoutes(storage, view.config));
  router.route("/", connectorRoutes(storage));
  router.route("/", exportPage(storage));
  return router;
}
