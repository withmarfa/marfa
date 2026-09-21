import { describe, it, expect, vi, afterEach } from "vitest";
import { isConnectionLostError, logJobTickFailure } from "./job-tick.js";

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
  it("stands a canceled run down at info", () => {
    const captured = captureLog();
    logJobTickFailure(
      "Housekeeping revoked-key-reap",
      dbError("CLIENT_CLOSED"),
      true,
    );
    captured.restore();

    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]?.level).toBe("info");
    expect(captured.lines[0]?.message).toBe(
      "Housekeeping revoked-key-reap stood down",
    );
  });

  it("keeps error for a connection failure while the job is still running", () => {
    const captured = captureLog();
    logJobTickFailure(
      "Housekeeping revoked-key-reap",
      dbError("CLIENT_CLOSED"),
      false,
    );
    captured.restore();

    expect(captured.lines[0]?.level).toBe("error");
    expect(captured.lines[0]?.message).toBe(
      "Housekeeping revoked-key-reap error",
    );
  });

  it("keeps error for a genuine query failure during shutdown", () => {
    // Being stopped is not on its own a reason to discount a failure: a
    // broken statement is broken whenever it runs.
    const captured = captureLog();
    logJobTickFailure(
      "Housekeeping revoked-key-reap",
      dbError("SQLITE_ERROR"),
      true,
    );
    captured.restore();

    expect(captured.lines[0]?.level).toBe("error");
  });
});
