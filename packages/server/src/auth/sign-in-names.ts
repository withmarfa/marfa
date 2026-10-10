/**
 * The readable names of the owner's sign-ins, one function for each kind
 * whose name is not stored as it is shown.
 */

const BROWSERS: readonly (readonly [RegExp, string])[] = [
  // Edge, Opera and every Chromium browser also say `Chrome/`, and Chrome
  // also says `Safari/`, so the more particular names are asked first.
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChrome\/|\bCriOS\//, "Chrome"],
  [/\bSafari\//, "Safari"],
];

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  // An iPhone's and an iPad's browser say `like Mac OS X`, and Android's say
  // `Linux`, so those are asked first.
  [/\biPad\b/, "iPadOS"],
  [/\biPhone\b|\biPod\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMacintosh\b|\bMac OS X\b/, "macOS"],
  [/\bWindows\b/, "Windows"],
  [/\bLinux\b|\bX11\b/, "Linux"],
];

const NAME_LIMIT = 40;

/** The longest name a sign-in is shown by, and the longest the owner gives. */
export const SIGN_IN_NAME_MAX = 200;

/**
 * A control character (C0, DEL or C1) or a bidirectional embedding, override
 * or isolate. Shown in a terminal or a page, either can make a name pass for
 * another or forge a line it does not hold.
 */
export const UNPRINTABLE =
  // eslint-disable-next-line no-control-regex -- the controls are what it finds
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

/**
 * `name` trimmed, or undefined where it is no name a sign-in can be shown by:
 * empty, longer than {@link SIGN_IN_NAME_MAX}, or holding an
 * {@link UNPRINTABLE} character. The app or the key that chose it falls back
 * to its id.
 */
export function usableSignInName(
  name: string | null | undefined,
): string | undefined {
  const trimmed = name?.trim();
  if (
    !trimmed ||
    trimmed.length > SIGN_IN_NAME_MAX ||
    UNPRINTABLE.test(trimmed)
  )
    return undefined;
  return trimmed;
}

/**
 * A browser session's name, made from the `User-Agent` it signed in with:
 * "Safari on macOS". A client that names no browser this knows is named by
 * the first product its `User-Agent` names, such as `curl`.
 */
export function browserSignInName(userAgent: string | null): string {
  const text = userAgent?.trim() ?? "";
  if (text === "" || UNPRINTABLE.test(text)) return "A browser";
  const browser = BROWSERS.find(([pattern]) => pattern.test(text))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(text))?.[1];
  const product = /^([A-Za-z][A-Za-z0-9._-]*)/.exec(text)?.[1];
  const named =
    browser ??
    (product === undefined || product === "Mozilla"
      ? "A browser"
      : product.slice(0, NAME_LIMIT));
  return system === undefined ? named : `${named} on ${system}`;
}

/**
 * An app's name: the owner's own name for it where they gave one, then the
 * name the app registered with, then its client id, passing over a name that
 * {@link usableSignInName} refuses.
 */
export function appSignInName(
  ownName: string | undefined,
  registeredName: string | null | undefined,
  clientId: string,
): string {
  return (
    usableSignInName(ownName) ?? usableSignInName(registeredName) ?? clientId
  );
}

/**
 * A key's name: its label, or its id where the label is no name
 * {@link usableSignInName} takes. A key minted by an app carries the label
 * the app chose.
 */
export function keySignInName(label: string, keyId: string): string {
  return usableSignInName(label) ?? keyId;
}
