/**
 * Sign-up page renderer for the human-facing /auth/sign-up surface.
 *
 * Server-rendered HTML, no client-side framework. Posts to the wrapper
 * handler (`POST /auth/sign-up`) which dispatches to Better Auth's JSON
 * API (`POST /auth/sign-up/email`) and translates the response back to
 * a 302 redirect.
 *
 * Conditional surface — the GET handler returns 404 when
 * `MYME_AUTH_ALLOW_SIGNUP=false`. Single-user self-hosted instances
 * flip the flag on for the initial admin account, then back off.
 *
 * autoSignIn is enabled in the Better Auth instance config, so a
 * successful sign-up sets a session cookie immediately and the user
 * lands on `return_to` already authenticated.
 */

interface SignUpPageParams {
  /** Where to send the user after a successful sign-up. Validated by
   *  the caller — only relative paths starting with `/` are accepted. */
  returnTo: string;
  /** Error code from a previous attempt. Renders an inline banner. */
  error?: string;
}

const ERROR_MESSAGES: Record<string, string> = {
  missing_field: "Please fill in every field.",
  password_mismatch: "Passwords don't match. Try again.",
  weak_password: "Password must be at least 8 characters.",
  email_invalid: "That email address looks malformed.",
  email_exists: "An account with that email already exists. Sign in instead.",
  signup_failed: "Couldn't create the account. Try again.",
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Renders the sign-up page as a complete HTML document string. */
export function renderSignUpPage(params: SignUpPageParams): string {
  const safeReturnTo = escapeHtml(params.returnTo);

  const errorMessage = params.error
    ? (ERROR_MESSAGES[params.error] ?? "Something went wrong. Try again.")
    : null;

  const errorBanner = errorMessage
    ? `<div class="banner banner--error" role="alert">${escapeHtml(errorMessage)}</div>`
    : "";

  const signInHref = `/auth/sign-in?${escapeHtml(buildQuery({ return_to: params.returnTo }))}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Create your Myme account</title>
  <style>${STYLES}</style>
</head>
<body>
  <main class="card" aria-labelledby="page-title">
    <h1 id="page-title">Create your Myme account</h1>
    ${errorBanner}
    <form method="POST" action="/auth/sign-up" class="form" novalidate>
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
        <span class="field__label">Display name</span>
        <input type="text"
               name="name"
               required
               autocomplete="name"
               aria-required="true">
      </label>
      <label class="field">
        <span class="field__label">Password</span>
        <input type="password"
               name="password"
               required
               minlength="8"
               autocomplete="new-password"
               aria-required="true"
               aria-describedby="password-hint">
        <span id="password-hint" class="field__hint">At least 8 characters.</span>
      </label>
      <label class="field">
        <span class="field__label">Confirm password</span>
        <input type="password"
               name="password_confirm"
               required
               minlength="8"
               autocomplete="new-password"
               aria-required="true">
      </label>
      <button type="submit" class="btn btn--primary">Create account</button>
    </form>
    <p class="aux">Already have an account? <a href="${signInHref}">Sign in</a></p>
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
  .form { display: flex; flex-direction: column; gap: 14px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field__label { font-size: 13px; color: var(--ink-soft); font-weight: 500; }
  .field__hint { font-size: 12px; color: var(--ink-faint); margin: 0; }
  input[type="email"], input[type="password"], input[type="text"] {
    font: inherit;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--card);
    color: var(--ink);
    width: 100%;
  }
  input:focus {
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
    background: var(--accent);
    color: var(--card);
  }
  .btn--primary:hover { background: var(--accent-hover); }
  .btn:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  .aux {
    margin: 20px 0 0;
    text-align: center;
    font-size: 13px;
    color: var(--ink-soft);
  }
  .aux a { color: var(--ink); }
`;
