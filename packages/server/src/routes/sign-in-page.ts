/**
 * Sign-in page renderer for the human-facing /auth/sign-in surface.
 *
 * Server-rendered HTML, no client-side framework. The form submits to
 * the wrapper handler (`POST /auth/sign-in`) which dispatches to
 * Better Auth's JSON API and translates success/failure back into
 * 302 redirects so the no-JavaScript path works.
 *
 * Two modes (password / magic-link) are picked by the `mode` query
 * param — server-rendered "tabs" so switching modes survives form
 * navigation without client-side state.
 *
 * Wave C PR4: layout extraction. Inline `<style>` block dropped;
 * the page now references the shared stylesheet at
 * `/auth/static/auth.css` via the `renderAuthLayout` helper.
 */

import { renderAuthLayout } from "./auth-layout.js";

interface SignInPageParams {
  /** Active mode — `password` (default) or `magic`. */
  mode: "password" | "magic";
  /**
   * Where to send the user after a successful sign-in. Validated by the
   * caller — only relative paths starting with `/` are accepted. The
   * value is passed through to the form's hidden field so it survives
   * the round-trip.
   */
  returnTo: string;
  /**
   * Error code from a previous attempt. Renders an inline error banner
   * with a friendly message. Unknown codes fall through to a generic
   * "Something went wrong" message rather than 500-ing.
   */
  error?: string;
  /** Truthy when a magic-link email was just sent successfully. */
  magicLinkSent?: boolean;
  /** Whether to render the "Create an account" link. */
  allowSignup: boolean;
  /**
   * Configured federated OIDC provider IDs. Each renders as a button
   * posting to `/auth/sign-in/provider/<id>`. Empty array → no buttons.
   */
  oidcProviderIds: readonly string[];
}

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: "That email or password is wrong. Try again.",
  missing_field: "Please fill in every field.",
  signup_disabled: "New accounts are not accepted on this instance.",
  magic_send_failed:
    "We couldn't send the sign-in link. Check the address and try again.",
  oauth_failed: "Sign-in via that provider failed. Try again.",
  invalid_return_to:
    "The return address looked unsafe and was ignored. Sign in again.",
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Renders the sign-in page as a complete HTML document string. */
export function renderSignInPage(params: SignInPageParams): string {
  const isPasswordMode = params.mode !== "magic";
  const safeReturnTo = escapeHtml(params.returnTo);

  const errorMessage = params.error
    ? (ERROR_MESSAGES[params.error] ?? "Something went wrong. Try again.")
    : null;

  const errorBanner = errorMessage
    ? `<div class="banner banner--error" role="alert">${escapeHtml(errorMessage)}</div>`
    : "";

  const successBanner = params.magicLinkSent
    ? `<div class="banner banner--success" role="status">Check your email for a sign-in link.</div>`
    : "";

  const passwordHref = `/auth/sign-in?${escapeHtml(
    buildQuery({ mode: "password", return_to: params.returnTo }),
  )}`;
  const magicHref = `/auth/sign-in?${escapeHtml(
    buildQuery({ mode: "magic", return_to: params.returnTo }),
  )}`;
  const passwordSelected = isPasswordMode ? "true" : "false";
  const magicSelected = isPasswordMode ? "false" : "true";
  const tabsHtml = `
    <div class="tabs" role="tablist">
      <a class="tab ${isPasswordMode ? "tab--active" : ""}" href="${passwordHref}" role="tab" aria-selected="${passwordSelected}">Email + password</a>
      <a class="tab ${!isPasswordMode ? "tab--active" : ""}" href="${magicHref}" role="tab" aria-selected="${magicSelected}">Email me a link</a>
    </div>
  `;

  const passwordForm = `
    <form method="POST" action="/auth/sign-in" class="form" novalidate>
      <input type="hidden" name="mode" value="password">
      <input type="hidden" name="return_to" value="${safeReturnTo}">
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
      <button type="submit" class="btn btn--primary">Sign in</button>
    </form>
  `;

  const magicForm = `
    <form method="POST" action="/auth/sign-in" class="form" novalidate>
      <input type="hidden" name="mode" value="magic">
      <input type="hidden" name="return_to" value="${safeReturnTo}">
      <label class="field">
        <span class="field__label">Email</span>
        <input type="email"
               name="email"
               required
               autocomplete="email"
               autofocus
               aria-required="true">
      </label>
      <button type="submit" class="btn btn--primary">Send sign-in link</button>
      <p class="field__hint">We'll email you a one-time link. No password needed.</p>
    </form>
  `;

  const oidcButtons = params.oidcProviderIds.length
    ? `
      <div class="separator" role="separator" aria-orientation="horizontal">
        <span>or</span>
      </div>
      <div class="oidc">
        ${params.oidcProviderIds
          .map(
            (id) => `
          <form method="POST" action="/auth/sign-in/provider/${escapeHtml(id)}">
            <input type="hidden" name="return_to" value="${safeReturnTo}">
            <button type="submit" class="btn btn--oidc">Continue with ${escapeHtml(toHumanProvider(id))}</button>
          </form>
        `,
          )
          .join("")}
      </div>
    `
    : "";

  const signupLink = params.allowSignup
    ? `<p class="aux">No account yet?
         <a href="/auth/sign-up?${buildQuery({ return_to: params.returnTo })}">Create one</a>
       </p>`
    : "";

  const activeForm = isPasswordMode ? passwordForm : magicForm;

  // Wave C PR6 / T-034 — passkey sign-in button. Hidden by default
  // and revealed by the inline script only on browsers that support
  // WebAuthn AND are running in a secure context. The script lives
  // inline (rather than in passkey.js) because it needs to read
  // `params.returnTo` to redirect on success.
  const passkeyButton = `
    <div id="passkey-block" hidden>
      <div class="separator" role="separator" aria-orientation="horizontal">
        <span>or</span>
      </div>
      <div class="oidc">
        <button id="passkey-signin" type="button" class="btn btn--oidc">Use a passkey</button>
      </div>
      <div id="passkey-error" class="banner banner--error" role="alert" hidden style="margin-top:12px"></div>
    </div>
  `;

  const passkeyScript = `
(function () {
  function show(id) { var el = document.getElementById(id); if (el) el.hidden = false; }
  function hide(id) { var el = document.getElementById(id); if (el) el.hidden = true; }
  function setError(msg) {
    var el = document.getElementById('passkey-error');
    if (el) { el.textContent = msg; show('passkey-error'); }
  }
  if (!window.MarfaPasskey || !window.MarfaPasskey.isSupported()) return;
  show('passkey-block');
  var btn = document.getElementById('passkey-signin');
  if (!btn) return;
  btn.addEventListener('click', async function () {
    hide('passkey-error');
    btn.disabled = true;
    try {
      await window.MarfaPasskey.signIn();
      window.location.assign(${JSON.stringify(params.returnTo).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")});
    } catch (err) {
      setError((err && err.message) || 'Passkey sign-in failed.');
      btn.disabled = false;
    }
  });
})();
  `.trim();

  const bodyHtml = `
    <h1>Sign in to Marfa</h1>
    ${errorBanner}
    ${successBanner}
    ${tabsHtml}
    ${activeForm}
    ${oidcButtons}
    ${passkeyButton}
    ${signupLink}
    <script src="/auth/static/passkey.js"></script>
    <script>${passkeyScript}</script>
  `;

  return renderAuthLayout({
    title: "Sign in to Marfa",
    bodyHtml,
  });
}

