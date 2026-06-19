/**
 * Sign-in page renderer for the human-facing /auth/sign-in surface.
 *
 * Server-rendered HTML, no client-side framework. One combined form
 * submits to the wrapper handler (`POST /auth/sign-in`), which dispatches
 * to Better Auth's JSON API and translates success/failure back into 302
 * redirects so the no-JavaScript path works.
 *
 * Two single-purpose views, selected by `?mode`. The default (`password`)
 * view is email + password. The one-time email link is its own focused
 * screen (`mode=magic`) — just an email field — reached via a link that
 * carries `return_to` so the OAuth round-trip survives the hop. Because each
 * form is single-purpose its fields are genuinely required, so the browser
 * validates them (no `novalidate`, no submitting a password form with a blank
 * password). A passkey button (revealed only on capable browsers) and any
 * configured OIDC providers sit under the password view's alternatives stack.
 *
 * References the shared stylesheet at `/auth/static/auth.css` via
 * the `renderAuthLayout` helper; no inline `<style>` block.
 */

import { renderAuthLayout } from "./auth-layout.js";
import { escapeHtml, buildQuery } from "./auth-html.js";

interface SignInPageParams {
  /**
   * Which view to render: `password` (default — email + password) or
   * `magic` (the focused one-time-email screen). The GET handler parses it
   * from `?mode`; the POST handler preserves it across redirects.
   */
  mode?: "password" | "magic";
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
    "That sign-in link looked unsafe, so we ignored where it pointed. Please sign in again.",
};

