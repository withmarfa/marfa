import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as logger from "./middleware/logger.js";
import { installUnhandledRejectionReporter } from "./process-faults.js";

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.__marfaReportException = undefined;
});

describe("an unhandled rejection", () => {
  it("is logged and reported, and the process listens for it so it does not end", () => {
    const proc = new EventEmitter();
    const logged = vi.spyOn(logger, "log");
    const reported: unknown[] = [];
    globalThis.__marfaReportException = (err) => {
      reported.push(err);
    };
    expect(proc.listenerCount("unhandledRejection")).toBe(0);
    installUnhandledRejectionReporter((event, listener) => {
      proc.on(event, listener);
    });
    expect(proc.listenerCount("unhandledRejection")).toBe(1);

    const reason = new Error("nobody waited on this");
    proc.emit("unhandledRejection", reason, Promise.resolve());

    expect(reported).toEqual([reason]);
    expect(
      logged.mock.calls.some(
        ([level, message]) =>
          level === "error" && message === "Unhandled promise rejection",
      ),
    ).toBe(true);
  });
});
