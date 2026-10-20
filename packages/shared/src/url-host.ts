/**
 * Whether the host of an absolute URL carries a label that starts `xn--` and
 * is not valid Punycode. The WHATWG URL standard takes such a host and keeps
 * the label as written, and Node versions differ on whether they do: 22 and
 * 24 refuse it, 26 takes it. Marfa refuses it on every Node, so a value is
 * judged the same wherever the server runs and the same on a device.
 */

const SPECIAL_SCHEMES = new Set([
  "http:",
  "https:",
  "ftp:",
  "ws:",
  "wss:",
  "file:",
]);
const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;

function adapt(delta: number, points: number, first: boolean): number {
  let scaled = first ? Math.floor(delta / DAMP) : delta >> 1;
  scaled += Math.floor(scaled / points);
  let k = 0;
  while (scaled > ((BASE - T_MIN) * T_MAX) >> 1) {
    scaled = Math.floor(scaled / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * scaled) / (scaled + SKEW));
}

function digitValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x16;
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61;
  return BASE;
}

/**
 * The code points `encoded` (the part of a label after `xn--`) stands for, or
 * `undefined` where it is not valid Punycode (RFC 3492).
 */
function decodePunycode(encoded: string): number[] | undefined {
  const output: number[] = [];
  const delimiter = encoded.lastIndexOf("-");
  if (delimiter > 0) {
    for (let at = 0; at < delimiter; at += 1) {
      const code = encoded.charCodeAt(at);
      if (code >= 0x80) return undefined;
      output.push(code);
    }
  }
  let n = INITIAL_N;
  let bias = INITIAL_BIAS;
  let i = 0;
  let at = delimiter > 0 ? delimiter + 1 : 0;
  while (at < encoded.length) {
    const before = i;
    let weight = 1;
    for (let k = BASE; ; k += BASE) {
      if (at >= encoded.length) return undefined;
      const digit = digitValue(encoded.charCodeAt(at));
      at += 1;
      if (digit >= BASE) return undefined;
      i += digit * weight;
      if (!Number.isSafeInteger(i)) return undefined;
      const threshold =
        k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < threshold) break;
      weight *= BASE - threshold;
    }
    const length = output.length + 1;
    bias = adapt(i - before, length, before === 0);
    n += Math.floor(i / length);
    i %= length;
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return undefined;
    output.splice(i, 0, n);
    i += 1;
  }
  return output;
}

/**
 * Whether `label`, lowercase and ASCII, is valid Punycode that names a label
 * IDNA keeps as it is: it decodes, to at least one non-ASCII character, and
 * the platform's own conversion of what it decodes to gives the label back.
 */
function isValidPunycodeLabel(label: string): boolean {
  const decoded = decodePunycode(label.slice(4));
  if (!decoded?.some((code) => code >= 0x80)) return false;
  try {
    const host = new URL(`https://${String.fromCodePoint(...decoded)}`)
      .hostname;
    return host === label;
  } catch {
    return false;
  }
}

/**
 * Whether `text`, a URL the platform parses, has a host of a special scheme
 * (the ones whose host is a domain) with a label that starts `xn--` and is not
 * valid Punycode. The host is read as the standard leaves it: percent-decoded
 * and lowercased.
 */
export function hasInvalidPunycodeLabel(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (!SPECIAL_SCHEMES.has(url.protocol)) return false;
  return url.hostname
    .split(".")
    .some((label) => label.startsWith("xn--") && !isValidPunycodeLabel(label));
}
