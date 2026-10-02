/**
 * Sign-in page renderer for the human-facing /auth/sign-in surface.
 *
 * Server-rendered HTML, no client-side framework. One form submits to the
 * wrapper handler (`POST /auth/sign-in`), which dispatches to Better Auth's
 * JSON API and translates success/failure back into 302 redirects so the
 * no-JavaScript path works. The form is single-purpose, so its fields are
 * genuinely required and the browser validates them.
 *
 * References the shared stylesheet at `/auth/static/auth.css` via
 * the `renderAuthLayout` helper; no inline `<style>` block.
 */

import { renderAuthLayout } from "./auth-layout.js";
import { escapeHtml } from "./auth-html.js";

interface SignInPageParams {
  /**
   * Where to send the user after a successful sign-in, already passed
   * through `validateReturnTo`. Carried in the form's hidden field so it
   * survives the round-trip.
   */
  returnTo: string;
  /**
   * Error code from a previous attempt. Renders an inline error banner
   * with a friendly message. Unknown codes fall through to a generic
   * "Something went wrong" message rather than 500-ing.
   */
  error?: string;
}

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: "That email or password is wrong. Try again.",
  too_many_attempts:
    "Too many sign-in attempts. Wait a few minutes and try again.",
  missing_field: "Please fill in every field.",
  invalid_return_to:
    "That sign-in link looked unsafe, so we ignored where it pointed. Please sign in again.",
};

/** Renders the sign-in page as a complete HTML document string. */
export function renderSignInPage(params: SignInPageParams): string {
  const safeReturnTo = escapeHtml(params.returnTo);

  const errorMessage = params.error
    ? (ERROR_MESSAGES[params.error] ?? "Something went wrong. Try again.")
    : null;

  // `invalid_credentials` spans the email + password pair, so it renders as
  // an inline form-level line just above the actions, not a boxed top banner.
  const isCredentialError = params.error === "invalid_credentials";

  // Banner reserved for page-level errors not tied to a field or the
  // credential pair (e.g. invalid_return_to).
  const errorBanner =
    errorMessage && !isCredentialError
      ? `<div class="banner banner--error" role="alert">${escapeHtml(errorMessage)}</div>`
      : "";

  // Inline credential error — sits inside the form, just above the button.
  const credentialError = isCredentialError
    ? `<p class="form__error" role="alert">${escapeHtml(errorMessage ?? "")}</p>`
    : "";

  // Fields in their own `.form` flex, the primary button in a full-width
  // `.actions` block. Both fields are required (single-purpose form, so the
  // browser validates and there's no blank-password jank).
  const passwordForm = `
    <form method="POST" action="/auth/sign-in" novalidate>
      <input type="hidden" name="return_to" value="${safeReturnTo}">
      <div class="form">
        <label class="field">
          <span class="field__label">Email</span>
          <input type="email"
                 name="email"
                 required
                 autocomplete="email"
                 autofocus
                 aria-required="true">
        </label>
        <label class="field">
          <span class="field__label">Password</span>
          <input type="password"
                 name="password"
                 required
                 autocomplete="current-password"
                 aria-required="true">
        </label>
        ${credentialError}
      </div>
      <div class="actions">
        <button type="submit" class="btn btn--primary" data-loading-label="Signing in...">Sign in</button>
      </div>
    </form>
  `;

  const body = `
    <h1 class="title">Sign in to Marfa</h1>
    <p class="sub">Welcome back.</p>
    ${errorBanner}
    ${passwordForm}
    <script src="/auth/static/password-toggle.js"></script>
    <script src="/auth/static/submit-state.js"></script>
  `;

  return renderAuthLayout({
    title: "Sign in to Marfa",
    bodyHtml: body,
  });
}

/**
 * Where a sign-in may send the browser afterwards: `raw` resolved against the
 * issuer, kept only when it lands on the issuer's own origin, and answered as
 * the normalized path, query and fragment. Anything else is `/`.
 *
 * Resolved rather than pattern-matched because the browser resolves it: it
 * strips tabs and newlines and reads a backslash as a slash before it looks
 * at the URL, so `/\t/evil.example` is `//evil.example` by the time it
 * navigates. The one function every door that redirects after sign-in asks.
 */
export function validateReturnTo(raw: unknown, issuer: string): string {
  if (typeof raw !== "string" || raw.length === 0) return "/";
  let base: URL;
  let target: URL;
  try {
    base = new URL(issuer);
    target = new URL(raw, base);
  } catch {
    return "/";
  }
  if (target.origin !== base.origin) return "/";
  return `${target.pathname}${target.search}${target.hash}`;
}

/**
 * Build a synthetic `return_to` pointing back at `/auth/authorize` when
 * a request lands on `/auth/sign-in` with OAuth params on the URL
 * itself (rather than wrapped in an explicit `return_to`).
 *
 * Triggered by the @better-auth/oauth-provider plugin's `loginPage`
 * redirect: the plugin appends the full (verified, signed)
 * authorize-request query string directly onto `/auth/sign-in` when
 * the user isn't yet signed in. The Hono sign-in handler folds those
 * params back into a `/auth/authorize?…` URL so the existing
 * form-round-trip carries them through credential check.
 *
 * The page-local params (`error`, `return_to`) are stripped before
 * re-encoding — they belong to the sign-in page's UX state, not to the
 * OAuth request.
 *
 * The return value always starts with `/auth/authorize`, so it
 * satisfies `validateReturnTo`.
 */
const SIGN_IN_LOCAL_PARAMS = new Set(["error", "return_to"]);

export function synthesizeOauthReturnTo(params: URLSearchParams): string {
  const filtered = new URLSearchParams();
  for (const [key, value] of params) {
    if (SIGN_IN_LOCAL_PARAMS.has(key)) continue;
    filtered.append(key, value);
  }
  const qs = filtered.toString();
  return qs.length === 0 ? "/auth/authorize" : `/auth/authorize?${qs}`;
}
