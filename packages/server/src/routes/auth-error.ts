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

/**
 * Friendly copy per OAuth error code. The raw protocol token is never shown to
 * the user; an unknown code falls back to the generic line below.
 */
const ERROR_MESSAGES: Record<string, string> = {
  invalid_client:
    "We couldn't recognize the app you came from, so sign-in didn't start. This usually clears up on its own — head back and sign in again.",
  invalid_request:
    "Something about that sign-in link was off. Head back and sign in again.",
  invalid_scope:
    "The app asked for a permission this space doesn't offer. Head back and sign in again.",
  unsupported_response_type:
    "The app started sign-in in a way this space doesn't support. Head back and sign in again.",
  access_denied: "Sign-in was cancelled.",
  server_error:
    "Something went wrong on our end while signing you in. Please try again.",
  temporarily_unavailable:
    "Sign-in is briefly unavailable. Give it a moment and try again.",
};

const GENERIC_MESSAGE =
  "We couldn't finish signing you in. Head back and sign in again.";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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
    <h1 class="title">Sign-in didn't finish</h1>
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
