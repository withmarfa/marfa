/**
 * Shared HTML helpers for the auth-surface page renderers.
 *
 * `escapeHtml` and `buildQuery` were copy-pasted into every page renderer
 * under `routes/`. Centralizing them keeps the escaping rules in one place
 * so a fix or audit lands once rather than across a dozen files.
 */

/**
 * Escape the five HTML-significant characters so an interpolated value can't
 * break out of an attribute or element context. Every auth page renderer
 * routes untrusted values through this before interpolation.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Build a URL-encoded query string. Only includes truthy values. */
export function buildQuery(params: Record<string, string>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value)
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return parts.join("&");
}

/**
 * Icon chip for the centered confirmation / result screens (check your email,
 * email verified, password updated, link expired). Gives the content-light
 * screens visual weight so they don't read as squat. `mail` for "we sent
 * something", `check` for success, `alert` for a dead link. The markup carries
 * no interpolated values, so it needs no escaping.
 */
export function confirmIcon(kind: "mail" | "check" | "alert"): string {
  const paths =
    kind === "check"
      ? `<path d="M20 6 9 17l-5-5"/>`
      : kind === "alert"
        ? `<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>`
        : `<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>`;
  return `<div class="confirm-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg></div>`;
}
