/**
 * Marfa holds a number as a 64-bit float, so a whole number written with more
 * digits than a float keeps would come back as a different number. A whole
 * number is kept as written when its digits are the float's exact value, or
 * the shortest digits that name that float, which is how the server writes
 * every whole number it serves. A number written with a fraction or an
 * exponent is never judged: it names a float, not digits.
 */

/** Fewest digits a whole number can have and still be beyond a float's exact range, 2^53. */
const MIN_DIGITS = 16;

/**
 * Whether the whole number written as `source` (JSON's integer grammar,
 * optional minus then digits) is kept as written: a float holds its exact
 * value, or its digits are the shortest that name the float it rounds to.
 * The second case is what the server serves for a stored 2^60, so a value
 * read back can be written back.
 */
export function isKeptInteger(source: string): boolean {
  const digits = source.startsWith("-") ? source.length - 1 : source.length;
  if (digits < MIN_DIGITS) return true;
  const rounded = Number(source);
  if (!Number.isFinite(rounded)) return false;
  return String(rounded) === source || BigInt(rounded) === BigInt(source);
}

/** What a write is told when it holds a whole number that is not kept as written. */
export function inexactIntegerMessage(source: string): string {
  return `Must be a whole number that a 64-bit float holds exactly, not ${source}. Send it as a string.`;
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
