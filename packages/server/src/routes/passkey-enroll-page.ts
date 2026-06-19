/**
 * Passkey enroll page renderer for `/auth/passkey/enroll`.
 *
 * Server-rendered HTML, uses the shared auth-page layout. Auth-gated
 * upstream (the route handler redirects to /auth/sign-in when no session
 * cookie is present).
 *
 * The page wires a JS-only "Register passkey" button. Browsers
 * without WebAuthn / not running in a secure context see a fallback
 * paragraph explaining the requirement instead of a non-functional
 * button. Capability detection is done by the browser-side script
 * (`MarfaPasskey.isSupported()`), which hides the button on
 * unsupported browsers — no server-side UA sniffing.
 *
 * Shape mirrors the rest of the auth surface — single H1, sub,
 * status banner, primary action.
 */

import { renderAuthLayout } from "./auth-layout.js";
import { escapeHtml } from "./auth-html.js";

interface PasskeyEnrollPageParams {
  /** Authenticated user's email — shown for confirmation. */
  email: string;
}

/** Renders the passkey enroll page as a complete HTML document. */
export function renderPasskeyEnrollPage(
  params: PasskeyEnrollPageParams,
): string {
  const safeEmail = escapeHtml(params.email);

  const inlineScript = `
(function () {
  function show(id) { var el = document.getElementById(id); if (el) el.hidden = false; }
  function hide(id) { var el = document.getElementById(id); if (el) el.hidden = true; }
  function setError(msg) {
    var el = document.getElementById('passkey-error');
    if (el) { el.textContent = msg; show('passkey-error'); }
  }
  function clearStatus() {
    hide('passkey-error');
    hide('passkey-success');
  }

  if (!window.MarfaPasskey || !window.MarfaPasskey.isSupported()) {
    hide('passkey-button');
    show('passkey-unsupported');
    return;
  }

  var btn = document.getElementById('passkey-button');
  if (!btn) return;
  btn.addEventListener('click', async function () {
    clearStatus();
    btn.disabled = true;
    try {
      await window.MarfaPasskey.enroll();
      show('passkey-success');
    } catch (err) {
      var info = window.MarfaPasskey.describeError(err, 'enroll');
      // A cancel / timeout is the user's choice — no scary banner.
      if (!info.cancelled) setError(info.message);
    } finally {
      btn.disabled = false;
    }
  });
})();
  `.trim();

  const bodyHtml = `
    <h1 class="title">Add a passkey</h1>
    <p class="sub">Sign in faster with Face ID, Touch ID, Windows Hello, or a security key.</p>
    <p class="sub">Signed in as <strong>${safeEmail}</strong>.</p>

    <div id="passkey-success" class="banner banner--success" role="status" hidden>
      Passkey added. You can sign in with it next time.
    </div>
    <div id="passkey-error" class="banner banner--error" role="alert" hidden></div>

    <div class="actions">
      <button id="passkey-button" type="button" class="btn btn--primary">Add a passkey</button>
    </div>

    <p id="passkey-unsupported" class="aux" hidden>
      Your browser doesn't support passkeys, or this connection isn't secure (HTTPS). Try a recent version of Chrome, Safari, or Firefox over HTTPS.
    </p>

    <p class="aux"><a href="/auth/security">Back to security</a></p>

    <script src="/auth/static/passkey.js"></script>
    <script>${inlineScript}</script>
  `;

  return renderAuthLayout({
    title: "Add a passkey",
    bodyHtml,
  });
}
