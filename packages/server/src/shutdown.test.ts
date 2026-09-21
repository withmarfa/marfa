/**
 * The shutdown sequence, in the order that keeps each step's records
 * writable, with each bound reported on its own and the exit code telling
 * a cut-short sweep from a close that did not complete.
 */
import { describe, expect, it, vi } from "vitest";
import { shutdownInOrder, type ShutdownParts } from "./shutdown.js";

const BOUNDS = { stepTimeoutMs: 40, telemetryFlushTimeoutMs: 40 };

/** Fakes that record what was called, in order, and can be held open. */
function parts(
  hold: {
    housekeeping?: boolean;
    server?: boolean;
    storage?: boolean;
  } = {},
) {
  const events: string[] = [];
  const fakes: ShutdownParts = {
    webhookConsumer: {
      stop: () => {
        events.push("webhooks.stop");
      },
    },
    bulkActionWorker: {
      stop: () => {
        events.push("bulk-actions.stop");
      },
    },
    housekeeping: {
      stop: () => {
        events.push("housekeeping.stop");
        return new Promise<void>((resolve) => {
          if (hold.housekeeping) return;
          setTimeout(() => {
            events.push("housekeeping.stopped");
            resolve();
          }, 10);
        });
      },
    },
    server: {
      close: (cb) => {
        events.push("server.close");
        if (!hold.server) cb?.();
      },
      closeIdleConnections: () => {
        events.push("server.closeIdleConnections");
      },
    },
    storage: {
      close: () => {
        events.push("storage.close");
        return hold.storage
          ? new Promise<never>(() => undefined)
          : Promise.resolve();
      },
    },
    flushTelemetry: () => {
      events.push("telemetry.flush");
      return Promise.resolve();
    },
  };
  return { events, fakes };
}

describe("shutdownInOrder", () => {
  it("stops the poll before the server drains, waits for runs before the storage closes, and flushes last", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { events, fakes } = parts();
    expect(await shutdownInOrder(fakes, BOUNDS)).toBe(0);
    expect(events).toEqual([
      "webhooks.stop",
      "bulk-actions.stop",
      "housekeeping.stop",
      "server.close",
      "server.closeIdleConnections",
      "housekeeping.stopped",
      "storage.close",
      "telemetry.flush",
    ]);
    vi.restoreAllMocks();
  });

  it("keeps exit code 0 when housekeeping outlives its bound, and still closes the storage", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { events, fakes } = parts({ housekeeping: true });
    expect(await shutdownInOrder(fakes, BOUNDS)).toBe(0);
    expect(events).toContain("storage.close");
    expect(events).toContain("telemetry.flush");
    expect(events).not.toContain("housekeeping.stopped");
    vi.restoreAllMocks();
  });

  it("answers 1 when the server or the storage does not close in time, and flushes anyway", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const server = parts({ server: true });
    expect(await shutdownInOrder(server.fakes, BOUNDS)).toBe(1);
    expect(server.events).toContain("telemetry.flush");
    const storage = parts({ storage: true });
    expect(await shutdownInOrder(storage.fakes, BOUNDS)).toBe(1);
    expect(storage.events).toContain("telemetry.flush");
    vi.restoreAllMocks();
  });
});
