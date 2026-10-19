/**
 * The one check for an address a page renders.
 *
 * A URL parser drops tab, carriage return and line feed wherever they appear,
 * so "/\t/evil.com" reads as "//evil.com", a link to another host. An address
 * is therefore a path on this server: "/" alone, or "/" then a character that
 * is not "/" or "\", with no control character anywhere. A same-page form (an
 * empty string, a query or a fragment alone) is allowed only where a caller
 * asks for it.
 */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
const PATH = /^\/(?:[^/\\]|$)/;
const SAME_PAGE = /^(?:|[?#].*)$/s;

export function localHref(
  href: string,
  options: { relative?: boolean } = {},
): string {
  const ok =
    typeof href === "string" &&
    !hasControl(href) &&
    (PATH.test(href) || (options.relative === true && SAME_PAGE.test(href)));
  if (!ok)
    throw new Error(
      `An address must be a path on this server: ${JSON.stringify(href)}`,
    );
  return href;
}
