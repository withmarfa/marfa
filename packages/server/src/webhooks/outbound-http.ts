/**
 * The one way a webhook delivery reaches the network.
 *
 * **A subscription reaches only public addresses.** Its URL is chosen by
 * whoever holds `webhooks.manage`, and the server sends from inside the
 * network it runs in, so an unchecked URL lets a credential make the server
 * post to its own loopback, the host's private network or a cloud metadata
 * address, and read back from the delivery log whether something answered.
 *
 * The guard is the check made where the connection is opened: a name that
 * resolved to a public address at registration can resolve to a private one
 * at delivery. The address the check passes is the one the socket connects
 * to, so a second resolution cannot swap it, and a redirect is not
 * followed, since following one would connect to an address nobody checked.
 * Registration also resolves a name, so a person whose receiver has a
 * private address is told when they register it, not hours later by the
 * delivery log.
 *
 * An operator running receivers on a private network turns the check off
 * with `MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES`.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup as dnsLookupAll } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch } from "undici";
import { log } from "../middleware/logger.js";
import { scriptedAnswer } from "../control/faults.js";

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
 * An IPv6 address with its dotted IPv4 tail written as two hexadecimal
 * groups, and no zone. ipaddr.js reads any dotted tail as IPv4-mapped, so
 * `::8.8.8.8` in `::/96` would be taken for `::ffff:8.8.8.8`, while libuv
 * writes an address in `::/96` with a dotted tail. Whether an address is
 * mapped is then decided by its bits: `::ffff:808:808` is, `::808:808` is not.
 */
function withHexTail(address: string): string {
  const bare = address.replace(/%.*$/, "");
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (dotted === null) return bare;
  const octets = dotted.slice(2).map(Number);
  if (octets.some((octet) => octet > 255)) return bare;
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  const hex = (high: number, low: number) => (high * 256 + low).toString(16);
  return `${dotted[1] ?? ""}${hex(a, b)}:${hex(c, d)}`;
}

/** Global unicast, the only IPv6 block that is assigned to hosts on the internet. */
const GLOBAL_UNICAST_V6 = ipaddr.IPv6.parseCIDR("2000::/3");

/**
 * Whether `address` is one a delivery may connect to: a global unicast
 * address, with an IPv4 address written as IPv6 judged as the IPv4 address
 * it carries. An IPv4 address must not be in a range ipaddr.js names special,
 * which takes in loopback, private, link-local, carrier-grade NAT, the
 * unspecified address, multicast and the reserved blocks. An IPv6 address
 * must lie in 2000::/3 as well, so every other block is refused whether or
 * not ipaddr.js has a name for it: unique-local, link-local, multicast, the
 * unspecified address, `::/96` and the translation prefixes among them.
 */
export function isPublicAddress(address: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(withHexTail(address));
  } catch {
    return false;
  }
  if (parsed.kind() === "ipv6") {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      parsed = v6.toIPv4Address();
    } else if (!v6.match(GLOBAL_UNICAST_V6)) {
      return false;
    }
  }
  return parsed.range() === "unicast";
}

/** What a refusal at registration says, for an address written out or a name. */
const SETTING_HINT =
  "An operator whose receivers run on a private network can allow it with MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES.";

/** The host of `url` as an address, or null where it is a name. */
function literalAddress(url: URL): string | null {
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  return ipaddr.isValid(host) ? host : null;
}

/**
 * What registration refuses outright: a URL that does not parse, a scheme
 * other than `http` or `https`, credentials in the URL, or, unless private
 * addresses are allowed, a host written as an address that is not public.
 * A host written as a name is `refuseNonPublicHost`'s.
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
    return `url must name a public address. ${SETTING_HINT}`;
  }
  return null;
}

/** How long registration waits for a name to resolve before leaving it to delivery. */
export const REGISTRATION_LOOKUP_TIMEOUT_MS = 3_000;

/**
 * The most lookups registration runs at once. A lookup cannot be cancelled
 * and holds one of the four threads the process shares with its file and
 * database work until the resolver answers, so a name that never answers
 * would otherwise let a few requests take them all. A lookup that finds the
 * limit reached is not made, and the delivery guard decides.
 */
export const MAX_REGISTRATION_LOOKUPS = 2;
let registrationLookups = 0;

async function systemResolve(hostname: string): Promise<string[]> {
  return (await dnsLookupAll(hostname, { all: true })).map((a) => a.address);
}

