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

  const isMagic = params.mode === "magic";

  // Password view form — email + password, both required (single-purpose form,
  // so the browser validates and there's no blank-password jank).
  const passwordForm = `
    <form method="POST" action="/auth/sign-in" class="form">
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
      <button type="submit" name="mode" value="password" class="btn btn--primary">Sign in</button>
    </form>
  `;

  // One-time-email view form — just an email field; the server emails a link.
  const magicForm = `
    <form method="POST" action="/auth/sign-in" class="form">
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
      <button type="submit" name="mode" value="magic" class="btn btn--primary">Email me a sign-in link</button>
    </form>
  `;

  // Switch to the one-time-email view via a GET form (a real navigation that
  // works without JS, and renders as a plain `.btn` so it needs no new CSS —
  // the stylesheet is cached for an hour, so reusing existing classes keeps the
  // button correct even on a stale cache). The browser URL-encodes the hidden
  // fields, so the OAuth context folded into `return_to` survives the hop.
  const toMagicForm = `
    <form method="GET" action="/auth/sign-in">
      <input type="hidden" name="mode" value="magic">
      <input type="hidden" name="return_to" value="${safeReturnTo}">
      <button type="submit" class="btn btn--oidc">Email me a one-time sign-in link</button>
    </form>
  `;
  // Back link to the password view — a plain text link is the right weight.
  const toPasswordHref = `/auth/sign-in?${buildQuery({ return_to: params.returnTo })}`;

  // Provider buttons only — no separator/wrapper of their own; they share the
  // password view's single alternatives stack below.
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

  const signupLink = params.allowSignup
    ? `<p class="aux">No account yet?
         <a href="/auth/sign-up?${buildQuery({ return_to: params.returnTo })}">Create one</a>
       </p>`
    : "";

  // Passkey button — just the button (the shared stack provides the separator);
  // hidden by default and revealed by the inline script only on browsers that
  // support WebAuthn in a secure context. The script lives inline (rather than
  // in passkey.js) because it needs `params.returnTo` to redirect on success.
  const passkeyBlock = `
    <div id="passkey-block" hidden>
      <button id="passkey-signin" type="button" class="btn btn--oidc">Use a passkey</button>
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

  // Password view: email + password, then a single "or" alternatives stack
  // (one-time email link, passkey when supported, OIDC providers), then the
  // optional sign-up link and the passkey script.
  const passwordBody = `
    <h1>Sign in to Marfa</h1>
    <p class="lede">Your data layer, in one place.</p>
    ${errorBanner}
    ${successBanner}
    ${passwordForm}
    <div class="separator" role="separator" aria-orientation="horizontal">
      <span>or</span>
    </div>
    <div class="oidc">
      ${toMagicForm}
      ${passkeyBlock}
      ${oidcButtons}
    </div>
    ${signupLink}
    <script src="/auth/static/passkey.js"></script>
    <script>${passkeyScript}</script>
  `;

  // One-time-email view: a focused screen with just the email field and a way
  // back to the password form.
  const magicBody = `
    <h1>Sign in to Marfa</h1>
    <p class="lede">Enter your email and we'll send you a one-time sign-in link — no password needed.</p>
    ${errorBanner}
    ${successBanner}
    ${magicForm}
    <p class="aux"><a href="${toPasswordHref}">Back to password sign-in</a></p>
  `;

  return renderAuthLayout({
    title: "Sign in to Marfa",
    bodyHtml: isMagic ? magicBody : passwordBody,
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
