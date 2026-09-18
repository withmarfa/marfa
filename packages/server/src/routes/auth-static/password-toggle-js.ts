/**
 * Show/hide toggle for password fields on the auth surface.
 *
 * Served from `GET /auth/static/password-toggle.js` (see `auth-static.ts`
 * mounts). Inlined as a TypeScript template literal (same pattern as
 * `auth-css.ts` / `submit-state-js.ts`) so tsup bundles it into `dist/` with no
 * separate static-asset copy step.
 *
 * The script runs once on load and enhances every `input[type="password"]`
 * on the page: it wraps the input in a positioned container and injects an
 * eye button that flips the input between `password` and `text`. The eye is
 * hidden until the field has a value (nothing to reveal on an empty field)
 * and appears with the first character typed. Pages opt in by linking the
 * script — no per-field markup. Because the button is
 * created by JS, a client with scripting disabled simply sees a normal
 * password field (no dead control), preserving the no-JavaScript path that
 * the auth forms are built around.
 *
 * The wrapper is inserted *inside* the original `<label class="field">`, so
 * the input stays a label descendant and implicit label association (by
 * containment) is preserved. The button is `type="button"` so it never
 * submits the form, and it's interactive content, so a click on it is not
 * forwarded to the labelled input.
 */

export const PASSWORD_TOGGLE_JS = `(function () {
  'use strict';

  // Lucide eye / eye-off glyphs. aria-hidden + focusable=false so the button's
  // aria-label is the only thing a screen reader announces.
  var EYE = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>';

  var SHOW = 'Show password';
  var HIDE = 'Hide password';

  function enhance(input) {
    if (input.getAttribute('data-pw-enhanced') === '1') return;
    input.setAttribute('data-pw-enhanced', '1');

    var wrap = document.createElement('div');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-toggle';
    btn.setAttribute('aria-label', SHOW);
    btn.setAttribute('aria-pressed', 'false');
    btn.title = SHOW;
    btn.innerHTML = EYE;
    wrap.appendChild(btn);

    // Nothing to reveal until the user has typed, so the eye stays hidden on an
    // empty field and appears with the first character. The input keeps its
    // right padding either way, so the icon's arrival shifts nothing.
    function syncVisible() {
      btn.hidden = input.value.length === 0;
    }
    syncVisible();
    input.addEventListener('input', syncVisible);

    btn.addEventListener('click', function () {
      var reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      btn.setAttribute('aria-pressed', reveal ? 'true' : 'false');
      btn.setAttribute('aria-label', reveal ? HIDE : SHOW);
      btn.title = reveal ? HIDE : SHOW;
      btn.innerHTML = reveal ? EYE_OFF : EYE;
      // Keep the caret where the user was typing — flipping the type can drop
      // focus and jump the caret to the end on some browsers.
      var pos = input.value.length;
      input.focus();
      try { input.setSelectionRange(pos, pos); } catch (e) {}
    });
  }

  function init() {
    var inputs = document.querySelectorAll('input[type="password"]');
    for (var i = 0; i < inputs.length; i++) enhance(inputs[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
`;
