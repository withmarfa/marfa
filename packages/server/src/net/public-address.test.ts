import { describe, expect, it } from "vitest";
import { isPublicAddress } from "./public-address.js";

describe("isPublicAddress", () => {
  it("takes global unicast addresses and refuses every special range", () => {
    for (const address of ["93.184.215.14", "8.8.8.8", "2606:4700::1"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "255.255.255.255",
      "224.0.0.1",
      "192.0.2.1",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "fc00::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "64:ff9b::a00:1",
      "2002:a00:1::",
      "2001:db8::1",
      "not an address",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("takes an IPv6 address only inside 2000::/3, after an IPv4-mapped one is read as the IPv4 address it carries", () => {
    for (const address of [
      "2606:4700:4700::1111",
      "2a00:1450:4009:81f::200e",
      "2000::1",
      "3fff:ffff::1",
      "::ffff:8.8.8.8",
    ]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    for (const address of [
      // Outside 2000::/3.
      // `::/96`, written with the dotted tail libuv gives an address: refused
      // as `::/96`, whatever the IPv4 address in its last 32 bits is.
      "::10.0.0.1",
      "::8.8.8.8",
      "::93.184.215.14",
      "::a00:1",
      "::7f00:1",
      "::808:808",
      "::ffff:0:808:808",
      "64:ff9b::808:808",
      "64:ff9b:1::1",
      "fc00::1",
      "fe80::1",
      "fe80::1%eth0",
      "ff02::1",
      "ff0e::1",
      "1fff::1",
      "4000::1",
      "8000::1",
      "e000::1",
      // Special blocks inside 2000::/3.
      "2001::1",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "2001:10::1",
      "2001:20::1",
      "2001:db8::1",
      "2002:808:808::1",
      "3fff::1",
      // IPv4-mapped, judged as the IPv4 address it carries.
      "::ffff:10.0.0.1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("judges an IPv4 address written as IPv6 as the IPv4 address it carries", () => {
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicAddress("::ffff:192.168.0.1")).toBe(false);
  });
});
