/**
 * Whether a requested `redirect_uri` is one the client registered, decided
 * the same way the vendored OAuth provider decides it.
 *
 * **Reproduced from the dependency, not invented here.** The rule lives in
 * `findRegisteredRedirectUri`, in
 * `node_modules/@better-auth/oauth-provider/dist/authorize-*.mjs`, at the
 * pinned version `1.7.1`, and it is not exported. `findAuthorizeRequest` in
 * `oauth-provider.ts` carries the same treatment for the same reason: a rule
 * this side of the boundary has to agree with the plugin's, and the only way
 * to make them impossible to disagree is to reproduce it rather than infer
 * one from the shape of the problem.
 *
 * **If a future version changes the rule, this diverges silently.** Two
 * things bound how far. The dependency is pinned to an exact version rather
 * than a range, so arriving at a different one is an edit somebody made on
 * purpose. And the direction of the drift decides the cost: a reproduction
 * that is stricter than the plugin's refuses a catch-up the plugin would
 * have allowed, which costs a stale client one more sign-in before it
 * self-heals. A reproduction that is looser admits a write on a redirect URI
 * the plugin will refuse, which lowers the only bar the caller raises, and it
 * fails invisibly — nothing about the request looks different. So the unit
 * coverage asserts refusals as well as admissions, and covers the arms a
 * reproduction actually drifts on rather than only the obvious cases.
 *
 * **Exact match alone would be wrong**, which is why this is not three
 * lines. RFC 8252 §7.3 lets a native app bind an ephemeral loopback port,
 * so the port it registered is almost never the port it later listens on.
 * Exact-match-only would therefore stop catching up precisely the native and
 * CLI clients the catch-up exists for.
 */

/** Dotted-quad shape. Octet bounds are checked separately. */
const IPV4_SHAPE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** One 16-bit group of an IPv6 literal, lowercase hex as WHATWG serializes it. */
const IPV6_GROUP = /^[0-9a-f]{1,4}$/;

/**
 * Expand an IPv6 literal to its eight 16-bit groups, or `null` if it is not
 * one.
 *
 * Only the compressed hex form is handled, because that is the only form
 * that can arrive: every hostname this module classifies comes out of
 * `new URL(...).hostname`, and WHATWG parsing canonicalizes on the way in —
 * `[0:0:0:0:0:0:0:1]` and `[::1]` both serialize to `[::1]`, and
 * `[::ffff:127.0.0.1]` serializes to `[::ffff:7f00:1]`. A dotted-quad tail
 * and a zone identifier are gone before this sees the string.
 */
function expandIpv6(literal: string): number[] | null {
  const halves = literal.split("::");
  if (halves.length > 2) return null;

  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!IPV6_GROUP.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };

  const head = groups(halves[0] ?? "");
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;

  const tail = groups(halves[1] ?? "");
  if (tail === null) return null;
  const elided = 8 - head.length - tail.length;
  // `::` stands for at least one elided group; a literal that fills all
  // eight without it is not this form.
  if (elided < 1) return null;
  return [...head, ...Array<number>(elided).fill(0), ...tail];
}

/**
 * Strict loopback-IP-literal test, per RFC 8252 §7.3: IPv4 `127.0.0.0/8` or
 * IPv6 `::1` only.
 *
 * The DNS name `localhost` is deliberately NOT loopback here. RFC 8252 §8.3
 * recommends against relying on name resolution for a loopback redirect, and
 * the plugin's own `isLoopbackIP` excludes it — admitting it would relax the
 * port on a name an attacker may be able to point somewhere else.
 *
 * IPv4-mapped loopback (`::ffff:7f00:1`) is included because the plugin's
 * classifier unmaps before classifying, so excluding it would be a
 * divergence in the direction that refuses a real client.
 *
 * **Exported for its own coverage, not for use.** Two of its rejections —
 * an out-of-range octet, and an IPv6 literal that fills all eight groups and
 * still carries a `::` — cannot be reached through
 * {@link matchesRegisteredRedirectUri}, because every hostname that reaches
 * it has already been through WHATWG parsing, which canonicalizes those forms
 * or refuses to parse them at all. They are kept because this is a predicate
 * over a host string rather than over a `URL`, and a caller that ever hands
 * it an unparsed one would otherwise get `127.0.0.999` classified as
 * loopback. Kept means tested: asserting them end-to-end would produce cases
 * that pass because `new URL` threw, which is a green test measuring nothing.
 */
export function isLoopbackIpLiteral(hostname: string): boolean {
  const quad = IPV4_SHAPE.exec(hostname);
  if (quad) {
    const octets = quad.slice(1).map((o) => Number(o));
    if (octets.some((o) => o > 255)) return false;
    return octets[0] === 127;
  }

  // `URL.hostname` keeps an IPv6 literal bracketed. Anything unbracketed
  // that is not a dotted quad is a DNS name.
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const groups = expandIpv6(hostname.slice(1, -1));
  if (!groups) return false;

  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return (groups[6] ?? 0) >>> 8 === 127;
  }
  return false;
}

/**
 * Whether `requested` is a redirect URI this client registered.
 *
 * Exact string match, or — for a loopback IP literal — a match on
 * scheme, host, path and query with the port ignored.
 *
 * A `requested` value that is not a parseable URL can only be admitted by an
 * exact string match, which mirrors the plugin: it parses the requested
 * value once, up front, and falls through to string equality when the parse
 * throws.
 */
export function matchesRegisteredRedirectUri(
  registered: readonly string[] | null | undefined,
  requested: string | null | undefined,
): boolean {
  if (!registered || !requested) return false;

  let req: URL | undefined;
  try {
    req = new URL(requested);
  } catch {
    // Not a URL. Only exact equality can admit it from here.
  }

  return registered.some((entry) => {
    if (entry === requested) return true;
    if (!req) return false;
    let reg: URL;
    try {
      reg = new URL(entry);
    } catch {
      return false;
    }
    return (
      isLoopbackIpLiteral(reg.hostname) &&
      reg.hostname === req.hostname &&
      reg.pathname === req.pathname &&
      reg.protocol === req.protocol &&
      reg.search === req.search
    );
  });
}
