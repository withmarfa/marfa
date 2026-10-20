/**
 * The characters no name may hold. It touches no DOM and no Node API and
 * imports nothing, so the server and the browser pages can both import it.
 */

/**
 * A control character (C0, DEL or C1) or a bidirectional embedding, override
 * or isolate. Shown in a terminal or a page, either can make a name pass for
 * another or forge a line it does not hold.
 */
export const UNPRINTABLE =
  // eslint-disable-next-line no-control-regex -- the controls are what it finds
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

/**
 * A bidirectional formatting character of any kind, including the marks and
 * the Arabic letter mark that {@link UNPRINTABLE} leaves out.
 */
export const BIDI_CONTROL = /\p{Bidi_Control}/u;

/** Whether `text` holds a control or a bidirectional formatting character. */
export function hasHiddenCharacter(text: string): boolean {
  return UNPRINTABLE.test(text) || BIDI_CONTROL.test(text);
}
