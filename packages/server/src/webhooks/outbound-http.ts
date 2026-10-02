/**
 * The one way a webhook delivery reaches the network.
 *
 * **A subscription reaches only public addresses.** Its URL is chosen by
 * whoever holds `webhooks.manage`, and the server sends from inside the
 * network it runs in, so an unchecked URL lets a credential make the server
 * post to its own loopback, the host's private network or a cloud metadata
 * address, and read back from the delivery log whether something answered.
 *
 * The check is made where the connection is opened, not where the URL is
 * stored: a name that resolved to a public address at registration can
 * resolve to a private one at delivery. The address the check passes is the
 * one the socket connects to, so a second resolution cannot swap it, and a
 * redirect is not followed, since following one would connect to an address
 * nobody checked.
 *
 * An operator running receivers on a private network turns the check off
 * with `MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES`.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch } from "undici";

/** Why a delivery reached no receiver, as the delivery log records it. */
export const DELIVERY_FAILURE = {
  notPublic: "The receiver's address is not public.",
  redirect: "The receiver answered with a redirect, which is not followed.",
  timeout: "The receiver did not answer in time.",
  unreachable: "The receiver could not be reached.",
} as const;

class AddressNotPublicError extends Error {
  constructor() {
    super(DELIVERY_FAILURE.notPublic);
  }
}

/**
 * Whether `address` is one a delivery may connect to: a global unicast
 * address, with an IPv4 address written as IPv6 judged as the IPv4 address
 * it carries. Anything ipaddr.js names a special range is refused, which
 * takes in loopback, private, link-local, unique-local, carrier-grade NAT,
 * the unspecified address, multicast, and the translation prefixes that
 * embed an IPv4 address of either kind.
 */
export function isPublicAddress(address: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return false;
  }
  if (parsed.kind() === "ipv6") {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) parsed = v6.toIPv4Address();
  }
  return parsed.range() === "unicast";
}

/** The host of `url` as an address, or null where it is a name. */
function literalAddress(url: URL): string | null {
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  return ipaddr.isValid(host) ? host : null;
}

/**
 * What registration refuses outright: a URL that does not parse, a scheme
 * other than `http` or `https`, credentials in the URL, or, unless private
 * addresses are allowed, a host written as an address that is not public.
 * A name is not resolved here; delivery resolves it each time.
 *
 * Answers the reason, or null where the URL may be stored.
 */
export function refuseWebhookUrl(
  raw: string,
  allowPrivateAddresses: boolean,
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "url must be a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "url must use http or https";
  }
  if (url.username !== "" || url.password !== "") {
    return "url must not carry credentials";
  }
  if (allowPrivateAddresses) return null;
  const literal = literalAddress(url);
  if (literal !== null && !isPublicAddress(literal)) {
    return "url must name a public address";
  }
  return null;
}

/**
 * Resolve as the system resolver does, and refuse the connection unless
 * every address the name resolves to is public. Every rather than any,
 * because a name answering one public and one private address would let
 * the connection land on whichever the socket tried first.
 */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, all) => {
    if (err) {
      callback(err, "", 0);
      return;
    }
    if (all.length === 0 || !all.every((a) => isPublicAddress(a.address))) {
      callback(new AddressNotPublicError(), "", 0);
      return;
    }
    if (options.all === true) {
      (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, all);
      return;
    }
    const first = all[0];
    if (first === undefined) {
      callback(new AddressNotPublicError(), "", 0);
      return;
    }
    callback(null, first.address, first.family);
  });
};

export interface WebhookPost {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

/** What one attempt came to: an HTTP answer, or no answer and why. */
export type WebhookPostOutcome =
  | { kind: "answered"; status: number; retryAfter: string | null }
  | { kind: "redirected"; status: number }
  | { kind: "failed"; error: string };

export interface WebhookHttpClient {
  post(request: WebhookPost): Promise<WebhookPostOutcome>;
}

function hasCause(err: unknown, match: (e: unknown) => boolean): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== undefined; depth++) {
    if (match(current)) return true;
    if (current instanceof AggregateError) {
      if (current.errors.some((e) => hasCause(e, match))) return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/**
 * Name a failure in the delivery log's own words. The transport's message
 * is not stored: it names the address and port it tried, which would turn
 * the log into a map of what answers inside the server's network.
 */
function failureReason(err: unknown): string {
  if (hasCause(err, (e) => e instanceof AddressNotPublicError)) {
    return DELIVERY_FAILURE.notPublic;
  }
  if (
    hasCause(
      err,
      (e) =>
        e instanceof Error &&
        (e.name === "AbortError" || e.name === "TimeoutError"),
    )
  ) {
    return DELIVERY_FAILURE.timeout;
  }
  return DELIVERY_FAILURE.unreachable;
}

/**
 * The client every delivery is sent through. With `allowPrivateAddresses`
 * off, which is the default, a connection opens only to a public address.
 */
export function createWebhookHttpClient(options: {
  allowPrivateAddresses: boolean;
}): WebhookHttpClient {
  const dispatcher = new Agent({
    connect: options.allowPrivateAddresses ? {} : { lookup: publicOnlyLookup },
  });
  return {
    async post(request) {
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return { kind: "failed", error: DELIVERY_FAILURE.unreachable };
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { kind: "failed", error: DELIVERY_FAILURE.unreachable };
      }
      // A literal address opens a socket without a lookup, so the lookup's
      // check never sees it.
      const literal = literalAddress(url);
      if (
        !options.allowPrivateAddresses &&
        literal !== null &&
        !isPublicAddress(literal)
      ) {
        return { kind: "failed", error: DELIVERY_FAILURE.notPublic };
      }
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: request.headers,
          body: request.body,
          redirect: "manual",
          signal: AbortSignal.timeout(request.timeoutMs),
          dispatcher,
        });
        await response.body?.cancel();
        if (response.status >= 300 && response.status < 400) {
          return { kind: "redirected", status: response.status };
        }
        return {
          kind: "answered",
          status: response.status,
          retryAfter: response.headers.get("retry-after"),
        };
      } catch (err) {
        return { kind: "failed", error: failureReason(err) };
      }
    },
  };
}
