import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { liveServerIn, StartedServers } from "./servers.js";

let state: string;
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "marfa-scale-servers-"));
});
afterEach(() => {
  rmSync(state, { recursive: true, force: true });
});

describe("liveServerIn", () => {
  it("names a running process, and nothing for a missing, dead or garbled pid file", () => {
    expect(liveServerIn(state)).toBeNull();
    writeFileSync(join(state, "server.pid"), `${process.pid}\n`);
    expect(liveServerIn(state)).toBe(process.pid);
    writeFileSync(join(state, "server.pid"), "not a number\n");
    expect(liveServerIn(state)).toBeNull();
    writeFileSync(join(state, "server.pid"), "2147483646\n");
    expect(liveServerIn(state)).toBeNull();
  });
});

describe("StartedServers", () => {
  it("refuses a state directory a server runs in, and stops no server it did not start", async () => {
    writeFileSync(join(state, "server.pid"), `${process.pid}\n`);
    const started = new StartedServers();
    expect(() => started.starting(state)).toThrow(/already running/);
    const stopped: string[] = [];
    await started.stopAll(async (dir) => {
      stopped.push(dir);
    });
    expect(stopped).toEqual([]);
  });

  it("stops the servers it started, whether or not one fails to stop", async () => {
    const other = mkdtempSync(join(tmpdir(), "marfa-scale-servers-"));
    try {
      const started = new StartedServers();
      started.starting(state);
      started.starting(other);
      const stopped: string[] = [];
      const failures = await started.stopAll(async (dir) => {
        stopped.push(dir);
        if (dir === state) throw new Error("stuck");
      });
      expect(stopped).toEqual([state, other]);
      expect(failures).toEqual([expect.stringContaining("stuck")]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
