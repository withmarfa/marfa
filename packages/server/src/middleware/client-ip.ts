/**
 * Client IP extraction with opt-in proxy trust.
 *
 * Why this exists: by default we ignore `x-forwarded-for` and use the
 * connection peer address. A client can spoof the header by sending it
 * directly, so blindly trusting it is a rate-limit bypass and an audit-
 * log poisoning vector. Operators behind a real reverse proxy opt in by
 * setting TRUSTED_PROXY_CIDRS, which lists the proxies we will believe.
 *
 * Algorithm when trust is configured:
 *   1. Start with the peer address (the immediate connection IP).
 *   2. If the peer is in a trusted CIDR, walk `x-forwarded-for` right
 *      to left, skipping each hop that's also in a trusted CIDR.
 *   3. Return the first untrusted IP encountered. If everything in the
 *      chain is trusted, return the leftmost (which the trusted proxy
 *      stack vouches for).
 *
 * Algorithm when trust is unset:
 *   - Always return the peer address. `x-forwarded-for` is ignored.
 *
 * Some platforms cannot be expressed as a CIDR list. They terminate every
 * connection at an edge whose addresses are undocumented and free to
 * change, and they overwrite a single header with the client address —
 * Some proxies send `X-Real-IP` and no `X-Forwarded-For` at all. Pinning a
 * CIDR there means guessing at a range the platform never promised, and
 * getting it wrong fails silently: every request resolves to the edge, so
 * per-client rate limiting collapses into one bucket and every audit row
 * records the proxy. `TRUSTED_PROXY_HEADER` names that header instead, and
 * the trust it declares is "nothing reaches this process except through
 * the platform's edge, which overwrites this header". Set it on a
 * directly-reachable deployment and any client can spoof its own address.
 */

import ipaddr from "ipaddr.js";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "./auth.js";
import { log } from "./logger.js";
import { errorMessage } from "../error-text.js";

type CidrRange = [ipaddr.IPv4 | ipaddr.IPv6, number];

/** Parse a comma-separated CIDR list. Throws on any malformed entry —
 *  we want bad config to fail loudly at startup, not silently. */
export function parseTrustedProxyCidrs(raw: string | undefined): CidrRange[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((cidr) => {
      try {
        return ipaddr.parseCIDR(cidr);
      } catch (err) {
        throw new Error(
          `TRUSTED_PROXY_CIDRS: invalid CIDR "${cidr}": ${errorMessage(err)}`,
          { cause: err },
        );
      }
    });
}

/** Parse `TRUSTED_PROXY_HEADER` into a lower-cased header name, or null
 *  when unset. Throws on a value that is not a valid header token — the
 *  same fail-loudly-at-startup posture `parseTrustedProxyCidrs` takes,
 *  and worth having because the failure mode of a typo here is silent. */
export function parseTrustedProxyHeader(
  raw: string | undefined,
): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(trimmed)) {
    throw new Error(
      `TRUSTED_PROXY_HEADER: "${trimmed}" is not a valid header name`,
    );
  }
  return trimmed.toLowerCase();
}

/** Normalize an address: strips IPv4-mapped IPv6 (`::ffff:1.2.3.4` →
 *  `1.2.3.4`) so CIDR comparisons across dual-stack peers and v4 chains
 *  work consistently. Returns null for unparseable input. */
function normalize(raw: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed.kind() === "ipv6") {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) return v6.toIPv4Address();
  }
  return parsed;
}

function isInTrusted(
  addr: ipaddr.IPv4 | ipaddr.IPv6,
  trusted: CidrRange[],
): boolean {
  for (const range of trusted) {
    const [rangeAddr] = range;
    if (rangeAddr.kind() !== addr.kind()) continue;
    try {
      // kinds match, so the cast to `never` is safe at runtime despite the split typings
      if (addr.match(range)) return true;
    } catch {
      // should not reach here; ignore if it does
    }
  }
  return false;
}

/** Read the raw connection peer address from the Hono node-server adapter.
 *  Hono exposes the underlying `IncomingMessage` via `c.env.incoming`. */
