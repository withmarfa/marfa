import { Hono } from "hono";
import { z } from "@hono/zod-openapi";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { MarfaAuth } from "../auth/instance.js";
import type { Storage } from "../storage/interface.js";
import type { AppEnv } from "../middleware/auth.js";
import {
  claimOwner,
  exchangeSetupCode,
  exchangeSetupTicket,
  getClaimStatus,
  hasSetupSession,
} from "../auth/instance-claim.js";
import {
  requireOwnerOrigin,
  requireSecureOwnerTransport,
} from "../auth/owner-browser.js";
import { readInstanceName } from "../instance-name.js";
import { renderAuthLayout } from "./auth-layout.js";
import { escapeHtml } from "./auth-html.js";
import { ownerWire } from "./owner-wire.js";
import { contentSecurityPolicy } from "./content-security-policy.js";
import { setNoStore } from "./no-store.js";
import { refuseUnknownBodyKeys } from "./_unknown-body-keys.js";

export const SETUP_COOKIE = "marfa.setup";

/**
 * The fields the two setup doors read from a JSON body. The doors are not in
 * the published document, so these are the only declaration of them, and
 * they are what an undeclared key is judged against.
 */
const ExchangeBody = z.object({ ticket: z.string(), code: z.string() });
const ClaimBody = z.object({
  email: z.string(),
  password: z.string(),
  name: z.string(),
  code: z.string(),
});

export function setupRoutes(storage: Storage, auth: MarfaAuth) {
  const router = new Hono<AppEnv>();
  router.use("*", async (c, next) => {
    setNoStore(c);
    requireSecureOwnerTransport(auth);
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });
  router.get("/", async (c) => {
    c.header(
      "Content-Security-Policy",
      `${contentSecurityPolicy(c.var.cspNonce)}; connect-src 'self'; form-action 'self'`,
    );
    const instanceName = await readInstanceName(storage.settings);
    const safeName = escapeHtml(instanceName);
    const claimed = (await getClaimStatus(storage)).claimed;
    const setupReady = await hasSetupSession(
      storage,
      getCookie(c, SETUP_COOKIE) ?? "",
    );
    const body = claimed
      ? `<h1>${safeName} is ready</h1><p>${safeName} has already been claimed.</p><a href="/auth/sign-in">Sign in</a>`
      : `<h1>Set up ${safeName}</h1>
<p>Use the setup code from the machine running Marfa, or open a new setup link there.</p>
<p id="status" role="status"></p>
<form id="code-form"${setupReady ? " hidden" : ""}><label for="code">Setup code</label><input id="code" name="code" autocomplete="off" required><button type="submit">Continue</button></form>
<form id="owner-form"${setupReady ? "" : " hidden"}><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required><label for="name">Name</label><input id="name" name="name" maxlength="200" autocomplete="name"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" required><button type="submit">Create owner</button></form>
<script nonce="${escapeHtml(c.var.cspNonce)}">
(() => {
  let handoff = new URLSearchParams(location.hash.slice(1)).get('handoff');
  history.replaceState(null, '', location.pathname);
  const status = document.getElementById('status'), codeForm = document.getElementById('code-form'), ownerForm = document.getElementById('owner-form');
  async function send(path, data) {
    const response = await fetch(path, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),credentials:'same-origin',cache:'no-store'});
    if (!response.ok) { const value=await response.json(); throw new Error(value.error?.message || 'Setup could not complete. Try again.'); }
    return response;
  }
  async function exchange(data) {
    try { await send('/setup/exchange',data); codeForm.hidden=true; ownerForm.hidden=false; status.textContent='Setup authorised. Enter your owner details.'; }
    catch(error) { status.textContent=error.message; }
  }
  if(handoff) { const ticket=handoff; handoff=null; void exchange({ticket}); }
  codeForm.addEventListener('submit',event=>{event.preventDefault();const code=codeForm.elements.code.value;codeForm.reset();void exchange({code});});
  ownerForm.addEventListener('submit',async event=>{event.preventDefault();const data=Object.fromEntries(new FormData(ownerForm));try {await send('/owner',data);ownerForm.reset();location.replace('/auth/sign-in');} catch(error){status.textContent=error.message;ownerForm.elements.password.value='';}});
})();
</script>`;
    return c.html(
      renderAuthLayout({
        nonce: c.var.cspNonce,
        title: `Set up ${instanceName}`,
        bodyHtml: body,
      }),
    );
  });
  router.post("/exchange", async (c) => {
    requireOwnerOrigin(auth, c.req.raw.headers);
    const body = await c.req.json<{ ticket?: unknown; code?: unknown }>();
    refuseUnknownBodyKeys(body, ExchangeBody);
    const session =
      typeof body.ticket === "string"
        ? await exchangeSetupTicket(storage, body.ticket)
        : typeof body.code === "string"
          ? await exchangeSetupCode(
              storage,
              body.code,
              c.get("clientIp") ?? null,
            )
          : null;
    if (!session)
      throw new MarfaError(
        ErrorCode.VALIDATION_ERROR,
        "Enter a setup code or open a new setup link.",
      );
    setCookie(c, SETUP_COOKIE, session.token, {
      httpOnly: true,
      secure: auth.baseURL.startsWith("https:"),
      sameSite: "Strict",
      path: "/",
      maxAge: 15 * 60,
    });
    return c.json({ ready: true });
  });
  // The HTML form fallback shares the claim operation with the JSON owner API.
  router.post("/claim", async (c) => {
    requireOwnerOrigin(auth, c.req.raw.headers, { allowNonBrowser: true });
    const isJson = c.req.header("content-type")?.includes("application/json");
    const body = isJson
      ? await c.req.json<Record<string, string>>()
      : await c.req.parseBody<Record<string, string>>();
    if (isJson) refuseUnknownBodyKeys(body, ClaimBody);
    const token = getCookie(c, SETUP_COOKIE);
    const owner = await claimOwner(storage, auth, {
      email: body.email ?? "",
      password: body.password ?? "",
      name: body.name,
      proof:
        typeof body.code === "string"
          ? {
              kind: "code",
              code: body.code,
              address: c.get("clientIp") ?? null,
            }
          : { kind: "session", token: token ?? "" },
    });
    deleteCookie(c, SETUP_COOKIE, { path: "/" });
    return c.json(ownerWire(owner), 201);
  });
  return router;
}
