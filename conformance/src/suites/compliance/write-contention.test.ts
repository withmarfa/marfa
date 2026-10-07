import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { HeldLock } from "../../utils/held-lock.js";
import type { SseEvent } from "../../utils/sse.js";
import { collectUntil, withStream } from "../../utils/stream.js";

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
}, 4 * FRESH_SERVER_TIMEOUT_MS);

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

const runSqlite = promisify(execFile);

// Exiting an admitted probe rolls it back. A later ROLLBACK statement can
// overwrite the failed BEGIN diagnostic in the SQLite shell.
function probeWriteAdmission(sqlitePath: string) {
  return runSqlite(
    "sqlite3",
    ["-bail", "-cmd", ".timeout 0", sqlitePath, "BEGIN IMMEDIATE;"],
    { timeout: 10_000 },
  );
}

async function expectWriteLocked(sqlitePath: string): Promise<void> {
  const refused = probeWriteAdmission(sqlitePath);
  await expect(refused).rejects.toMatchObject({
    code: expect.any(Number),
    stderr: expect.stringContaining("database is locked"),
  });
  await expect(refused).rejects.not.toMatchObject({ code: 0 });
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
  it("does not report admission when a competing writer keeps the lock", async () => {
    const lock = await HeldLock.take(impatient!.sqlitePath);
    let unexpected: HeldLock | undefined;
    try {
      await expectWriteLocked(impatient!.sqlitePath);
      await expect(
        HeldLock.take(impatient!.sqlitePath, 0).then((taken) => {
          unexpected = taken;
          return taken;
        }),
      ).rejects.toThrow(/database is locked/);
    } finally {
      await unexpected?.release();
      await lock.release();
    }

    await probeWriteAdmission(impatient!.sqlitePath);
    const admitted = await HeldLock.take(impatient!.sqlitePath);
    try {
      await expectWriteLocked(impatient!.sqlitePath);
    } finally {
      await admitted.release();
    }
    await probeWriteAdmission(impatient!.sqlitePath);
  }, 120_000);

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
    const { id, key, last_used_at } = (await minted.json()) as {
      id: string;
      key: string;
      last_used_at: string | null;
    };
    expect(last_used_at).toBeNull();

    const read = () =>
      fetch(`${impatient!.apiUrl}/items`, {
        headers: { Authorization: `Bearer ${key}` },
      });
    const operator = new MarfaClient({
      baseUrl: impatient!.apiUrl,
      apiKey: impatient!.operatorKey,
    });
    const readStamp = async () => {
      const listed = await operator.listKeys();
      expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
      const found = listed.data.data.find((row) => row.id === id);
      expect(found).toBeDefined();
      return found!.last_used_at;
    };

    const lock = await HeldLock.take(impatient!.sqlitePath);
    try {
      await expectWriteLocked(impatient!.sqlitePath);
      for (let attempt = 1; attempt <= 2; attempt++) {
        const refused = await read();
        expect(refused.status, `read attempt ${String(attempt)}`).toBe(503);
        const body = (await refused.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe("write_contention");
        expect(await readStamp()).toBeNull();
      }
      await expectWriteLocked(impatient!.sqlitePath);
    } finally {
      await lock.release();
    }

    await probeWriteAdmission(impatient!.sqlitePath);
    const served = await read();
    expect(served.status).toBe(200);
    await served.json();
    const stamp = await readStamp();
    expect(stamp).toEqual(expect.any(String));

    // Only a completed stamp skips the next write. Holding the lock again
    // makes that skip observable rather than relying on equal timestamps.
    const heldAgain = await HeldLock.take(impatient!.sqlitePath);
    try {
      await expectWriteLocked(impatient!.sqlitePath);
      const debounced = await read();
      expect(debounced.status).toBe(200);
      await debounced.json();
      expect(await readStamp()).toBe(stamp);
      await expectWriteLocked(impatient!.sqlitePath);
    } finally {
      await heldAgain.release();
    }
  }, 120_000);

  it("refuses a client registration, which the sign-in library writes", async () => {
    // The registration door is the sign-in library's own, answered by its
    // own handler rather than a route of this server's, so the refusal has
    // to cross that library to reach the caller as the declared `503`.
    const register = () =>
      fetch(`${impatient!.apiUrl}/auth/oauth2/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "contention",
          redirect_uris: ["https://example.com/callback"],
          token_endpoint_auth_method: "none",
        }),
      });
    const lock = await HeldLock.take(impatient!.sqlitePath);
    try {
      const refused = await register();
      expect(
        refused.status,
        `a contended registration answered ${String(refused.status)}`,
      ).toBe(503);
      const body = (await refused.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("write_contention");
    } finally {
      await lock.release();
    }

    // The witness: released, the same registration is served.
    const served = await register();
    expect(served.status).toBe(201);
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
      const releasing = new Promise<void>((resolve, reject) => {
        setTimeout(() => void lock.release().then(resolve, reject), 400);
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
  it("announces nothing and keeps no row for a write it refused with 503, on the stream open at the time and on a replay", async ({
    signal,
  }) => {
    const client = clientFor(impatient!);
    const titleOf = (e: SseEvent): unknown =>
      (e.data as { item?: { properties?: { title?: unknown } } })?.item
        ?.properties?.title;
    const titles = (events: SseEvent[]): unknown[] => events.map(titleOf);

    const written = await withStream(
      impatient!.apiUrl,
      impatient!.workingKey,
      {},
      async (stream) => {
        await new Promise((r) => setTimeout(r, 250));
        // The witness that the stream is live for this write: a write that
        // lands is announced, so a refused one that was not is not for want
        // of a subscriber.
        const landed = await client.createItem(aNote("contention-landed"));
        expect(landed.status).toBe(201);
        const landedFrame = await collectUntil(
          stream,
          (seen) => titles(seen).includes("contention-landed"),
          "the write that landed before the lock",
          signal,
        );
        const landedEvent = landedFrame.events.find(
          (e) => titleOf(e) === "contention-landed",
        );

        const lock = await HeldLock.take(impatient!.sqlitePath);
        try {
          const refused = await client.createItem(aNote("contention-refused"));
          expect(refused.status).toBe(503);
          expect(refused.error?.error.code).toBe("write_contention");
        } finally {
          await lock.release();
        }

        const sentinel = await client.createItem(aNote("contention-sentinel"));
        expect(sentinel.status).toBe(201);
        const { events } = await collectUntil(
          stream,
          (seen) => titles(seen).includes("contention-sentinel"),
          "the sentinel written after the refused write",
          signal,
        );
        return { live: events, cursor: landedEvent!.id! };
      },
    );
    expect(titles(written.live)).not.toContain("contention-refused");

    // The replay carries the log, and the log holds no event for it.
    const replayed = await withStream(
      impatient!.apiUrl,
      impatient!.workingKey,
      { lastEventId: written.cursor },
      async (stream) => {
        const { events } = await collectUntil(
          stream,
          (seen) => titles(seen).includes("contention-sentinel"),
          "the sentinel in a replay from before the refused write",
          signal,
        );
        return events;
      },
    );
    expect(titles(replayed)).toContain("contention-sentinel");
    expect(titles(replayed)).not.toContain("contention-refused");

    // And no row: the page of notes holds the two that landed and not it.
    const listed = await client.listItems({ type: "core.note", limit: 100 });
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    const held = listed.data.data.map((item) => item.properties.title);
    expect(held).toContain("contention-sentinel");
    expect(held).not.toContain("contention-refused");
  }, 120_000);

  it("refuses an export with 503 before its stream starts, and records nothing of it", async () => {
    const client = clientFor(impatient!);
    const exportRuns = async (): Promise<number> => {
      const rows = await client.listAudit({ action: "export.run" });
      expect(rows.ok, JSON.stringify(rows.error)).toBe(true);
      return rows.data.data.length;
    };
    const ask = () =>
      fetch(`${impatient!.apiUrl}/export?format=ndjson`, {
        headers: { Authorization: `Bearer ${impatient!.workingKey}` },
      });

    const before = await exportRuns();
    const lock = await HeldLock.take(impatient!.sqlitePath);
    try {
      const refused = await ask();
      expect(refused.status).toBe(503);
      expect(refused.headers.get("Content-Type")).toContain("application/json");
      const body = (await refused.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("write_contention");
      expect(await exportRuns()).toBe(before);
    } finally {
      await lock.release();
    }

    // The witness: released, the same export streams, and its record is the
    // one entry the refused attempt did not leave.
    const served = await ask();
    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Type")).toContain(
      "application/x-ndjson",
    );
    await served.text();
    expect(await exportRuns()).toBe(before + 1);
  }, 120_000);
});
