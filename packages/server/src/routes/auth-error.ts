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
import { renderAuthLayout } from "./auth-layout.js";
import { setNoStore } from "./no-store.js";
import { escapeHtml } from "./auth-html.js";

/**
 * Friendly copy per OAuth error code. The raw protocol token is never shown to
 * the user; an unknown code falls back to the generic line below.
 */
const ERROR_MESSAGES: Record<string, string> = {
  invalid_client:
    "We didn't recognize the app that sent you here, so nothing was shared.",
  invalid_request: "That sign-in link was incomplete.",
  invalid_scope: "That app asked for something this server doesn't offer.",
  unsupported_response_type:
    "That app started sign-in in a way this server doesn't support.",
  access_denied: "You canceled sign-in. Nothing was shared.",
  server_error: "Something failed on our side while signing you in.",
  temporarily_unavailable:
    "Sign-in is briefly unavailable. It usually returns within a minute.",
};

const GENERIC_MESSAGE = "We couldn't finish signing you in.";

/**
 * Render the OAuth error page as a complete HTML document. Pure (the route
 * handler is the only caller) so the copy is unit-testable without booting the
 * app. The raw error code is only ever used as a lookup key into the curated
 * message map — it is never reflected into the output.
 */
export function renderAuthErrorPage(errorCode: string | null): string {
  const message = errorCode
    ? (ERROR_MESSAGES[errorCode] ?? GENERIC_MESSAGE)
    : GENERIC_MESSAGE;
  const body = `
    <h1 class="title">Couldn't sign you in</h1>
    <p class="sub">${escapeHtml(message)}</p>
    <div class="actions">
      <a href="/auth/sign-in" class="btn btn--primary">Back to sign in</a>
    </div>
  `;
  return renderAuthLayout({ title: "Sign-in error", bodyHtml: body });
}

/** Hono sub-app exposing `GET /auth/error`. Mount before the better-auth
 *  catch-all so it wins over core's production redirect-to-root. */
export function authErrorRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/error", (c) => {
    const errorCode = new URL(c.req.url).searchParams.get("error");
    setNoStore(c);
    return c.html(renderAuthErrorPage(errorCode));
  });
  return app;
}
