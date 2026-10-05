/**
 * The shutdown sequence: streams told first, then the server and the work in
 * flight drained together, the storage closed only after both, each bound
 * reported on its own, and the whole of it inside the grace a container
 * runtime gives a stopped process.
 */
import { describe, expect, it, vi } from "vitest";
import {
  IN_FLIGHT_WORK_TIMEOUT_MS,
  SERVER_CLOSE_TIMEOUT_MS,
  STORAGE_CLOSE_TIMEOUT_MS,
  TELEMETRY_FLUSH_TIMEOUT_MS,
  shutdownInOrder,
  type ShutdownBounds,
  type ShutdownParts,
} from "./shutdown.js";

const BOUNDS: ShutdownBounds = {
  serverCloseTimeoutMs: 40,
  inFlightWorkTimeoutMs: 40,
  storageCloseTimeoutMs: 40,
  telemetryFlushTimeoutMs: 40,
};

/** Fakes that record what was called, in order, and can be held open. */
function parts(
  hold: {
    housekeeping?: boolean;
    bulkActions?: boolean;
    server?: boolean;
    storage?: boolean;
  } = {},
  delays: { housekeeping?: number; bulkActions?: number; server?: number } = {},
) {
  const events: string[] = [];
  const settleAfter = (ms: number, then: () => void) =>
    new Promise<void>((resolve) => {
      setTimeout(() => {
        then();
        resolve();
      }, ms);
    });
  const fakes: ShutdownParts = {
    bulkActionWorker: {
      stop: () => {
        events.push("bulk-actions.stop");
        if (hold.bulkActions) return new Promise<void>(() => undefined);
        return settleAfter(delays.bulkActions ?? 10, () => {
          events.push("bulk-actions.stopped");
        });
      },
    },
    housekeeping: {
      stop: () => {
        events.push("housekeeping.stop");
        if (hold.housekeeping) return new Promise<void>(() => undefined);
        return settleAfter(delays.housekeeping ?? 10, () => {
          events.push("housekeeping.stopped");
        });
      },
    },
    streams: {
      endAll: () => {
        events.push("streams.end");
        return 2;
      },
    },
    server: {
      close: (cb) => {
        events.push("server.close");
        if (hold.server) return;
        setTimeout(() => {
          events.push("server.closed");
          cb?.();
        }, delays.server ?? 10);
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

function quiet() {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
}

describe("shutdownInOrder", () => {
  it("ends the streams, then drains the server and the work in flight, closes the storage only after both, and flushes last", async () => {
    quiet();
    const { events, fakes } = parts();

    expect(await shutdownInOrder(fakes, BOUNDS)).toBe(0);

    expect(events.slice(0, 5)).toEqual([
      "bulk-actions.stop",
      "housekeeping.stop",
      "streams.end",
      "server.close",
      "server.closeIdleConnections",
    ]);
    const at = (event: string) => events.indexOf(event);
    expect(at("storage.close")).toBeGreaterThan(at("server.closed"));
    expect(at("storage.close")).toBeGreaterThan(at("bulk-actions.stopped"));
    expect(at("storage.close")).toBeGreaterThan(at("housekeeping.stopped"));
    expect(events.at(-1)).toBe("telemetry.flush");
    vi.restoreAllMocks();
  });

  it("waits for the bulk action in flight, not only for the housekeeping runs, before it closes the storage", async () => {
    quiet();
    const { events, fakes } = parts({}, { bulkActions: 25, housekeeping: 1 });

    await shutdownInOrder(fakes, { ...BOUNDS, inFlightWorkTimeoutMs: 200 });

    expect(events.indexOf("bulk-actions.stopped")).toBeGreaterThan(-1);
    expect(events.indexOf("storage.close")).toBeGreaterThan(
      events.indexOf("bulk-actions.stopped"),
    );
    vi.restoreAllMocks();
  });

  it("drains the server and the work in flight together, so the wait is the longer of the two and not their sum", async () => {
    quiet();
    const { fakes } = parts(
      {},
      { server: 60, housekeeping: 60, bulkActions: 60 },
    );

    const started = Date.now();
    await shutdownInOrder(fakes, {
      ...BOUNDS,
      serverCloseTimeoutMs: 500,
      inFlightWorkTimeoutMs: 500,
    });
    const elapsed = Date.now() - started;

    // One wait of about 60 ms; in sequence it would be 120 or more.
    expect(elapsed).toBeLessThan(110);
    vi.restoreAllMocks();
  });

  it("keeps exit code 0 when housekeeping or the bulk worker outlives its bound, and still closes the storage", async () => {
    quiet();
    for (const hold of [{ housekeeping: true }, { bulkActions: true }]) {
      const { events, fakes } = parts(hold);
      expect(await shutdownInOrder(fakes, BOUNDS)).toBe(0);
      expect(events).toContain("storage.close");
      expect(events).toContain("telemetry.flush");
    }
    vi.restoreAllMocks();
  });

  it("answers 1 when the server or the storage does not close in time, and flushes anyway", async () => {
    quiet();
    const server = parts({ server: true });
    expect(await shutdownInOrder(server.fakes, BOUNDS)).toBe(1);
    expect(server.events).toContain("telemetry.flush");
    const storage = parts({ storage: true });
    expect(await shutdownInOrder(storage.fakes, BOUNDS)).toBe(1);
    expect(storage.events).toContain("telemetry.flush");
    vi.restoreAllMocks();
  });

  // A client that keeps its connection alive hands it back, idle, once its
  // stream has ended, which is after a single sweep has already run.
  it("keeps closing idle connections until the server has closed, since a stream's connection goes idle only after it ends", async () => {
    quiet();
    const { events, fakes } = parts({}, { server: 120 });

    await shutdownInOrder(fakes, {
      ...BOUNDS,
      serverCloseTimeoutMs: 500,
      inFlightWorkTimeoutMs: 500,
    });

    expect(
      events.filter((event) => event === "server.closeIdleConnections").length,
    ).toBeGreaterThan(2);
    vi.restoreAllMocks();
  });

  it("goes on to close the server when ending the streams throws", async () => {
    quiet();
    const { events, fakes } = parts();
    fakes.streams.endAll = () => {
      throw new Error("a stream would not end");
    };

    expect(await shutdownInOrder(fakes, BOUNDS)).toBe(0);
    expect(events).toContain("server.close");
    expect(events).toContain("storage.close");
    vi.restoreAllMocks();
  });

  // The runtime's grace is ten seconds by default and the process is
  // killed at its end. Every bound that can be spent in turn, with the
  // drain that runs beside the server's counted once, has to leave room
  // for what the process does after it, such as a replicator's last sync.
  it("fits its worst case inside the ten seconds a container runtime gives a stopped process, with room to spare", () => {
    const GRACE_MS = 10_000;
    const worst =
      Math.max(SERVER_CLOSE_TIMEOUT_MS, IN_FLIGHT_WORK_TIMEOUT_MS) +
      STORAGE_CLOSE_TIMEOUT_MS +
      TELEMETRY_FLUSH_TIMEOUT_MS;

    expect(worst).toBeLessThanOrEqual(GRACE_MS - 2_000);
  });
});
