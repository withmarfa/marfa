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

/**
 * A browser session's name, made from the `User-Agent` it signed in with:
 * "Safari on macOS". A client that names no browser this knows is named by
 * the first product its `User-Agent` names, such as `curl`.
 */
export function browserSignInName(userAgent: string | null): string {
  const text = userAgent?.trim() ?? "";
  // eslint-disable-next-line no-control-regex
  if (text === "" || /[\u0000-\u001f\u007f]/.test(text)) return "A browser";
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
 * name the app registered with, then its client id.
 */
export function appSignInName(
  ownName: string | undefined,
  registeredName: string | null | undefined,
  clientId: string,
): string {
  for (const name of [ownName, registeredName]) {
    const trimmed = name?.trim();
    if (trimmed) return trimmed;
  }
  return clientId;
}
