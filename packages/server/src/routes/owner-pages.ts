import { managementPages } from "./management-pages.js";
import { Hono } from "hono";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import type { MarfaAuth } from "../auth/instance.js";
import {
  changeOwnerPassword,
  requireOwnerSession,
} from "../auth/instance-claim.js";
import {
  requireOwnerOrigin,
  requireSecureOwnerTransport,
} from "../auth/owner-browser.js";
import { renderAuthLayout } from "./auth-layout.js";
import { setNoStore } from "./no-store.js";
export function ownerPages(storage: Storage, auth: MarfaAuth) {
  const router = new Hono<AppEnv>();
  router.use("*", async (c, next) => {
    setNoStore(c);
    requireSecureOwnerTransport(auth);
    await next();
  });
  router.get("/password", async (c) => {
    await requireOwnerSession(storage, auth, c.req.raw.headers);
    return c.html(
      renderAuthLayout({
        nonce: c.var.cspNonce,
        title: "Change password",
        bodyHtml: `<h1>Change password</h1><p>Your other browser sign-ins will end. Connected apps and keys keep their access.</p><form method="post" action="/auth/owner/password"><label for="currentPassword">Current password</label><input id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" required><label for="password">New password</label><input id="password" name="password" type="password" autocomplete="new-password" required><button type="submit">Change password</button></form>`,
      }),
    );
  });
  router.post("/password", async (c) => {
    requireOwnerOrigin(auth, c.req.raw.headers);
    const body = await c.req.parseBody();
    if (
      typeof body.currentPassword !== "string" ||
      typeof body.password !== "string"
    )
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Current and new passwords are required.",
      );
    await changeOwnerPassword(storage, auth, c.req.raw.headers, {
      currentPassword: body.currentPassword,
      password: body.password,
    });
    return c.html(
      renderAuthLayout({
        nonce: c.var.cspNonce,
        title: "Password changed",
        bodyHtml: `<h1>Password changed</h1><p>Your other browser sign-ins have ended. Connected apps and keys still have access.</p><a href="/auth/owner/password">Back</a>`,
      }),
    );
  });
  router.route("/", managementPages());
  return router;
}