/** Build a URL-encoded query string. Only includes truthy values. */
function buildQuery(params: Record<string, string>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value)
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return parts.join("&");
}

/**
 * Map a Better Auth provider ID to a human label. Falls back to a
 * Title-Cased version of the id if no mapping exists — instance
 * operators using exotic providers ("authentik", "keycloak") get
 * "Authentik" / "Keycloak" rather than a literal id.
 */
function toHumanProvider(id: string): string {
  const known: Record<string, string> = {
    google: "Google",
    github: "GitHub",
    apple: "Apple",
    microsoft: "Microsoft",
    gitlab: "GitLab",
  };
  if (known[id]) return known[id];
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Validate a `return_to` query param. Only same-origin relative paths
 * starting with `/` are accepted. Anything else (absolute URL,
 * protocol-relative URL, empty string) falls back to `/`.
 *
 * Exposed as a separate function so the wrapper POST handler can apply
 * the same check before issuing its 302.
 */
export function validateReturnTo(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "/";
  // Reject anything that could resolve off-origin: protocol-relative
  // (`//evil.com`), schema (`http://`, `javascript:`), or empty.
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//")) return "/";
  // Reject backslash-after-slash sequences that some browsers parse as
  // path separators on Windows / via the WHATWG URL parser (`/\evil.com`).
  if (raw.startsWith("/\\")) return "/";
  return raw;
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
 * The page-local params (`mode`, `error`, `sent`, `return_to`) are
 * stripped before re-encoding — they belong to the sign-in page's UX
 * state, not to the OAuth request.
 *
 * The return value is always same-origin (it starts with
 * `/auth/authorize?`), so it satisfies `validateReturnTo`.
 */
const SIGN_IN_LOCAL_PARAMS = new Set(["mode", "error", "sent", "return_to"]);

export function synthesizeOauthReturnTo(params: URLSearchParams): string {
  const filtered = new URLSearchParams();
  for (const [key, value] of params) {
    if (SIGN_IN_LOCAL_PARAMS.has(key)) continue;
    filtered.append(key, value);
  }
  const qs = filtered.toString();
  return qs.length === 0 ? "/auth/authorize" : `/auth/authorize?${qs}`;
}
