import { describe, it, expect, vi, afterEach } from "vitest";
import { WriteTracker } from "./write-tracker.js";

describe("WriteTracker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves the tracked write and never rejects on success", async () => {
    const tracker = new WriteTracker("last-used");
    let ran = false;
    await expect(
      tracker.track(async () => {
        await Promise.resolve();
        ran = true;
      }),
    ).resolves.toBeUndefined();
    expect(ran).toBe(true);
  });

  it("swallows a failing write — the returned promise resolves, not rejects", async () => {
    const tracker = new WriteTracker("last-used");
    const warn = vi.spyOn(console, "warn").mockImplementation(vi.fn());
    // A write that rejects (e.g. the connection pool was torn down mid-write)
    // must not propagate. This is the unhandled-rejection guard: callers fire
    // last-used stamp with no `.catch()`, so a rejecting write would otherwise
    // be reported as a fault and fail the test run.
    await expect(
      tracker.track(() => Promise.reject(new Error("write CONNECTION_ENDED"))),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("drain() waits for all in-flight writes to settle before resolving", async () => {
    const tracker = new WriteTracker("last-used");
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Start a write that won't complete until we release the gate. Don't
    // await it — this mirrors a fire-and-forget last-used stamp still in
    // flight at shutdown.
    void tracker.track(async () => {
      await gate;
      order.push("write");
    });

    // drain() must not resolve while the write is pending.
    const drained = tracker.drain().then(() => order.push("drain"));
    let drainSettled = false;
    void drained.then(() => {
      drainSettled = true;
    });
    await Promise.resolve();
    expect(drainSettled).toBe(false);

    release();
    await drained;
    // The write settles before drain() resolves.
    expect(order).toEqual(["write", "drain"]);
  });

  it("drain() resolves even when an in-flight write fails", async () => {
    const tracker = new WriteTracker("last-used");
    vi.spyOn(console, "warn").mockImplementation(vi.fn());
    void tracker.track(() => Promise.reject(new Error("boom")));
    await expect(tracker.drain()).resolves.toBeUndefined();
  });

  it("drain() is a no-op when nothing is in flight", async () => {
    const tracker = new WriteTracker("last-used");
    await expect(tracker.drain()).resolves.toBeUndefined();
  });
});
