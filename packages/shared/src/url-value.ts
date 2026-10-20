import { z } from "zod";
import { URL as StandardURL } from "whatwg-url";

/**
 * A `url` field's value: an absolute URL that the WHATWG URL Standard parses,
 * once the whitespace `String.prototype.trim` removes is gone from both ends,
 * stored without the tabs and line breaks the standard ignores.
 *
 * The standard is run by `whatwg-url`, its reference implementation, and not
 * by the platform's own `URL`: Node 22, 24 and 26 judge a host with a label
 * that starts `xn--` and is not valid Punycode three ways, so the platform
 * would give a different answer on each. A host that is all ASCII (after
 * percent-decoding) is kept as written by the standard, so `http://xn--` is a
 * URL; one with a non-ASCII character has to be valid IDNA.
 */
export const urlValue = z.string().transform((value, ctx) => {
  const trimmed = value.trim();
  if (!StandardURL.canParse(trimmed)) {
    ctx.issues.push({
      code: "invalid_format",
      format: "url",
      input: value,
      message: "Invalid URL",
    });
    return z.NEVER;
  }
  return trimmed.replace(/[\t\n\r]/g, "");
});
