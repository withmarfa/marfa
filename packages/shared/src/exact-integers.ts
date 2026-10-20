/**
 * Marfa holds a number as a 64-bit float and serves it as JavaScript prints
 * it: the shortest digits that name the float. A whole number written with
 * other digits would come back as a different number, so it is kept only
 * when its digits are the ones JavaScript prints for the float it parses to.
 * A number written with a fraction or an exponent is never judged: it names a
 * float, not digits.
 */

/** Fewest digits a whole number can have and still be beyond a float's exact range, 2^53. */
const MIN_DIGITS = 16;

/**
 * Whether the whole number written as `source` (JSON's integer grammar,
 * optional minus then digits) is served back with the digits it was written
 * with: they are the shortest digits that name the float it rounds to, as
 * `String(Number(source))` prints them. Every safe integer is.
 */
export function isKeptInteger(source: string): boolean {
  const digits = source.startsWith("-") ? source.length - 1 : source.length;
  if (digits < MIN_DIGITS) return true;
  return String(Number(source)) === source;
}

/**
 * What a write is told when it holds a whole number that is not kept as
 * written: the digits the float would be served as, where it has any.
 */
export function inexactIntegerMessage(source: string): string {
  const rounded = Number(source);
  const kept = Number.isFinite(rounded)
    ? `, which it keeps as ${String(rounded)}`
    : "";
  return `Must be a whole number that a 64-bit float keeps digit for digit, not ${source}${kept}. Send it as a string.`;
}

/** A whole number in a JSON text that is not kept as written. */
export interface InexactInteger {
  /** Its digits, as written. */
  readonly source: string;
  /** The names of the members and the indices that reach it, outermost first. */
  readonly path: readonly string[];
}

type Reviver = (
  this: unknown,
  key: string,
  value: unknown,
  context?: { source?: string },
) => unknown;

const WHOLE_NUMBER = /^-?\d+$/;

/**
 * Every whole number in `text`, a JSON document, that is not kept as written,
 * in the order the text writes them. Empty where there is none, and where
 * `text` is not JSON, which the door that reads it refuses itself.
 *
 * The text is read for the digits as written because `JSON.parse` rounds a
 * number before any value is built, so the value alone cannot say.
 */
export function findInexactIntegers(text: string): InexactInteger[] {
  if (!/\d{16}/.test(text)) return [];
  const parents = new Map<unknown, { holder: unknown; key: string }>();
  const found: { holder: unknown; key: string; source: string }[] = [];
  const reviver: Reviver = function (key, value, context) {
    if (typeof value === "object" && value !== null) {
      parents.set(value, { holder: this, key });
    } else if (
      typeof value === "number" &&
      context?.source !== undefined &&
      WHOLE_NUMBER.test(context.source) &&
      !isKeptInteger(context.source)
    ) {
      found.push({ holder: this, key, source: context.source });
    }
    return value;
  };
  try {
    JSON.parse(text, reviver);
  } catch {
    return [];
  }
  return found.map(({ holder, key, source }) => {
    const path = parents.has(holder) ? [key] : [];
    let node = holder;
    for (let up = parents.get(node); up && parents.has(up.holder);) {
      path.unshift(up.key);
      node = up.holder;
      up = parents.get(node);
    }
    return { source, path };
  });
}
