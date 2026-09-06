/**
 * Builds a request path, percent-encoding every interpolated segment.
 *
 * ```ts
 * path`/items/${id}/tags/${tag}`
 * ```
 *
 * **Why a tagged template rather than `encodeURIComponent` at each call
 * site.** The escape has to happen at every interpolation or the one that is
 * forgotten is the defect, and "every caller remembers" is the shape this
 * package avoids on purpose. Here the mechanism is the syntax: a path written
 * with this tag cannot carry an unescaped segment, and one written without it
 * is visible as a plain template literal rather than hiding among calls that
 * look correct.
 *
 * **What goes wrong without it is silent, not loud.** A `/` opens a segment
 * and addresses a different route. A `?` starts a query string, so a caller's
 * identifier smuggles parameters onto a real route. A `#` truncates the path
 * and the remainder never reaches the wire. None of these throws, and the
 * server answers something plausible for the request it was actually sent.
 *
 * `encodeURIComponent` is the right encoder because it escapes `/`, which the
 * path-oriented encoders deliberately keep — a path is allowed to hold
 * separators, and a *segment* is not. It leaves `A-Z a-z 0-9 - _ . ! ~ * ' ( )`
 * unescaped, and every character of a UUIDv7 is in that set, so the ids this
 * package actually carries encode to themselves and no stored idempotency key
 * changes shape.
 *
 * Interpolating a value that is not a single segment — a pre-built path, a
 * query string — is a mistake this cannot catch and should not be done.
 */
export function path(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    out += encodeURIComponent(String(values[i])) + (strings[i + 1] ?? "");
  }
  return out;
}
