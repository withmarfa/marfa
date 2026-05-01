import { describe, it, expect } from "vitest";
import { createEchoSuppression } from "./echo-suppression.js";
import { createInMemoryStorage } from "./in-memory-storage.js";

describe("echo suppression", () => {
  it("returns false for an external_id with no recent outbound write", async () => {
    const echo = createEchoSuppression(createInMemoryStorage(), {
      echo_ttl_seconds: 60,
    });
    expect(await echo.shouldSkipReactive("ext_123", "hash_abc")).toBe(false);
  });

  it("returns true when external_id + content_hash match a recent write", async () => {
    const echo = createEchoSuppression(createInMemoryStorage(), {
      echo_ttl_seconds: 60,
    });
    await echo.trackOutboundWrite("ext_123", "hash_abc");
    expect(await echo.shouldSkipReactive("ext_123", "hash_abc")).toBe(true);
  });

  it("returns false when content_hash differs (real external change after our write)", async () => {
    const echo = createEchoSuppression(createInMemoryStorage(), {
      echo_ttl_seconds: 60,
    });
    await echo.trackOutboundWrite("ext_123", "hash_abc");
    expect(await echo.shouldSkipReactive("ext_123", "hash_xyz")).toBe(false);
  });

  it("expires the entry after echo_ttl_seconds elapses", async () => {
    let now = 1_000_000;
    const echo = createEchoSuppression(
      createInMemoryStorage(),
      { echo_ttl_seconds: 60 },
      () => now,
    );
    await echo.trackOutboundWrite("ext_123", "hash_abc");
    now += 30_000;
    expect(await echo.shouldSkipReactive("ext_123", "hash_abc")).toBe(true);
    now += 31_000; // total 61s elapsed
    expect(await echo.shouldSkipReactive("ext_123", "hash_abc")).toBe(false);
  });

  it("inLagWindow tracks regardless of content_hash match", async () => {
    let now = 1_000_000;
    const echo = createEchoSuppression(
      createInMemoryStorage(),
      { echo_ttl_seconds: 60, lag_window_seconds: 120 },
      () => now,
    );
    await echo.trackOutboundWrite("ext_123", "hash_abc");
    expect(await echo.inLagWindow("ext_123")).toBe(true);
    now += 90_000;
    // Past echo TTL but within lag window.
    expect(await echo.inLagWindow("ext_123")).toBe(true);
    now += 31_000; // total 121s
    expect(await echo.inLagWindow("ext_123")).toBe(false);
  });

  it("inLagWindow defaults lag to echo_ttl when not declared", async () => {
    let now = 1_000_000;
    const echo = createEchoSuppression(
      createInMemoryStorage(),
      { echo_ttl_seconds: 60 },
      () => now,
    );
    await echo.trackOutboundWrite("ext_123", "hash_abc");
    expect(await echo.inLagWindow("ext_123")).toBe(true);
    now += 61_000;
    expect(await echo.inLagWindow("ext_123")).toBe(false);
  });
});
