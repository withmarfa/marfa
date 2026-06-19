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
