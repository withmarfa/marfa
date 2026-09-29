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

afterAll(async () => {
  await impatient?.stop();
  await patient?.stop();
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

  it("refuses a non-atomic bulk page rather than reporting it entry by entry", async () => {
    // A per-entry `errored` outcome is a verdict on the entry, and the
    // page still answers `200` because the rest of it landed. Contention
    // is not a verdict on anything: nothing was written and the next
    // attempt would land. Folded into a `200` it tells a device that
    // retries a `5xx` without counting it there is nothing to retry.
    const client = clientFor(impatient!);
    const lock = await HeldLock.take(impatient!.sqlitePath);
    try {
      const page = await client.bulkItems({
        items: [aNote("bulk one"), aNote("bulk two")],
        atomic: false,
      });
      expect(
        page.ok,
        `a contended page answered ${String(page.status)}: ${JSON.stringify(page.data)}`,
      ).toBe(false);
      expect(page.status).toBe(503);
      expect(page.error?.error.code).toBe("write_contention");
    } finally {
      await lock.release();
    }

    // The witness. An entry that is genuinely wrong is still reported
    // beside its siblings at `200`, so what changed is which refusals
    // count as a verdict on an entry and not whether any do.
    const mixed = await client.bulkItems({
      items: [aNote("good"), { type: "NOT a valid type", properties: {} }],
      atomic: false,
    });
    expect(mixed.ok).toBe(true);
    expect(mixed.status).toBe(200);
    expect(mixed.data.counts.errored).toBe(1);
    expect(mixed.data.counts.created).toBe(1);
  }, 120_000);

  it("names the budget it spent, so the setting is observable", async () => {
    // The wiring from `SQLITE_BUSY_BUDGET_MS` through config to the
    // retry is otherwise invisible: a server that ignored the variable
    // would answer the same `503` five seconds later, and a fixture
    // asserting the status alone would pass either way.
    const client = clientFor(impatient!);
    const lock = await HeldLock.take(impatient!.sqlitePath);
    try {
      const refused = await client.createItem(aNote("budget"));
      expect(refused.status).toBe(503);
      expect(refused.error?.error.details).toMatchObject({ budget_ms: 0 });
    } finally {
      await lock.release();
    }
  }, 120_000);

  it("refuses a housekeeping run, which writes outside a request's transaction", async () => {
    // The path the error handler's `cause` walk exists for. A request's
    // writes go through the transaction the driver opens directly, and
    // the refusal reaches the handler unwrapped; a housekeeping run
    // writes outside that context, so Drizzle wraps every statement and
    // the server's own code arrives as the `cause` of something else.
    // Without the walk this door answers `500` while every other one
    // answers `503`.
    const operator = new MarfaClient({
      baseUrl: impatient!.apiUrl,
      apiKey: impatient!.operatorKey,
    });
    const lock = await HeldLock.take(impatient!.sqlitePath);
    try {
      const run = await operator.rawRequest("/housekeeping/trash-purge/run", {
        method: "POST",
      });
      expect(
        run.status,
        `a contended housekeeping run answered ${String(run.status)}`,
      ).toBe(503);
      expect(run.error?.error.code).toBe("write_contention");
    } finally {
      await lock.release();
    }

    // The witness: released, the same run is served.
    const served = await operator.rawRequest("/housekeeping/trash-purge/run", {
      method: "POST",
    });
    expect(served.ok, JSON.stringify(served.error)).toBe(true);
  }, 120_000);

  it("refuses a read too, because the credential gate stamps a key's first use", async () => {
    // Every credentialed door can meet the lock: the gate records when a
    // key was last used, once per key per hour, before the handler runs.
    // A key minted here has never been used, so its first read writes.
    const minted = await fetch(`${impatient!.apiUrl}/keys`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${impatient!.operatorKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ label: "first-use", source: "first-use" }),
    });
    expect(minted.status).toBe(201);
    const { key } = (await minted.json()) as { key: string };

    const lock = await HeldLock.take(impatient!.sqlitePath);
    try {
      const refused = await fetch(`${impatient!.apiUrl}/items`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      expect(refused.status).toBe(503);
      const body = (await refused.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("write_contention");
    } finally {
      await lock.release();
    }
  }, 120_000);

  it("answers 500 at client registration, which the sign-in library writes", async () => {
    // What the server does, recorded in `findings.md` 1: the registration
    // door is the sign-in library's, whose write does not pass through the
    // storage layer's busy budget, so contention reaches the caller as a
    // `500` the document does not declare.
    const lock = await HeldLock.take(impatient!.sqlitePath);
    try {
      const refused = await fetch(`${impatient!.apiUrl}/auth/oauth2/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "contention",
          redirect_uris: ["https://example.com/callback"],
          token_endpoint_auth_method: "none",
        }),
      });
      expect(refused.status).toBe(500);
    } finally {
      await lock.release();
    }
  }, 120_000);

  it("waits out a briefly held lock on the default budget", async () => {
    // The second witness, and the one that makes the budget the subject:
    // the same held lock against a server that waits is not a refusal at
    // all, because the holder lets go inside the budget and the retry
    // gets through.
    const client = clientFor(patient!);
    const lock = await HeldLock.take(patient!.sqlitePath);
    try {
      // Well inside the five-second default, so the write waits and then
      // lands rather than racing the budget: the margin is the budget
      // itself, which is what keeps this from being a timing test.
      const releasing = new Promise<void>((resolve) => {
        setTimeout(() => void lock.release().then(resolve), 400);
      });

      const landed = await client.createItem(aNote("waited"));
      expect(
        landed.ok,
        `a briefly held lock refused a write on the default budget: ${JSON.stringify(landed.error)}`,
      ).toBe(true);
      expect(landed.status).toBe(201);
      await releasing;
    } finally {
      // Idempotent, and the point of the `finally`: an assertion above
      // that throws before the timer has fired would otherwise leave a
      // process holding the lock for the rest of the run.
      await lock.release();
    }
  }, 120_000);
});
