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

  it("inLagWindow deletes the underlying record on expiry (T-016)", async () => {
    // Pre-T-016 a connector that wrote to an external_id and never read
    // it back via shouldSkipReactive would leak the DO storage row
    // forever. inLagWindow now mirrors shouldSkipReactive's
    // expire-on-read so cleanup happens on every access path.
    let now = 1_000_000;
    const storage = createInMemoryStorage();
    const echo = createEchoSuppression(
      storage,
      { echo_ttl_seconds: 60, lag_window_seconds: 60 },
      () => now,
    );
    await echo.trackOutboundWrite("ext_leaked", "hash_x");
    expect(await storage.get("pending_write:ext_leaked")).toBeDefined();

    // Advance past the lag window. inLagWindow returns false AND the
    // record gets deleted as part of the read.
    now += 61_000;
    expect(await echo.inLagWindow("ext_leaked")).toBe(false);
    expect(await storage.get("pending_write:ext_leaked")).toBeUndefined();
  });

  it("expire-on-read holds at scale (1000 records, half un-read, all gone post-window)", async () => {
    // Direct exercise of the AC pattern from T-016: 1000 records, leave
    // half un-read, advance past the lag window, walk every key — all
    // gone. We "walk" by calling inLagWindow on each, since that's now
    // an expire-on-read path.
    let now = 1_000_000;
    const storage = createInMemoryStorage();
    const echo = createEchoSuppression(
      storage,
      { echo_ttl_seconds: 60 },
      () => now,
    );
    const ids = Array.from({ length: 1000 }, (_, i) => `ext_${String(i)}`);
    for (const id of ids) await echo.trackOutboundWrite(id, "hash_x");
    // Read half via shouldSkipReactive (pre-existing path).
    for (let i = 0; i < 500; i++) {
      await echo.shouldSkipReactive(ids[i]!, "hash_x");
    }

    // Advance well past the window so every record is now expired.
    now += 120_000;
    for (const id of ids) {
      // Both paths must clean up.
      await echo.inLagWindow(id);
    }

    // Every storage key must be gone.
    for (const id of ids) {
      expect(await storage.get(`pending_write:${id}`)).toBeUndefined();
    }
  });
});
