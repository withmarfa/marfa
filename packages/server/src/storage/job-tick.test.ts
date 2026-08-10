import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isConnectionLostError, logJobTickFailure } from "./job-tick.js";
import { RuntimeCredentialReaper } from "./retention.js";
import type { Storage } from "./interface.js";

/** Shaped the way postgres.js raises them: a plain Error carrying a code. */
function pgError(code: string): Error {
  return Object.assign(new Error(`write ${code} db.example:5432`), { code });
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
  // The codes postgres.js rejects in-flight queries with when the pool
  // closes. The boot-time retryable set carries none of them, so a
  // classifier built on that alone would have missed every real instance.
  it.each(["CONNECTION_ENDED", "CONNECTION_DESTROYED", "CONNECTION_CLOSED"])(
    "recognizes %s",
    (code) => {
      expect(isConnectionLostError(pgError(code))).toBe(true);
    },
  );

  it("recognizes the network-shaped failures the boot wait already knows", () => {
    expect(isConnectionLostError(pgError("ECONNRESET"))).toBe(true);
  });

  it("follows the causal chain, since postgres.js wraps some failures", () => {
    const wrapped = new Error("query failed", {
      cause: pgError("CONNECTION_DESTROYED"),
    });
    expect(isConnectionLostError(wrapped)).toBe(true);
  });

  it("rejects a failure the statement caused itself", () => {
    expect(isConnectionLostError(pgError("42703"))).toBe(false);
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
    logJobTickFailure(
      "Runtime credential reap",
      pgError("CONNECTION_DESTROYED"),
      true,
    );
    captured.restore();

    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]?.level).toBe("info");
    expect(captured.lines[0]?.message).toBe(
      "Runtime credential reap stood down",
    );
  });

  it("keeps error for a connection failure while the job is still running", () => {
    const captured = captureLog();
    logJobTickFailure(
      "Runtime credential reap",
      pgError("CONNECTION_DESTROYED"),
      false,
    );
    captured.restore();

    expect(captured.lines[0]?.level).toBe("error");
    expect(captured.lines[0]?.message).toBe("Runtime credential reap error");
  });

  it("keeps error for a genuine query failure during shutdown", () => {
    // Being stopped is not on its own a reason to discount a failure: a
    // broken statement is broken whenever it runs.
    const captured = captureLog();
    logJobTickFailure("Runtime credential reap", pgError("42703"), true);
    captured.restore();

    expect(captured.lines[0]?.level).toBe("error");
  });
});

describe("a retention job interrupted by shutdown", () => {
  function rejectingStorage(err: Error): Storage {
    return {
      keys: {
        revokeExpiredRuntimeCredentials: () => Promise.reject(err),
        revokeRuntimeCredentialsWithoutExpiryOlderThan: () =>
          Promise.resolve(0),
        deleteRevokedRuntimeCredentialsOlderThan: () => Promise.resolve(0),
      },
    } as unknown as Storage;
  }

  it("reports at error while running and at info once stopped", async () => {
    const reaper = new RuntimeCredentialReaper(
      rejectingStorage(pgError("CONNECTION_DESTROYED")),
      3_600_000,
      3_600_000,
    );

    const running = captureLog();
    await reaper.pollForTest();
    running.restore();

    // Shutdown stops every job before it closes the pool, so this ordering
    // is the one the process actually produces.
    reaper.stop();

    const stopped = captureLog();
    await reaper.pollForTest();
    stopped.restore();

    expect(running.lines[0]?.level).toBe("error");
    expect(stopped.lines[0]?.level).toBe("info");
    expect(stopped.lines[0]?.message).toBe(
      "Runtime credential reap stood down",
    );
  });

  it("still reports a real fault at error after shutdown began", async () => {
    const reaper = new RuntimeCredentialReaper(
      rejectingStorage(new Error("relation api_keys does not exist")),
      3_600_000,
      3_600_000,
    );
    reaper.stop();

    const captured = captureLog();
    await reaper.pollForTest();
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
