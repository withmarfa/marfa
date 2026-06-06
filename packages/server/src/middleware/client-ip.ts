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
 */

import ipaddr from "ipaddr.js";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "./auth.js";

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
          `TRUSTED_PROXY_CIDRS: invalid CIDR "${cidr}": ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
    });
}

/** Normalise an address: strips IPv4-mapped IPv6 (`::ffff:1.2.3.4` →
 *  `1.2.3.4`) so CIDR comparisons across dual-stack peers and v4 chains
 *  work consistently. Returns null for unparseable input. */
function normalise(raw: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
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
      if (addr.match(range as never)) return true;
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
    | { incoming?: { socket?: { remoteAddress?: string } } }
    | undefined;
  return env?.incoming?.socket?.remoteAddress ?? null;
}

/**
 * Extract the effective client IP for the current request.
 *
 * @param c - The Hono context.
 * @param trustedCidrs - Pre-parsed CIDR list (call `parseTrustedProxyCidrs`
 *   once at startup and reuse the result; do not parse per-request).
 * @returns The client IP as a string, or `null` when no peer is available
 *   (mostly in tests with synthetic contexts).
 */
export function getClientIp(
  c: Context,
  trustedCidrs: CidrRange[],
): string | null {
  const peerRaw = readPeer(c);
  if (!peerRaw) return null;

  const peer = normalise(peerRaw);
  if (!peer) return null;

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
    const hop = normalise(hops[i] ?? "");
    if (!hop) continue;
    if (!isInTrusted(hop, trustedCidrs)) return hop.toString();
  }

  return normalise(hops[0] ?? "")?.toString() ?? peer.toString(); // fully-trusted chain: leftmost = original client
}

export type { CidrRange };

/**
 * Resolve the client IP once per request and stash it on
 * `c.var.clientIp` for downstream consumers.
 *
 * Centralising the resolution means routes don't have to thread the
 * `trustedProxyCidrs` config or call `getClientIp(c, ...)` themselves
 * every time they want to record an audit row. Run this BEFORE auth
 * so the resolved IP is available in any downstream middleware
 * (auth itself, rate limiting, route handlers).
 */
export function clientIpMiddleware(
  trustedCidrs: CidrRange[],
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("clientIp", getClientIp(c, trustedCidrs));
    await next();
  };
}
