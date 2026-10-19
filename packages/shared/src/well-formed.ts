/**
 * A UTF-16 code unit in D800 to DBFF with no unit in DC00 to DFFF after it,
 * or one in DC00 to DFFF with no unit in D800 to DBFF before it. RFC 8259
 * section 8.2 allows a JSON string to hold one, but no UTF-8 text can, and a
 * decoder that follows the Unicode standard refuses it.
 */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATES = new RegExp(LONE_SURROGATE.source, "g");

/** Whether `text` holds no surrogate code unit outside a high and low pair. */
export function isWellFormedText(text: string): boolean {
  return !LONE_SURROGATE.test(text);
}

/** `text` with each lone surrogate replaced by U+FFFD, as `toWellFormed` does. */
export function toWellFormedText(text: string): string {
  return text.replace(LONE_SURROGATES, "\ufffd");
}

interface Step {
  /** The value found at this step. */
  readonly value: unknown;
  /** The pointer segment that reached it, escaped, or null at the root. */
  readonly segment: string | null;
  readonly parent: Step | null;
  /** Whether the object key that reached it is not well-formed. */
  readonly badKey?: true;
}

function escapeSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function pointerTo(step: Step): string {
  const segments: string[] = [];
  for (let at: Step | null = step; at !== null; at = at.parent) {
    if (at.segment !== null) segments.push(at.segment);
  }
  return toWellFormedText(
    segments.reduceRight((pointer, segment) => `${pointer}/${segment}`, ""),
  );
}

/**
 * The RFC 6901 JSON pointer to the first string or object key in `value`
 * that is not well-formed UTF-16, or null when there is none. A key is named
 * by the member it opens. The pointer itself is well-formed, with each lone
 * surrogate in a key shown as U+FFFD, so it can go back in an answer.
 *
 * It walks with its own stack, so a value of any depth costs no call stack.
 */
export function findLoneSurrogate(value: unknown): string | null {
  const pending: Step[] = [{ value, segment: null, parent: null }];
  for (let step = pending.pop(); step !== undefined; step = pending.pop()) {
    const node = step.value;
    if (step.badKey) return pointerTo(step);
    if (typeof node === "string") {
      if (!isWellFormedText(node)) return pointerTo(step);
    } else if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        pending.push({
          value: node[i],
          segment: String(i),
          parent: step,
        });
      }
    } else if (typeof node === "object" && node !== null) {
      const members = Object.entries(node).reverse();
      for (const [key, child] of members) {
        pending.push({
          value: child,
          segment: escapeSegment(key),
          parent: step,
          ...(isWellFormedText(key) ? {} : { badKey: true as const }),
        });
      }
    }
  }
  return null;
}

/**
 * `text` cut to at most `max` UTF-16 code units. A cut that would fall
 * between the two units of a surrogate pair keeps one unit fewer, so the cut
 * never leaves a lone surrogate behind.
 */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  const before = text.charCodeAt(max - 1);
  const after = text.charCodeAt(max);
  const splitsPair =
    max > 0 &&
    before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff;
  return text.slice(0, splitsPair ? max - 1 : max);
}
