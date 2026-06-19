/**
 * Submitting-state enhancement for auth-surface forms.
 *
 * Served from `GET /auth/static/submit-state.js` (see `auth-static.ts`
 * mounts). Inlined as a TypeScript template literal (same pattern as
 * `password-toggle-js.ts` / `passkey-js.ts`) so tsup bundles it into `dist/`
 * with no separate static-asset copy step.
 *
 * On a form's `submit` event (which fires only AFTER native HTML5 validation
 * passes) the script disables the form's submit button, adds an `is-loading`
 * class, and swaps the button's text to its `data-loading-label` so the user
 * gets immediate feedback that the request is in flight. A re-entrancy guard
 * (`data-submitting`) drops a second submit, so a double-click can't fire two
 * requests. The button is only re-enabled if the navigation is cancelled; a
 * real submit navigates away, replacing the page.
 *
 * Pages opt in by linking the script — no per-form markup beyond the optional
 * `data-loading-label` on the submit button. With scripting disabled the
 * script never runs, so the no-JavaScript path (a plain form POST) is
 * untouched.
 *
 * Only real submit buttons are targeted (`button[type="submit"]` or a
 * `<button>` with no explicit type, which defaults to submit). A
 * `type="button"` control — the two-step sign-up Continue / Back — is never a
 * submit, so this never fires on it.
 *
 * Carries no interpolated values, so it needs no escaping.
 */

export const SUBMIT_STATE_JS = `(function () {
  'use strict';

  var FALLBACK = 'Working...';

  function submitButton(form) {
    // The browser uses the activated submitter when present; fall back to the
    // first submit-typed control in the form for the keyboard-Enter path.
    var candidates = form.querySelectorAll('button, input[type="submit"]');
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (el.tagName === 'INPUT') return el;
      var type = (el.getAttribute('type') || 'submit').toLowerCase();
      if (type === 'submit') return el;
    }
    return null;
  }

  function onSubmit(event) {
    var form = event.currentTarget;
    if (form.getAttribute('data-submitting') === '1') {
      // Already in flight — drop the duplicate so a double-click never
      // fires two requests.
      event.preventDefault();
      return;
    }
    form.setAttribute('data-submitting', '1');

    var btn =
      (event.submitter && event.submitter.tagName !== 'INPUT'
        ? event.submitter
        : null) || submitButton(form);
    if (!btn) return;

    btn.classList.add('is-loading');
    var label = btn.getAttribute('data-loading-label') || FALLBACK;
    // Stash the original so a cancelled navigation can restore it.
    if (btn.getAttribute('data-idle-label') === null) {
      btn.setAttribute('data-idle-label', btn.textContent);
    }
    btn.textContent = label;
    // Disable AFTER the submit event so the button's name/value still posts.
    setTimeout(function () {
      btn.disabled = true;
    }, 0);
  }

  function init() {
    var forms = document.querySelectorAll('form');
    for (var i = 0; i < forms.length; i++) {
      // GET navigations (e.g. the one-time-link switch) are instant and need
      // no spinner; only enhance state-changing POST forms.
      var method = (forms[i].getAttribute('method') || 'get').toLowerCase();
      if (method !== 'post') continue;
      forms[i].addEventListener('submit', onSubmit);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
`;
