/**
 * How a manifest names itself to a person, derived once for every surface
 * that shows one.
 *
 * A manifest carries two names and they answer different questions. `name`
 * is the identifier: it follows the `<namespace>/<name>` grammar, it is the
 * dedupe key, and it is the only name on these pages a publisher cannot
 * choose freely. `display_name` is an optional label the publisher writes,
 * fixed at publish time.
 *
 * The derivation lives here rather than in either page because there was
 * nothing to derive until now. Both screens read `name` and agreed for want
 * of a second name to disagree about, and the first cut of this change
 * pulled them apart immediately: the install screen led with the label
 * while the configure screen, seconds later in the same flow, still led
 * with the identifier. A second copy of the rule is how the next surface
 * picks the wrong name.
 *
 * One surface is deliberately exempt. The Google Calendar picker titles
 * itself "Configure Google Calendar" from a constant, because it is bespoke
 * to one integration and refuses to render for any other manifest, so its
 * title names a product rather than deriving a name from data. Routing it
 * through here would put an identifier in the browser tab for the common
 * case of a manifest declaring no label, which is a regression rather than
 * a fix. Its heading is "Choose calendars to sync", so the exemption
 * reaches the tab title and nothing a reader sees on the page itself.
 */

/**
 * Segmenting by grapheme rather than by codepoint. A flag is two regional
 * indicators, a family emoji is several codepoints joined by zero-width
 * joiners, a skin tone is a modifier following the hand it applies to, and
 * a decomposed accent is a letter followed by a combining mark. Splitting
 * any of those by codepoint takes half of one character.
 */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function firstGrapheme(value: string): string | undefined {
  for (const { segment } of GRAPHEMES.segment(value)) return segment;
  return undefined;
}

/**
 * The tile glyph: the first whole character of a name.
 *
 * `charAt(0)` was safe while the only input was an identifier, whose grammar
 * admits lowercase ASCII and a slash. A display name has no character class,
 * so the first character may be several codepoints, and upper-casing it can
 * add more (`ss` from a sharp s) where the tile has room for one.
 *
 * This picks a whole character; it does not judge whether that character is
 * worth looking at. A name opening with a bare combining mark or a
 * directionality control still yields a tile with nothing legible in it.
 * The tile is `aria-hidden` decoration and is never the only thing naming
 * an integration on a page, which is what keeps that acceptable.
 */
function firstGlyph(name: string): string {
  const first = firstGrapheme(name);
  if (first === undefined) return "?";
  return firstGrapheme(first.toUpperCase()) ?? "?";
}

/** The names and glyph a surface needs, resolved together. */
export interface ManifestDisplay {
  /** The name to lead with. */
  name: string;
  /** The identifier, always, whether or not it is what `name` holds. */
  identifier: string;
  /**
   * Whether `name` came from a publisher-authored `display_name`. A surface
   * granting anything on the strength of this manifest keeps the identifier
   * visible when this is true, because free text a publisher chose is not
   * something a person can tell one integration from another by.
   */
  labeled: boolean;
  /** Single-character tile glyph. */
  glyph: string;
}

/**
 * `declaredDisplayName` is `unknown` because every caller reads it off a
 * persisted manifest blob rather than a parsed one. The schema refuses a
 * non-string and refuses whitespace-only, so this is defending against a
 * row that never went through it, not re-validating what it already
 * checked. It cannot catch every string that renders as nothing, which is
 * the other half of why the identifier stays on the consent screen.
 */
export function manifestDisplay(
  identifier: string,
  declaredDisplayName: unknown,
): ManifestDisplay {
  const resolvedIdentifier = identifier.trim();
  const declared =
    typeof declaredDisplayName === "string" ? declaredDisplayName.trim() : "";
  const labeled = declared.length > 0;
  const name = labeled ? declared : resolvedIdentifier;
  return {
    name,
    identifier: resolvedIdentifier,
    labeled,
    glyph: firstGlyph(name),
  };
}