function readPeer(c: Context): string | null {
  const env = c.env as
    { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? null;
}

/**
 * Extract the effective client IP for the current request.
 *
 * @param c - The Hono context.
 * @param trustedCidrs - Pre-parsed CIDR list (call `parseTrustedProxyCidrs`
 *   once at startup and reuse the result; do not parse per-request).
 * @param trustedHeader - Pre-parsed header name from
 *   `parseTrustedProxyHeader`, or null. When set it takes precedence over
 *   the CIDR walk, because the two express different trust: a CIDR list
 *   says which peers may speak for a client, and this says the platform
 *   already did.
 * @returns The client IP as a string, or `null` when no peer is available
 *   (mostly in tests with synthetic contexts).
 */
export function getClientIp(
  c: Context,
  trustedCidrs: CidrRange[],
  trustedHeader: string | null = null,
): string | null {
  const peerRaw = readPeer(c);
  if (!peerRaw) return null;

  const peer = normalize(peerRaw);
  if (!peer) return null;

  if (trustedHeader) {
    // A header carrying a list is still a chain; the leftmost entry is the
    // client. Falling back to the peer on an absent or unparseable value
    // keeps a misconfigured deployment recording something real rather
    // than null, which downstream treats as "no IP available".
    const raw = c.req.header(trustedHeader);
    const first = raw?.split(",")[0];
    const addr = first ? normalize(first) : null;
    return (addr ?? peer).toString();
  }

  if (trustedCidrs.length === 0) return peer.toString();

  // If the peer itself isn't trusted, any XFF header it sent is attacker-controlled.
  if (!isInTrusted(peer, trustedCidrs)) return peer.toString();

  const xff = c.req.header("x-forwarded-for");
  if (!xff) return peer.toString();

  const hops = xff
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = normalize(hops[i] ?? "");
    if (!hop) continue;
    if (!isInTrusted(hop, trustedCidrs)) return hop.toString();
  }

  return normalize(hops[0] ?? "")?.toString() ?? peer.toString(); // fully-trusted chain: leftmost = original client
}

export type { CidrRange };

/**
 * The header Better Auth reads the client address from. Better Auth resolves
 * an address for its own limiter and its session rows, and left to itself it
 * trusts whatever `X-Forwarded-For` a client sends. So it is told to read this
 * header instead, and `MarfaAuth.handler` writes it on every request it hands
 * over, with the address this middleware resolved, replacing anything the
 * client sent under the name.
 */
export const CLIENT_ADDRESS_HEADER = "x-marfa-client-address";

/**
 * The key a per-address limit counts under. An IPv6 host is normally handed a
 * whole /64 and can rotate through it at will, so an IPv6 address counts as
 * its /64; an IPv4 address counts as itself.
 */
export function addressBucket(ip: string): string {
  const parsed = normalize(ip);
  if (!parsed) return ip;
  if (parsed.kind() === "ipv4") return parsed.toString();
  const parts = (parsed as ipaddr.IPv6).parts.slice(0, 4);
  return `${parts.map((p) => p.toString(16)).join(":")}::/64`;
}

/** Headers a proxy adds to say who its client was. */
const FORWARDING_HEADERS = ["x-forwarded-for", "x-real-ip", "forwarded"];

/**
 * Resolve the client IP once per request and stash it on
 * `c.var.clientIp` for downstream consumers: the audit rows, the rate
 * limiter, the sign-in and device code limits, and Better Auth, which is
 * handed it with every request (`MarfaAuth.handler`). Run this BEFORE auth
 * so the resolved IP is available to every later middleware and handler.
 *
 * Also drops any {@link CLIENT_ADDRESS_HEADER} the client sent, so nothing
 * downstream can read one, and warns once when a request arrives carrying a
 * forwarding header on an instance that trusts no proxy: behind a proxy,
 * that instance sees every client as the proxy's address, and every limit
 * counts them all as one.
 */
export function clientIpMiddleware(
  trustedCidrs: CidrRange[],
  trustedHeader: string | null = null,
): MiddlewareHandler<AppEnv> {
  const trustsNoProxy = trustedCidrs.length === 0 && trustedHeader === null;
  let warned = false;
  return async (c, next) => {
    if (c.req.header(CLIENT_ADDRESS_HEADER) !== undefined) {
      c.req.raw.headers.delete(CLIENT_ADDRESS_HEADER);
    }
    if (
      trustsNoProxy &&
      !warned &&
      FORWARDING_HEADERS.some((name) => c.req.header(name) !== undefined)
    ) {
      warned = true;
      log(
        "warn",
        "A request carried a forwarding header, but no proxy is trusted, so every client behind a proxy counts as one address. Set TRUSTED_PROXY_CIDRS or TRUSTED_PROXY_HEADER if this instance runs behind one.",
      );
    }
    c.set("clientIp", getClientIp(c, trustedCidrs, trustedHeader));
    await next();
  };
}
