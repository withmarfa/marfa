import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import { getClientIp, parseTrustedProxyCidrs } from "./client-ip.js";

// ---------------------------------------------------------------------------
// Helpers — synthesise a minimal Hono context with peer address + headers.
// ---------------------------------------------------------------------------

function makeContext(args: {
  peer?: string | undefined;
  xff?: string | undefined;
}): Context {
  const headers = new Map<string, string>();
  if (args.xff !== undefined) headers.set("x-forwarded-for", args.xff);
  return {
    env: args.peer
      ? { incoming: { socket: { remoteAddress: args.peer } } }
      : {},
    req: {
      header: (name: string) => headers.get(name.toLowerCase()),
    },
  } as unknown as Context;
}

// ---------------------------------------------------------------------------
// parseTrustedProxyCidrs
// ---------------------------------------------------------------------------

describe("parseTrustedProxyCidrs", () => {
  it("returns empty list when env var is unset or blank", () => {
    expect(parseTrustedProxyCidrs(undefined)).toEqual([]);
    expect(parseTrustedProxyCidrs("")).toEqual([]);
    expect(parseTrustedProxyCidrs("   ")).toEqual([]);
  });

  it("parses a single CIDR", () => {
    const ranges = parseTrustedProxyCidrs("10.0.0.0/8");
    expect(ranges).toHaveLength(1);
  });

  it("parses a comma-separated list of CIDRs", () => {
    const ranges = parseTrustedProxyCidrs("10.0.0.0/8,127.0.0.1/32,::1/128");
    expect(ranges).toHaveLength(3);
  });

  it("trims whitespace around entries", () => {
    const ranges = parseTrustedProxyCidrs(" 10.0.0.0/8 , 127.0.0.1/32 ");
    expect(ranges).toHaveLength(2);
  });

  it("throws loudly on a malformed CIDR", () => {
    expect(() => parseTrustedProxyCidrs("not-a-cidr")).toThrow(
      /TRUSTED_PROXY_CIDRS/,
    );
    expect(() => parseTrustedProxyCidrs("10.0.0.0/8,bogus")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// getClientIp — algorithm
// ---------------------------------------------------------------------------

describe("getClientIp", () => {
  it("returns null when no peer address is available", () => {
    const c = makeContext({});
    expect(getClientIp(c, [])).toBeNull();
  });

  it("returns peer when no proxy is trusted (header present but ignored)", () => {
    const c = makeContext({ peer: "203.0.113.5", xff: "1.2.3.4" });
    expect(getClientIp(c, [])).toBe("203.0.113.5");
  });

  it("returns peer when proxy is trusted but no header is set", () => {
    const trusted = parseTrustedProxyCidrs("10.0.0.0/8");
    const c = makeContext({ peer: "10.0.0.1" });
    expect(getClientIp(c, trusted)).toBe("10.0.0.1");
  });

  it("returns peer when peer is NOT in trusted set even if XFF is present", () => {
    const trusted = parseTrustedProxyCidrs("10.0.0.0/8");
    const c = makeContext({ peer: "203.0.113.5", xff: "1.2.3.4" });
    expect(getClientIp(c, trusted)).toBe("203.0.113.5");
  });

  it("returns the leftmost untrusted hop when peer is trusted (single hop)", () => {
    const trusted = parseTrustedProxyCidrs("10.0.0.0/8");
    const c = makeContext({ peer: "10.0.0.1", xff: "203.0.113.5" });
    expect(getClientIp(c, trusted)).toBe("203.0.113.5");
  });

  it("walks a chained XFF right-to-left, skipping trusted hops", () => {
    const trusted = parseTrustedProxyCidrs("10.0.0.0/8");
    // chain: client → trusted-proxy-1 → trusted-proxy-2 (peer)
    const c = makeContext({
      peer: "10.0.0.2",
      xff: "203.0.113.5, 10.0.0.1",
    });
    expect(getClientIp(c, trusted)).toBe("203.0.113.5");
  });

  it("returns leftmost when the entire chain is trusted (vouched-for client)", () => {
    const trusted = parseTrustedProxyCidrs("10.0.0.0/8");
    const c = makeContext({
      peer: "10.0.0.2",
      xff: "10.0.0.99, 10.0.0.1",
    });
    expect(getClientIp(c, trusted)).toBe("10.0.0.99");
  });

  it("normalises IPv4-mapped IPv6 on the peer", () => {
    const c = makeContext({ peer: "::ffff:203.0.113.5" });
    expect(getClientIp(c, [])).toBe("203.0.113.5");
  });

  it("normalises IPv4-mapped IPv6 on a forwarded hop", () => {
    const trusted = parseTrustedProxyCidrs("10.0.0.0/8");
    const c = makeContext({
      peer: "10.0.0.1",
      xff: "::ffff:203.0.113.5",
    });
    expect(getClientIp(c, trusted)).toBe("203.0.113.5");
  });

  it("handles an IPv6 chain with trusted IPv6 proxy", () => {
    const trusted = parseTrustedProxyCidrs("fd00::/8");
    const c = makeContext({
      peer: "fd00::1",
      xff: "2001:db8::5",
    });
    expect(getClientIp(c, trusted)).toBe("2001:db8::5");
  });

  it("ignores unparseable hops and continues walking", () => {
    const trusted = parseTrustedProxyCidrs("10.0.0.0/8");
    const c = makeContext({
      peer: "10.0.0.1",
      xff: "garbage, 203.0.113.5",
    });
    expect(getClientIp(c, trusted)).toBe("203.0.113.5");
  });
});
