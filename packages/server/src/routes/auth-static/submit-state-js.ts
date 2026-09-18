/**
 * Form submit lifecycle for auth-surface forms: inline validation, then the
 * submitting state.
 *
 * Served from `GET /auth/static/submit-state.js` (see `auth-static.ts`
 * mounts). Inlined as a TypeScript template literal (same pattern as
 * `password-toggle-js.ts` / `auth-css.ts`) so tsup bundles it into `dist/`
 * with no separate static-asset copy step.
 *
 * Two responsibilities, in order, on a form's `submit` event:
 *
 *   1. Inline validation. The auth forms carry `novalidate`, so the browser
 *      never shows its own validation tooltip (the "Please fill in this field"
 *      bubble). Instead this script checks each field's validity and renders a
 *      field-level `.field__error` message under the offending input — matching
 *      the server-rendered error styling exactly — focuses the first invalid
 *      field, and stops the submit. The message clears as soon as the user
 *      edits the field. The validation entry point is also exposed as
 *      `window.MarfaForm.validate(container)` so the two-step sign-up's
 *      Continue button can validate step one with the same inline messages
 *      instead of the native bubble.
 *
 *   2. Submitting state. Once validation passes, the script disables the
 *      form's submit button, adds an `is-loading` class, and swaps the button's
 *      text to its `data-loading-label`. A re-entrancy guard
 *      (`data-submitting`) drops a second submit so a double-click can't fire
 *      two requests. The button is only re-enabled if the navigation is
 *      cancelled; a real submit navigates away, replacing the page.
 *
 * Pages opt in by linking the script — no per-form markup beyond the optional
 * `data-loading-label` on the submit button and an optional `data-validate-msg`
 * on a field whose generic validity message needs overriding (e.g. the
 * username pattern). With scripting disabled the script never runs, so the
 * no-JavaScript path (a plain form POST, validated server-side) is untouched.
 *
 * Only state-changing POST forms are enhanced; GET navigations (the
 * one-time-link switch) are instant and need neither validation nor a spinner.
 *
 * Carries no interpolated values, so it needs no escaping.
 */

export const SUBMIT_STATE_JS = `(function () {
  'use strict';

  var FALLBACK = 'Working...';

  // ---- Inline validation (replaces the browser's native validation bubble) ----

  function fieldOf(input) {
    return input.closest ? input.closest('.field') : null;
  }

  // Friendly, plain copy per validity failure. A field can override the message
  // for any failure with data-validate-msg (used by the username pattern).
  function messageFor(input) {
    var custom = input.getAttribute('data-validate-msg');
    var v = input.validity;
    if (v.valueMissing) return 'Please fill this in.';
    if (v.typeMismatch && input.type === 'email') return 'Enter a valid email address.';
    if (v.tooShort) return 'Use at least ' + input.minLength + ' characters.';
    if (custom) return custom;
    if (v.patternMismatch) return 'Check the format and try again.';
    return input.validationMessage || 'Check this field.';
  }

  function clearError(field) {
    if (!field) return;
    field.classList.remove('field--error');
    var msg = field.querySelector('.field__error');
    // Only remove messages this script created; a server-rendered error stays.
    if (msg && msg.getAttribute('data-js-error') === '1') msg.remove();
  }

  function showError(input) {
    var field = fieldOf(input);
    if (!field) return;
    field.classList.add('field--error');
    var msg = field.querySelector('.field__error');
    if (!msg) {
      msg = document.createElement('span');
      msg.className = 'field__error';
      msg.setAttribute('role', 'alert');
      msg.setAttribute('data-js-error', '1');
      field.appendChild(msg);
    }
    msg.textContent = messageFor(input);
  }

  // Validate every visible field inside a container (a form, or one step's
  // panel). Shows / clears inline messages and returns the first invalid input
  // (or null when all pass) so the caller can focus it.
  function validate(container) {
    var inputs = container.querySelectorAll('input, select, textarea');
    var firstInvalid = null;
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];
      // Skip hidden controls — incl. the real code input the OTP cells replace.
      if (input.type === 'hidden' || input.hidden || input.disabled) continue;
      if (typeof input.checkValidity !== 'function') continue;
      if (input.checkValidity()) {
        clearError(fieldOf(input));
      } else {
        showError(input);
        if (!firstInvalid) firstInvalid = input;
      }
    }
    return firstInvalid;
  }

  // Clear a field's error the moment it becomes valid as the user types.
  document.addEventListener('input', function (e) {
    var input = e.target;
    if (!input || typeof input.closest !== 'function') return;
    var field = input.closest('.field');
    if (
      field &&
      field.classList.contains('field--error') &&
      typeof input.checkValidity === 'function' &&
      input.checkValidity()
    ) {
      clearError(field);
    }
  });

  // ---- Submitting state ----

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

    // Validate first. An invalid form never enters the loading state and never
    // navigates — the inline messages tell the user what to fix.
    var firstInvalid = validate(form);
    if (firstInvalid) {
      event.preventDefault();
      if (typeof firstInvalid.focus === 'function') firstInvalid.focus();
      return;
    }

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
      // neither validation nor a spinner; only enhance state-changing POST forms.
      var method = (forms[i].getAttribute('method') || 'get').toLowerCase();
      if (method !== 'post') continue;
      forms[i].addEventListener('submit', onSubmit);
    }
  }

  // Exposed so the two-step sign-up's Continue button validates step one with
  // the same inline messages rather than the native bubble.
  window.MarfaForm = { validate: validate };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
`;
