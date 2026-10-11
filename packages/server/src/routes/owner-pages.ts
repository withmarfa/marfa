import { contentSecurityPolicy } from "./content-security-policy.js";
import { escapeHtml } from "./auth-html.js";
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
  router.get("/passkeys", async (c) => {
    await requireOwnerSession(storage, auth, c.req.raw.headers);
    c.header(
      "Content-Security-Policy",
      `${contentSecurityPolicy(c.var.cspNonce)}; connect-src 'self'; form-action 'self'`,
    );
    return c.html(
      renderAuthLayout({
        nonce: c.var.cspNonce,
        title: "Passkeys",
        bodyHtml: `<h1>Passkeys</h1>
<p>Sign in with a passkey even when password attempts are locked. Passkeys require a secure HTTPS address, or localhost for development. Use this same address each time you sign in.</p>
<p>To add or remove a passkey, sign in within the last five minutes. <a href="/auth/sign-in?prompt=login&amp;return_to=%2Fauth%2Fowner%2Fpasskeys">Sign in again</a></p>
<ul id="passkeys"></ul>
<label for="passkey-name">Passkey name</label><input id="passkey-name" name="passkey-name" maxlength="200" autocomplete="off">
<button type="button" id="add-passkey">Add passkey</button><p id="passkey-status" role="status"></p>
<p><a href="/auth/owner/manage">Manage Marfa</a></p>
<script src="/auth/static/passkeys.js" nonce="${escapeHtml(c.var.cspNonce)}"></script>`,
      }),
    );
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
      clientAddress: c.var.clientIp ?? null,
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
