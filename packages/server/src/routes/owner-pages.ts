import { Hono } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { MarfaAuth } from "../auth/instance.js";
import { requireSecureOwnerTransport } from "../auth/owner-browser.js";
import { accountPages } from "./account-pages.js";
import { consoleGate } from "./console-gate.js";
import { managementPages } from "./management-pages.js";
import { setNoStore } from "./no-store.js";

export function ownerPages(storage: Storage, auth: MarfaAuth) {
  const router = new Hono<AppEnv>();
  router.use("*", async (c, next) => {
    setNoStore(c);
    requireSecureOwnerTransport(auth);
    await next();
  });
  router.use("*", consoleGate(storage, auth));
  router.route("/", accountPages(storage, auth));
  router.route("/", managementPages(storage));
  return router;
}
