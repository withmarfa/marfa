/**
 * Which addresses the server may connect to when someone else chose the
 * URL, and the connection lookup that holds to it.
 *
 * A webhook subscription and a file an agent asks the server to fetch both
 * name a URL the server then opens from inside the network it runs in. An
 * unchecked URL lets a credential make the server reach its own loopback,
 * the host's private network or a cloud metadata address. The check is made
 * where the connection is opened: the address the check passes is the one
 * the socket connects to, so a second resolution cannot swap it.
 */
import {
  lookup as realDnsLookup,
  type LookupAddress,
  type LookupAllOptions,
} from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import {
  faultsArmed,
  scriptedAnswer,
  scriptedConnectionAddress,
} from "../control/faults.js";

/** A connection refused because an address it would reach is not public. */
export class AddressNotPublicError extends Error {
  constructor(message = "The address is not public.") {
    super(message);
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
 * Whether `address` is one the server may connect to for someone else's
 * URL: a global unicast address, with an IPv4 address written as IPv6
 * judged as the IPv4 address it carries. An IPv4 address must not be in a
 * range ipaddr.js names special, which takes in loopback, private,
 * link-local, carrier-grade NAT, the unspecified address, multicast and the
 * reserved blocks. An IPv6 address must lie in 2000::/3 as well, so every
 * other block is refused whether or not ipaddr.js has a name for it:
 * unique-local, link-local, multicast, the unspecified address, `::/96` and
 * the translation prefixes among them.
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

/**
 * The host of `url` as an address, or null where it is a name. A literal
 * address opens a socket without a lookup, so the lookup's check never sees
 * it, and the caller checks it before connecting.
 */
export function literalAddress(url: URL): string | null {
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  return ipaddr.isValid(host) ? host : null;
}

/** Script only the resolver; the address check always sees its answer. */
function dnsLookup(
  hostname: string,
  options: LookupAllOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    addresses: LookupAddress[],
  ) => void,
): void {
  const scripted = faultsArmed() ? scriptedAnswer(hostname) : undefined;
  if (scripted === undefined) {
    realDnsLookup(hostname, options, callback);
    return;
  }
  callback(
    null,
    scripted.checked.map((address) => ({ address, family: isIP(address) })),
  );
}

/**
 * Refuse the connection unless every address that was checked is public, and
 * connect to the addresses of the same lookup. Every rather than any, because
 * a name answering one public and one private address would let the
 * connection land on whichever the socket tried first.
 */
function settle(
  err: NodeJS.ErrnoException | null,
  all: LookupAddress[],
  options: Parameters<LookupFunction>[1],
  callback: Parameters<LookupFunction>[2],
  allowPrivateAddresses: boolean,
  refusal: string | undefined,
): void {
  if (err) {
    callback(err, "", 0);
    return;
  }
  if (
    all.length === 0 ||
    (!allowPrivateAddresses && !all.every((a) => isPublicAddress(a.address)))
  ) {
    callback(new AddressNotPublicError(refusal), "", 0);
    return;
  }
  if (options.all === true) {
    (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, all);
    return;
  }
  const first = all[0];
  if (first === undefined) {
    callback(new AddressNotPublicError(refusal), "", 0);
    return;
  }
  callback(null, first.address, first.family);
}

/** Map checked public answers onto local sockets without another lookup. */
function localSocketLookup(lookup: LookupFunction): LookupFunction {
  return (hostname, options, callback) => {
    if (!faultsArmed()) {
      lookup(hostname, options, callback);
      return;
    }
    const connected = (address: string) =>
      scriptedConnectionAddress(hostname, address);
    lookup(hostname, options, ((
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family: number,
    ) => {
      if (err) {
        callback(err, "", 0);
        return;
      }
      if (Array.isArray(address)) {
        (callback as unknown as (e: null, a: LookupAddress[]) => void)(
          null,
          address.map((a) => ({
            address: connected(a.address),
            family: isIP(connected(a.address)),
          })),
        );
      } else {
        const mapped = connected(address);
        callback(null, mapped, isIP(mapped) || family);
      }
    }) as Parameters<LookupFunction>[2]);
  };
}

/**
 * The lookup an undici `Agent` connects with. With `allowPrivateAddresses`
 * off, a name resolving to any address that is not public fails with
 * `AddressNotPublicError`, carrying `refusal` as its message.
 */
export function connectionLookup(options: {
  allowPrivateAddresses: boolean;
  refusal?: string;
}): LookupFunction {
  return localSocketLookup((hostname, lookupOptions, callback) => {
    dnsLookup(hostname, { ...lookupOptions, all: true }, (err, all) => {
      settle(
        err,
        all,
        lookupOptions,
        callback,
        options.allowPrivateAddresses,
        options.refusal,
      );
    });
  });
}

/** Whether `err`, or any error it wraps, matches. */
export function hasCause(
  err: unknown,
  match: (e: unknown) => boolean,
): boolean {
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
