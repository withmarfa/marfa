/**
 * `/auth/error` — the page OAuth failures land on.
 *
 * The @better-auth/oauth-provider plugin redirects unrecoverable
 * authorize-time failures (chiefly `invalid_client` from an unknown or stale
 * `client_id`) to `<baseURL>/auth/error?error=...`. Marfa has no other handler
 * there, so the request falls through to Better Auth core's built-in `/error`
 * handler — which, in production (`isProduction && !customizeDefaultErrorPage`),
 * 302s to the API root and dumps the user on the raw JSON manifest with no way
 * back. Owning `/auth/error` explicitly (mounted before the better-auth
 * catch-all so this GET wins) keeps the failure on-brand and offers a route
 * back to sign-in.
 *
 * An unknown/stale `client_id` is unrecoverable by design: the server has no
 * signed `redirect_uri` to bounce back to, so the only safe affordance is
 * "start over at sign-in", not "retry this exact request".
 */
import { Hono } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import { renderAuthErrorPage } from "./auth-error-page.js";
import { setNoStore } from "./no-store.js";

/** Hono sub-app exposing `GET /auth/error`. Mount before the better-auth
 *  catch-all so it wins over core's production redirect-to-root. */
export function authErrorRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/error", (c) => {
    const errorCode = new URL(c.req.url).searchParams.get("error");
    setNoStore(c);
    return c.html(renderAuthErrorPage(errorCode, c.var.cspNonce));
  });
  return app;
}
