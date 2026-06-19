/**
 * Shared HTML scaffold for every auth-surface page. `renderAuthLayout`
 * is the single source of truth for the `<!DOCTYPE>...</html>` envelope,
 * the `<meta viewport>` tag, the `<title>`, and the `<link rel="stylesheet">`
 * to `/auth/static/auth.css`. Page renderers (`renderSignInPage`,
 * `renderConsentScreen`, etc.) build the inner HTML and hand it to this
 * helper rather than duplicating the scaffold.
 *
 * Title is escaped here so callers don't have to remember.
 */

import { escapeHtml } from "./auth-html.js";

interface AuthLayoutParams {
  /** Document title — rendered into <title>, escaped. */
  title: string;
  /**
   * Body HTML — already-escaped, fully-formed inner markup. The helper
   * does NOT escape this; the caller is responsible for escaping any
   * untrusted values it interpolates.
   */
  bodyHtml: string;
  /**
   * Optional aria-label override on the `<main>` wrapper. Defaults to
   * the title. Useful when the visible heading differs from the title
   * (e.g. a result-page that says "Signed in" but is titled
   * "Authorize CLI").
   */
  ariaLabel?: string;
  /**
   * When `true`, the card uses the wider variant (`max-width: 520px`).
   * Used by surfaces that show longer scope lists / diff sections —
   * consent today, the security page once it ships.
   */
  wide?: boolean;
}

/** Wrap inner page HTML in the shared auth-layout shell. */
export function renderAuthLayout(params: AuthLayoutParams): string {
  const safeTitle = escapeHtml(params.title);
  const safeAria = escapeHtml(params.ariaLabel ?? params.title);
  const cardClass = params.wide ? "card card--wide" : "card";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <link rel="stylesheet" href="/auth/static/auth.css">
</head>
<body>
  <main class="${cardClass}" aria-label="${safeAria}">
    ${params.bodyHtml}
  </main>
</body>
</html>`;
}
