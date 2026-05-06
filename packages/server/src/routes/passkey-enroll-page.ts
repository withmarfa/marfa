/**
 * Passkey enrol page renderer for `/auth/passkey/enroll`.
 *
 * Wave C PR6 / T-034. Server-rendered HTML, uses the shared auth-page
 * layout (PR4). Auth-gated upstream (the route handler redirects to
 * /auth/sign-in when no session cookie is present).
 *
 * The page wires a JS-only "Register passkey" button. Browsers
 * without WebAuthn / not running in a secure context see a fallback
 * paragraph explaining the requirement instead of a non-functional
 * button. Capability detection is done by the browser-side script
 * (`MymePasskey.isSupported()`), which hides the button on
 * unsupported browsers — no server-side UA sniffing.
 *
 * Shape mirrors the rest of the auth surface — single H1, lede,
 * status banner, primary action.
 */

import { renderAuthLayout } from "./auth-layout.js";

interface PasskeyEnrollPageParams {
  /** Authenticated user's email — shown for confirmation. */
  email: string;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Renders the passkey enrol page as a complete HTML document. */
export function renderPasskeyEnrollPage(
  params: PasskeyEnrollPageParams,
): string {
  const safeEmail = escapeHtml(params.email);

  // The page-level inline JS handles the click → MymePasskey.enroll()
  // round-trip and toggles status banners. Capability probe hides
  // the button entirely on unsupported browsers; we render a
  // fallback paragraph that's only visible in that case.
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

  // Capability detection. Hide the button + show the fallback if not
  // supported. We do this in JS rather than server-side because UA
  // sniffing is unreliable; WebAuthn support depends on the actual
  // browser + secure-context.
  if (!window.MymePasskey || !window.MymePasskey.isSupported()) {
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
      await window.MymePasskey.enroll();
      show('passkey-success');
    } catch (err) {
      setError((err && err.message) || 'Passkey enrolment failed.');
    } finally {
      btn.disabled = false;
    }
  });
})();
  `.trim();

  const bodyHtml = `
    <h1>Add a passkey</h1>
    <p class="lede">Sign in faster on this device with Face ID, Touch ID, Windows Hello, or your security key.</p>
    <p class="lede">Signed in as <strong>${safeEmail}</strong>.</p>

    <div id="passkey-success" class="banner banner--success" role="status" hidden>
      Passkey added. You can now sign in with it next time.
    </div>
    <div id="passkey-error" class="banner banner--error" role="alert" hidden></div>

    <div class="actions">
      <button id="passkey-button" type="button" class="btn btn--primary">Register passkey</button>
    </div>

    <p id="passkey-unsupported" class="aux" hidden>
      Your browser doesn't support passkeys, or this connection isn't secure (HTTPS). Try a recent version of Chrome, Safari, or Firefox over HTTPS.
    </p>

    <p class="aux"><a href="/auth/security">Back to security settings</a></p>

    <script src="/auth/static/passkey.js"></script>
    <script>${inlineScript}</script>
  `;

  return renderAuthLayout({
    title: "Add a passkey",
    bodyHtml,
  });
}
