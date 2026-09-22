import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { bootFreshServer, type FreshServer } from "../../utils/fresh-server.js";

/**
 * What a write answers when it meets the write lock and never gets it.
 *
 * **The lock is held from outside the process, deliberately.** Firing
 * concurrent writes at the server does not reach it: the client
 * serializes its own calls, so two of this process's transactions do not
 * overlap. What does reach it in ordinary running is the housekeeping
 * scheduler's transaction interleaving with the request path, and that
 * is a race a fixture would have to win rather than arrange. A second
 * connection sitting in `BEGIN IMMEDIATE` on the same file holds exactly
 * the lock the server's next write asks for, every time, which makes the
 * refusal something to assert instead of something to hope for. It is
 * also a real case: `connection.ts` names a sidecar's checkpoint as the
 * other holder.
 *
 * Two servers, because the claim is about a setting. One booted with the
 * busy budget at zero, where the first `SQLITE_BUSY` is the answer; one
 * on the default, where the retry outwaits a lock held briefly and the
 * same write lands. A fixture doing this against the run's shared server
 * would change the budget for every other file on the instance.
 */
let impatient: FreshServer | undefined;
let patient: FreshServer | undefined;

beforeAll(async () => {
  impatient = await bootFreshServer("contention-impatient", {
    SQLITE_BUSY_BUDGET_MS: "0",
  });
  patient = await bootFreshServer("contention-patient");
}, 180_000);

afterAll(() => {
  impatient?.stop();
  patient?.stop();
});

/** A connection sitting in `BEGIN IMMEDIATE` on the server's own file. */
class HeldLock {
  private constructor(private readonly child: ChildProcessWithoutNullStreams) {}

  static async take(sqlitePath: string): Promise<HeldLock> {
    const child = spawn("sqlite3", [sqlitePath], { stdio: "pipe" });
    // `journal_mode` has to match the server's or the lock is a
    // different one; `BEGIN IMMEDIATE` then takes the write lock at once
    // rather than on the transaction's first write.
    child.stdin.write("PRAGMA journal_mode=WAL;\nBEGIN IMMEDIATE;\n");
    // A statement inside the transaction, so the lock is unambiguously
    // taken before the caller is told it has it.
    child.stdin.write("CREATE TABLE IF NOT EXISTS _lock_probe (x);\n");
    child.stdin.write("SELECT 'held';\n");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("sqlite3 did not confirm it holds the lock"));
      }, 10_000);
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("held")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("error", reject);
    });
    return new HeldLock(child);
  }

  /** Roll the transaction back and close, freeing the lock. */
  async release(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.child.stdin.write("ROLLBACK;\n.quit\n");
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 10_000);
      this.child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function clientFor(server: FreshServer): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}

function aNote(title: string) {
  return {
    type: "core.note",
    properties: { title, body: "a write that wants the lock" },
  };
}

describe("contention on the write lock", () => {
  it("answers 503 write_contention, never 500", async () => {
    const client = clientFor(impatient!);
    const lock = await HeldLock.take(impatient!.sqlitePath);
    try {
      const refused = await client.createItem(aNote("refused"));

      expect(
        refused.ok,
        `the write was not refused while the lock was held: ${String(refused.status)}`,
      ).toBe(false);
      // The point of the line. A `500` says the instance is broken
      // about the one failure that clears itself, and a device retries a
      // `5xx` without counting it against the write
      // (`queue-and-verdicts.md` 17) — so a `500` would be retryable by
      // accident while naming the wrong reason.
      expect(refused.status).toBe(503);
      expect(refused.error?.error.code).toBe("write_contention");
    } finally {
      await lock.release();
    }

    // The witness. The lock is the whole of it: released, the same write
    // through the same client lands.
    const landed = await client.createItem(aNote("landed"));
    expect(
      landed.ok,
      `the write still failed after the lock was released: ${JSON.stringify(landed.error)}`,
    ).toBe(true);
    expect(landed.status).toBe(201);
  }, 120_000);

  it("waits out a briefly held lock on the default budget", async () => {
    // The second witness, and the one that makes the budget the subject:
    // the same held lock against a server that waits is not a refusal at
    // all, because the holder lets go inside the budget and the retry
    // gets through.
    const client = clientFor(patient!);
    const lock = await HeldLock.take(patient!.sqlitePath);
    setTimeout(() => void lock.release(), 400);

    const landed = await client.createItem(aNote("waited"));
    expect(
      landed.ok,
      `a briefly held lock refused a write on the default budget: ${JSON.stringify(landed.error)}`,
    ).toBe(true);
    expect(landed.status).toBe(201);

    await lock.release();
  }, 120_000);
});
