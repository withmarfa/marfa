import { Session } from "node:inspector";
import { describe, expect, it, vi } from "vitest";

const noteBulkWork = vi.fn();
vi.mock("./memory-release.js", () => ({ noteBulkWork }));

const { yieldBulkWork } = await import("./yield.js");

describe("yieldBulkWork", () => {
  it("notes that bulk work ran, so the memory it grew is handed back", async () => {
    await yieldBulkWork();
    await yieldBulkWork({ writing: true });
    expect(noteBulkWork).toHaveBeenCalledTimes(2);
  });
});

describe("the collection command", () => {
  it("is answered by this runtime's inspector, and leaves it connectable", async () => {
    const session = new Session();
    session.connect();
    await new Promise<void>((resolve, reject) => {
      session.post("HeapProfiler.collectGarbage", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    await new Promise((resolve) => setImmediate(resolve));
    session.disconnect();
    expect(() => {
      const again = new Session();
      again.connect();
      again.disconnect();
    }).not.toThrow();
  });
});
