import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isConnectionLostError, logJobTickFailure } from "./job-tick.js";
import { RevokedKeyReaper } from "./retention.js";
import type { Storage } from "./interface.js";

/** Shaped the way libsql raises them: an Error carrying a code. */
function dbError(code: string): Error {
  return Object.assign(new Error(`libsql ${code}`), { code });
}

interface CapturedLine {
  level: string;
  message: string;
  error?: string;
}

/** Collects the JSON lines `log()` writes, which is its only observable. */
function captureLog(): { lines: CapturedLine[]; restore: () => void } {
  const lines: CapturedLine[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      lines.push(JSON.parse(String(chunk)) as CapturedLine);
      return true;
    });
  return {
    lines,
    restore: () => {
      spy.mockRestore();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isConnectionLostError", () => {
  // The code libsql rejects a query with once the client is closed.
  it("recognizes CLIENT_CLOSED", () => {
    expect(isConnectionLostError(dbError("CLIENT_CLOSED"))).toBe(true);
  });

  it("follows the causal chain, since a wrapped failure carries the code on its cause", () => {
    const wrapped = new Error("query failed", {
      cause: dbError("CLIENT_CLOSED"),
    });
    expect(isConnectionLostError(wrapped)).toBe(true);
  });

  it("rejects a failure the statement caused itself", () => {
    expect(isConnectionLostError(dbError("SQLITE_ERROR"))).toBe(false);
    expect(isConnectionLostError(new Error("column does not exist"))).toBe(
      false,
    );
    expect(isConnectionLostError("db gone")).toBe(false);
    expect(isConnectionLostError(null)).toBe(false);
  });
});

describe("logJobTickFailure", () => {
  it("stands a cancelled tick down at info", () => {
    const captured = captureLog();
    logJobTickFailure("Revoked key reap", dbError("CLIENT_CLOSED"), true);
    captured.restore();

    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]?.level).toBe("info");
    expect(captured.lines[0]?.message).toBe("Revoked key reap stood down");
  });

  it("keeps error for a connection failure while the job is still running", () => {
    const captured = captureLog();
    logJobTickFailure("Revoked key reap", dbError("CLIENT_CLOSED"), false);
    captured.restore();

    expect(captured.lines[0]?.level).toBe("error");
    expect(captured.lines[0]?.message).toBe("Revoked key reap error");
  });

  it("keeps error for a genuine query failure during shutdown", () => {
    // Being stopped is not on its own a reason to discount a failure: a
    // broken statement is broken whenever it runs.
    const captured = captureLog();
    logJobTickFailure("Revoked key reap", dbError("SQLITE_ERROR"), true);
    captured.restore();

    expect(captured.lines[0]?.level).toBe("error");
  });
});

describe("a retention job interrupted by shutdown", () => {
  function rejectingStorage(err: Error): Storage {
    return {
      keys: {
        deleteRevokedKeysOlderThan: () => Promise.reject(err),
      },
    } as unknown as Storage;
  }

  it("reports at error while running and at info once stopped", async () => {
    const reaper = new RevokedKeyReaper(
      rejectingStorage(dbError("CLIENT_CLOSED")),
      3_600_000,
    );

    const running = captureLog();
    await reaper.runScheduled();
    running.restore();

    // Shutdown stops every job before it closes the client, so this ordering
    // is the one the process actually produces.
    reaper.stop();

    const stopped = captureLog();
    await reaper.runScheduled();
    stopped.restore();

    expect(running.lines[0]?.level).toBe("error");
    expect(stopped.lines[0]?.level).toBe("info");
    expect(stopped.lines[0]?.message).toBe("Revoked key reap stood down");
  });

  it("still reports a real fault at error after shutdown began", async () => {
    const reaper = new RevokedKeyReaper(
      rejectingStorage(new Error("relation api_keys does not exist")),
      3_600_000,
    );
    reaper.stop();

    const captured = captureLog();
    await reaper.runScheduled();
    captured.restore();

    expect(captured.lines[0]?.level).toBe("error");
  });
});

describe("every periodic job routes its failures through one classifier", () => {
  // The level was wrong in seven places because the rule was written seven
  // times. A new job copying the old shape is the way that comes back.
  it.each(["retention.ts", "version-thinner.ts"])(
    "%s reports no failure at error directly",
    (file) => {
      const source = readFileSync(
        fileURLToPath(new URL(file, import.meta.url)),
        "utf8",
      );
      expect(source).not.toContain('log("error"');
      expect(source).toContain("logJobTickFailure(");
    },
  );
});
