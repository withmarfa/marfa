/**
 * The deepest nesting a JSON request body may carry, counting an array or
 * object inside another as one level. SQLite's own JSON functions stop at
 * 1,000, and a body that reaches that limit fails inside the database as a
 * server error rather than as a refusal.
 */
export const MAX_JSON_DEPTH = 64;

/**
 * Whether `text`, read as JSON, nests deeper than `max`. It scans once and
 * keeps no tree, so a hostile body costs a pass over its bytes and nothing
 * else; brackets inside a string do not count.
 */
export function exceedsJsonDepth(text: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (ch === 0x5c) i++;
      else if (ch === 0x22) inString = false;
      continue;
    }
    if (ch === 0x22) inString = true;
    else if (ch === 0x5b || ch === 0x7b) {
      if (++depth > max) return true;
    } else if (ch === 0x5d || ch === 0x7d) depth--;
  }
  return false;
}
