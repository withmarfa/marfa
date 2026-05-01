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
 */

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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in to Myme</title>
  <style>${STYLES}</style>
</head>
<body>
  <main class="card" aria-labelledby="page-title">
    <h1 id="page-title">Sign in to Myme</h1>
    ${errorBanner}
    ${successBanner}
    ${tabsHtml}
    ${activeForm}
    ${oidcButtons}
    ${signupLink}
  </main>
</body>
</html>`;
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

const STYLES = `
  :root {
    color-scheme: light;
    --bg: #fafaf8;
    --card: #ffffff;
    --ink: #1a1a1a;
    --ink-soft: #555;
    --ink-faint: #999;
    --border: #e2e2dc;
    --accent: #1a1a1a;
    --accent-hover: #333;
    --error-bg: #fdecec;
    --error-border: #f5b8b8;
    --error-ink: #842424;
    --success-bg: #ecf6e9;
    --success-border: #b8d8af;
    --success-ink: #2a5a1f;
  }
  * { box-sizing: border-box; }
  body {
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    margin: 0;
    padding: 24px;
    background: var(--bg);
    color: var(--ink);
    min-height: 100vh;
    display: grid;
    place-items: center;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 32px;
    width: 100%;
    max-width: 420px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 24px; letter-spacing: -0.01em; }
  .banner {
    margin: 0 0 16px;
    padding: 10px 12px;
    border-radius: 6px;
    border: 1px solid;
    font-size: 13px;
    line-height: 1.4;
  }
  .banner--error { background: var(--error-bg); border-color: var(--error-border); color: var(--error-ink); }
  .banner--success { background: var(--success-bg); border-color: var(--success-border); color: var(--success-ink); }
  .tabs {
    display: flex;
    gap: 4px;
    margin: 0 0 20px;
    border-bottom: 1px solid var(--border);
  }
  .tab {
    padding: 8px 12px;
    color: var(--ink-soft);
    text-decoration: none;
    font-size: 13px;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .tab:hover { color: var(--ink); }
  .tab--active { color: var(--ink); border-bottom-color: var(--ink); font-weight: 500; }
  .form { display: flex; flex-direction: column; gap: 14px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field__label { font-size: 13px; color: var(--ink-soft); font-weight: 500; }
  .field__hint { font-size: 12px; color: var(--ink-faint); margin: 0; }
  input[type="email"], input[type="password"] {
    font: inherit;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--card);
    color: var(--ink);
    width: 100%;
  }
  input[type="email"]:focus, input[type="password"]:focus {
    outline: 2px solid var(--ink);
    outline-offset: 1px;
    border-color: var(--ink);
  }
  .btn {
    font: inherit;
    padding: 10px 16px;
    border-radius: 6px;
    border: 1px solid var(--ink);
    cursor: pointer;
    font-weight: 500;
  }
  .btn--primary { background: var(--accent); color: var(--card); }
  .btn--primary:hover { background: var(--accent-hover); }
  .btn--oidc { background: var(--card); color: var(--ink); width: 100%; }
  .btn--oidc:hover { background: var(--bg); }
  .btn:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  .separator {
    display: flex;
    align-items: center;
    text-align: center;
    margin: 20px 0 12px;
    color: var(--ink-faint);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .separator::before, .separator::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }
  .separator span { padding: 0 12px; }
  .oidc { display: flex; flex-direction: column; gap: 8px; }
  .oidc form { margin: 0; }
  .aux {
    margin: 20px 0 0;
    text-align: center;
    font-size: 13px;
    color: var(--ink-soft);
  }
  .aux a { color: var(--ink); }
`;
