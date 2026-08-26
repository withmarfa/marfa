import { describe, it, expect } from "vitest";
import {
  createEchoSuppression,
  expiredEchoMarkerKeys,
  settleEchoMarkers,
  ECHO_MARKER_PREFIX,
} from "./echo-suppression.js";
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

  it("inLagWindow deletes the underlying record on expiry", async () => {
    // An integration that writes to an external_id and never reads it back
    // via shouldSkipReactive would leak the storage row forever.
    // inLagWindow mirrors shouldSkipReactive's expire-on-read so cleanup
    // happens on every access path.
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
    // 1000 records, leave half un-read, advance past the lag window,
    // walk every key — all gone. We "walk" by calling inLagWindow on
    // each, since that's an expire-on-read path.
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

describe("markers survive the gap between being written and being visible", () => {
  it("a marker from a long dispatch is still live once it commits", async () => {
    // The defect: a handler runs in a worker thread whose writes are
    // journalled and applied when the dispatch returns. A marker written
    // at minute one of a ten-minute run is unreadable until minute ten,
    // and stamped from the write clock it is expired on arrival — so the
    // first echo webhook goes straight through, deleting the record as it
    // goes.
    let clock = 1_000_000;
    const storage = createInMemoryStorage();
    const echo = createEchoSuppression(
      storage,
      { echo_ttl_seconds: 60 },
      () => clock,
    );

    await echo.trackOutboundWrite("ext_1", "hash_a");

    // The journalled write, as the substrate would hand it over.
    const updates: Record<string, unknown> = {
      [`${ECHO_MARKER_PREFIX}ext_1`]: await storage.get(
        `${ECHO_MARKER_PREFIX}ext_1`,
      ),
    };

    // Ten minutes of dispatch, then the commit.
    clock += 10 * 60_000;
    settleEchoMarkers(updates, clock);
    await storage.put(
      `${ECHO_MARKER_PREFIX}ext_1`,
      updates[`${ECHO_MARKER_PREFIX}ext_1`],
    );

    // The echo webhook, arriving a second after the commit.
    clock += 1_000;
    expect(await echo.shouldSkipReactive("ext_1", "hash_a")).toBe(true);
  });

  it("still expires, a TTL after it became visible", async () => {
    // The control. Without it, a rebase that simply never expired would
    // pass the test above and suppress genuine inbound changes forever.
    let clock = 1_000_000;
    const storage = createInMemoryStorage();
    const echo = createEchoSuppression(
      storage,
      { echo_ttl_seconds: 60 },
      () => clock,
    );

    await echo.trackOutboundWrite("ext_1", "hash_a");
    const key = `${ECHO_MARKER_PREFIX}ext_1`;
    const updates: Record<string, unknown> = { [key]: await storage.get(key) };

    clock += 10 * 60_000;
    settleEchoMarkers(updates, clock);
    await storage.put(key, updates[key]);

    // 61 seconds after the commit, not after the write.
    clock += 61_000;
    expect(await echo.shouldSkipReactive("ext_1", "hash_a")).toBe(false);
  });

  it("leaves a marker from an older build alone rather than reviving it", () => {
    // A record with no `ttl_ms` predates the rebase. Expiring early is a
    // missed suppression; inventing a TTL for it could suppress a real
    // change indefinitely, so the conservative direction is to skip it.
    const updates: Record<string, unknown> = {
      [`${ECHO_MARKER_PREFIX}old`]: {
        content_hash: "h",
        expires_at_ms: 500,
      },
    };
    settleEchoMarkers(updates, 1_000_000);
    expect(updates[`${ECHO_MARKER_PREFIX}old`]).toEqual({
      content_hash: "h",
      expires_at_ms: 500,
    });
  });

  it("does not touch cursor keys that merely sit alongside markers", () => {
    // The cursor value deliberately carries BOTH fields the rebase reads.
    // A plainer fixture is excluded by the shape guard whether or not the
    // prefix is checked, so it would pin nothing: only a value the rebase
    // would otherwise rewrite proves the prefix is what keeps it out.
    // Contrived, but an integration's cursor is free-form JSON and this
    // is the only input that can fail if the check is removed.
    const cursorValue = { content_hash: "h", ttl_ms: 999, page: 3 };
    const updates: Record<string, unknown> = { "cursor:main": cursorValue };
    settleEchoMarkers(updates, 1_000_000);
    expect(updates["cursor:main"]).toEqual(cursorValue);
  });
});

describe("expired markers are swept rather than accumulating", () => {
  it("names expired markers and leaves live ones and cursors alone", () => {
    const cursors: Record<string, unknown> = {
      [`${ECHO_MARKER_PREFIX}dead`]: {
        content_hash: "h",
        ttl_ms: 60_000,
        expires_at_ms: 500,
      },
      [`${ECHO_MARKER_PREFIX}live`]: {
        content_hash: "h",
        ttl_ms: 60_000,
        expires_at_ms: 2_000_000,
      },
      "cursor:main": { page: 3 },
    };
    expect(expiredEchoMarkerKeys(cursors, 1_000_000)).toEqual([
      `${ECHO_MARKER_PREFIX}dead`,
    ]);
  });

  it("returns nothing when every marker is live", () => {
    // The floor. "No expired markers" and "no markers at all" are the
    // same empty array, and only one of them means the sweep worked.
    const cursors: Record<string, unknown> = {
      [`${ECHO_MARKER_PREFIX}live`]: {
        content_hash: "h",
        ttl_ms: 60_000,
        expires_at_ms: 2_000_000,
      },
    };
    expect(expiredEchoMarkerKeys(cursors, 1_000_000)).toEqual([]);
  });
});