/**
 * What registration refuses of a host written as a name: one that resolves,
 * now, to any address a delivery would refuse. Any rather than every, since
 * the delivery check refuses a name with one non-public address among
 * public ones, so such a subscription could never be delivered to.
 *
 * Only a definite answer refuses. A name that does not resolve, answers
 * nothing, takes longer than `timeoutMs`, or finds `MAX_REGISTRATION_LOOKUPS`
 * already running is stored: the receiver may not exist yet, a resolver that
 * fails here proves nothing about the one delivery uses, and the guard that
 * holds is the delivery's, which looks again at every attempt. A host written
 * as an address is `refuseWebhookUrl`'s.
 *
 * Answers the reason, or null where the URL may be stored. Call it only
 * where private addresses are not allowed.
 */
export async function refuseNonPublicHost(
  raw: string,
  options: {
    resolve?: (hostname: string) => Promise<string[]>;
    timeoutMs?: number;
  } = {},
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (literalAddress(url) !== null) return null;
  const resolve = options.resolve ?? systemResolve;
  const timeoutMs = options.timeoutMs ?? REGISTRATION_LOOKUP_TIMEOUT_MS;
  if (registrationLookups >= MAX_REGISTRATION_LOOKUPS) return null;
  registrationLookups += 1;
  // The place is given back when the resolver answers, not when the wait
  // ends, since the thread is busy until then.
  const lookup = new Promise<string[]>((answer) => {
    answer(resolve(url.hostname));
  }).finally(() => {
    registrationLookups -= 1;
  });
  let timer: NodeJS.Timeout | undefined;
  let addresses: string[];
  try {
    addresses = await Promise.race([
      lookup,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("lookup timed out"));
        }, timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (addresses.every(isPublicAddress)) return null;
  return `url's host resolves to an address that is not public. ${SETTING_HINT}`;
}

/** A scripted answer's addresses as a lookup returns them. */
function named(addresses: string[]): LookupAddress[] {
  return addresses.map((address) => ({ address, family: isIP(address) }));

}

/**
 * The lookup of an instance that allows private addresses. It is the system
 * resolver, unless a test fault scripts the name.
 */
const systemLookup: LookupFunction = (hostname, options, callback) => {
  const scripted = scriptedAnswer(hostname);
  if (scripted === undefined) {
    dnsLookup(hostname, options, callback);
    return;
  }
  const all = named(scripted.connected);
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
};

/**
 * Refuse the connection unless every address that was checked is public, and
 * connect to the addresses of the same lookup. Every rather than any, because
 * a name answering one public and one private address would let the
 * connection land on whichever the socket tried first.
 */
function settle(
  err: NodeJS.ErrnoException | null,
  checked: LookupAddress[],
  all: LookupAddress[],
  options: Parameters<LookupFunction>[1],
  callback: Parameters<LookupFunction>[2],
): void {
  if (err) {
    callback(err, "", 0);
    return;
  }
  if (
    checked.length === 0 ||
    !checked.every((a) => isPublicAddress(a.address))
  ) {
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
}

/**
 * Resolve as the system resolver does, or as a test fault scripts the name,
 * and connect only to a public address.
 */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  const scripted = scriptedAnswer(hostname);
  if (scripted !== undefined) {
    settle(
      null,
      named(scripted.checked),
      named(scripted.connected),
      options,
      callback,
    );
    return;
  }
  dnsLookup(hostname, { ...options, all: true }, (err, all) => {
    settle(err, all, all, options, callback);
  });
};

export interface WebhookPost {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

/**
 * What one attempt came to: an HTTP answer, or no answer and why. `refused`
 * is no answer that another attempt would not repeat, because the
 * connection was never opened: the instance's own rule forbids it.
 */
export type WebhookPostOutcome =
  | { kind: "answered"; status: number; retryAfter: string | null }
  | { kind: "redirected"; status: number }
  | { kind: "refused"; error: string }
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
    connect: {
      lookup: options.allowPrivateAddresses ? systemLookup : publicOnlyLookup,
    },
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
        return { kind: "refused", error: DELIVERY_FAILURE.notPublic };
      }
      const abort = new AbortController();
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: request.headers,
          body: request.body,
          redirect: "manual",
          signal: AbortSignal.any([
            AbortSignal.timeout(request.timeoutMs),
            abort.signal,
          ]),
          dispatcher,
        });
        const status = response.status;
        const retryAfter = response.headers.get("retry-after");
        try {
          await response.body?.cancel();
        } catch {
          abort.abort();
          log("warn", "Outbound response cleanup required abort", {
            kind: "webhook",
          });
        }
        if (status >= 300 && status < 400) {
          return { kind: "redirected", status };
        }
        return {
          kind: "answered",
          status,
          retryAfter,
        };
      } catch (err) {
        const error = failureReason(err);
        return error === DELIVERY_FAILURE.notPublic
          ? { kind: "refused", error }
          : { kind: "failed", error };
      }
    },
  };
}
