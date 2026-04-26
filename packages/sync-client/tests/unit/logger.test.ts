import { describe, expect, it, afterEach } from "vitest";
import { MymeSyncClient } from "../../src/client.js";
import type { SyncLogger } from "../../src/config.js";

/**
 * Regression: a consumer that supplies a logger object literal exactly
 * matching the `SyncLogger` interface must be able to start and stop
 * the client without a runtime `TypeError`. The previous default tests
 * used the in-package `noopLogger` (which has every method) and would
 * not have caught a divergence between a method called internally and
 * the type the public API documents.
 */

interface CapturedCall {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields?: Record<string, unknown>;
}

function makeCapturingLogger(): {
  logger: SyncLogger;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const logger: SyncLogger = {
    debug(message, fields) {
      calls.push({ level: "debug", message, fields });
    },
    info(message, fields) {
      calls.push({ level: "info", message, fields });
    },
    warn(message, fields) {
      calls.push({ level: "warn", message, fields });
    },
    error(message, fields) {
      calls.push({ level: "error", message, fields });
    },
  };
  return { logger, calls };
}

const clients: MymeSyncClient[] = [];

afterEach(async () => {
  while (clients.length > 0) {
    const c = clients.pop();
    if (c) await c.stop();
  }
});

describe("MymeSyncClient logger compatibility", () => {
  it("starts and stops cleanly with a logger that exactly implements SyncLogger", async () => {
    const { logger } = makeCapturingLogger();
    const client = new MymeSyncClient({
      apiUrl: "http://localhost:0",
      apiKey: "myme_k1_test",
      storage: "memory",
      autoStartSync: false,
      logger,
    });
    clients.push(client);

    await expect(client.start()).resolves.toBeUndefined();
    await expect(client.stop()).resolves.toBeUndefined();
  });

  it("does not invoke `logger.info` from lifecycle paths", async () => {
    // The three call-sites that previously logged at info level
    // ('starting', 'stopping', 'initial snapshot applied') are
    // genuinely lifecycle telemetry. They were downgraded to debug so
    // a consumer wiring `logger.info` to a user-visible surface
    // (toast, status bar) doesn't see boot noise. If a future change
    // accidentally re-introduces an info call from start/stop, this
    // assertion will fail and force the author to think about the
    // level choice.
    const { logger, calls } = makeCapturingLogger();
    const client = new MymeSyncClient({
      apiUrl: "http://localhost:0",
      apiKey: "myme_k1_test",
      storage: "memory",
      autoStartSync: false,
      logger,
    });
    clients.push(client);

    await client.start();
    await client.stop();

    const infoCalls = calls.filter((c) => c.level === "info");
    expect(infoCalls).toEqual([]);
  });
});