/** Renders the sign-in page as a complete HTML document string. */
export function renderSignInPage(params: SignInPageParams): string {
  const safeReturnTo = escapeHtml(params.returnTo);

  const errorMessage = params.error
    ? (ERROR_MESSAGES[params.error] ?? "Something went wrong. Try again.")
    : null;

  const isMagic = params.mode === "magic";

  // `invalid_credentials` spans the email + password pair, so on the password
  // view it renders as an inline form-level line just above the actions, not a
  // boxed top banner.
  const isCredentialError = params.error === "invalid_credentials" && !isMagic;

  // On the one-time-email view the only field is email, so any error there is
  // rendered under that field rather than as a top banner.
  const magicFieldError = errorMessage && isMagic ? errorMessage : null;

  // Banner reserved for page-level errors not tied to a field or the
  // credential pair (e.g. invalid_return_to, oauth_failed) on the password
  // view. The magic view routes its errors to the field instead.
  const errorBanner =
    errorMessage && !isCredentialError && !isMagic
      ? `<div class="banner banner--error" role="alert">${escapeHtml(errorMessage)}</div>`
      : "";

  // Inline credential error — sits inside the form, just above the button.
  const credentialError = isCredentialError
    ? `<p class="form__error" role="alert">${escapeHtml(errorMessage ?? "")}</p>`
    : "";

  // Password view form — fields in their own `.form` flex, the primary button
  // in a full-width `.actions` block (matching sign-up). Both fields are
  // required (single-purpose form, so the browser validates and there's no
  // blank-password jank).
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
        <button type="submit" name="mode" value="password" class="btn btn--primary" data-loading-label="Signing in...">Sign in</button>
      </div>
    </form>
  `;

  // One-time-email view form — just an email field; the server emails a link.
  // A magic-view error lands under the field.
  const magicFieldErrorHtml = magicFieldError
    ? `<span class="field__error" role="alert">${escapeHtml(magicFieldError)}</span>`
    : "";
  const magicForm = `
    <form method="POST" action="/auth/sign-in" class="form" novalidate>
      <input type="hidden" name="return_to" value="${safeReturnTo}">
      <label class="field${magicFieldError ? " field--error" : ""}">
        <span class="field__label">Email</span>
        <input type="email"
               name="email"
               required
               autocomplete="email"
               autofocus
               aria-required="true">
        ${magicFieldErrorHtml}
      </label>
      <div class="actions">
        <button type="submit" name="mode" value="magic" class="btn btn--primary" data-loading-label="Sending link...">Email me a sign-in link</button>
      </div>
    </form>
  `;

  // Switch to the one-time-email view via a GET form (a real navigation that
  // works without JS). The browser URL-encodes the hidden fields, so the OAuth
  // context folded into `return_to` survives the hop. Styled as a plain `.btn`
  // so it flexes equally inside the alternatives row.
  const oneTimeLinkButton = `
    <form method="GET" action="/auth/sign-in">
      <input type="hidden" name="mode" value="magic">
      <input type="hidden" name="return_to" value="${safeReturnTo}">
      <button type="submit" class="btn">One-time link</button>
    </form>
  `;
  // Back link to the password view — a plain text link is the right weight.
  const toPasswordHref = `/auth/sign-in?${buildQuery({ return_to: params.returnTo })}`;

  // Federated provider buttons, rendered as full-width stacked pills BELOW the
  // two-button alternatives row. The default/hosted case has none.
  const oidcButtons = params.oidcProviderIds
    .map(
      (id) => `
        <form method="POST" action="/auth/sign-in/provider/${escapeHtml(id)}">
          <input type="hidden" name="return_to" value="${safeReturnTo}">
          <button type="submit" class="btn btn--oidc">Continue with ${escapeHtml(toHumanProvider(id))}</button>
        </form>
      `,
    )
    .join("");

  const oidcStack =
    oidcButtons.length > 0
      ? `<div class="oidc" style="margin-top:16px">${oidcButtons}</div>`
      : "";

  const signupLink = params.allowSignup
    ? `<p class="aux">No account yet?
         <a href="/auth/sign-up?${buildQuery({ return_to: params.returnTo })}">Create one</a>
       </p>`
    : "";

  // Passkey button — hidden by default, revealed by the inline script only on
  // browsers that support WebAuthn in a secure context. Sits in the
  // alternatives row next to "One-time link"; when hidden the row collapses to
  // "One-time link" filling the full width. The script lives inline (rather
  // than in passkey.js) because it needs `params.returnTo` to redirect on
  // success.
  const passkeyButton = `
    <div id="passkey-block" hidden>
      <button id="passkey-signin" type="button" class="btn">Passkey</button>
    </div>
  `;
  // The passkey error sits below the alternatives row, not inside it, so the
  // flex row stays a clean two-button layout.
  const passkeyError = `<div id="passkey-error" class="banner banner--error" role="alert" hidden style="margin-top:12px"></div>`;

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
      var info = window.MarfaPasskey.describeError(err, 'signin');
      // A cancel / timeout is the user's choice — no scary banner, just re-enable.
      if (!info.cancelled) setError(info.message);
      btn.disabled = false;
    }
  });
})();
  `.trim();

  // Password view: email + password + the primary button, then an
  // "Or continue with" separator, then a two-button alternatives row
  // ("One-time link" + "Passkey", the latter revealed only when supported),
  // then any federated providers, then the optional sign-up link.
  const passwordBody = `
    <h1 class="title">Sign in to Marfa</h1>
    <p class="sub">Welcome back.</p>
    ${errorBanner}
    ${passwordForm}
    <div class="separator">Or continue with</div>
    <div class="alts">
      ${oneTimeLinkButton}
      ${passkeyButton}
    </div>
    ${passkeyError}
    ${oidcStack}
    ${signupLink}
    <script src="/auth/static/passkey.js"></script>
    <script>${passkeyScript}</script>
    <script src="/auth/static/password-toggle.js"></script>
    <script src="/auth/static/submit-state.js"></script>
  `;

  // One-time-email view: a focused screen with just the email field and a way
  // back to the password form.
  const magicBody = `
    <h1 class="title">Sign in to Marfa</h1>
    <p class="sub">We'll email you a one-time sign-in link. No password needed.</p>
    ${magicForm}
    <p class="aux"><a href="${toPasswordHref}">Back to password sign-in</a></p>
    <script src="/auth/static/submit-state.js"></script>
  `;

  // Confirmation screen after a one-time link is sent — its own focused view,
  // not a banner stacked on the entry form.
  const sentBody = `
    <h1 class="title">Check your email</h1>
    <p class="sub" role="status">A one-time sign-in link is on its way. Open it to finish signing in.</p>
    <div class="actions">
      <a href="/auth/sign-in?${buildQuery({ mode: "magic", return_to: params.returnTo })}" class="btn btn--outline">Use a different email</a>
    </div>
    <p class="aux"><a href="${toPasswordHref}">Use a password instead</a></p>
  `;

  const body = params.magicLinkSent
    ? sentBody
    : isMagic
      ? magicBody
      : passwordBody;

  return renderAuthLayout({
    title: params.magicLinkSent ? "Check your email" : "Sign in to Marfa",
    bodyHtml: body,
  });
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
