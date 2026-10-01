import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createTestContext, readSse, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { initEventLog } from "../pubsub.js";
import { parseEventLogRetentionHours } from "../config.js";
import { eventLog } from "../storage/sqlite/schema.js";

// Enable event_log persistence for the whole suite. The default test
// bootstrap leaves it unwired; we need `publish()` to append so the
// replay-cursor logic has rows to reason about.
let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
});

afterAll(async () => {
  await ctx.cleanup();
});

interface CreatedItem {
  item: { id: string; type: string };
}

function maxBigInt(values: bigint[]): bigint {
  return values.reduce((a, b) => (a > b ? a : b), 0n);
}

async function createNote(body = "hello"): Promise<bigint> {
  // Returns the event_log id appended for this create. We read it
  // straight off storage because POST /items doesn't echo the event id.
  const before = await ctx.storage.eventLog.getAfter(0n, 1000);
  const maxBefore = before.length ? maxBigInt(before.map((e) => e.id)) : 0n;
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body } },
  });
  expect(res.status).toBe(201);
  (await res.json()) as CreatedItem;
  const after = await ctx.storage.eventLog.getAfter(maxBefore, 1000);
  expect(after.length).toBeGreaterThan(0);
  return maxBigInt(after.map((e) => e.id));
}

/** Parse an SSE frame looking for a named event. */
function findEvent(
  sse: string,
  eventName: string,
): { id?: string; data: string } | null {
  // SSE frames are blank-line separated. Scan them for the first
  // frame whose `event:` field matches.
  const frames = sse.split(/\n\n/);
  for (const frame of frames) {
    const lines = frame.split("\n");
    let id: string | undefined;
    let event: string | undefined;
    let data = "";
    for (const line of lines) {
      if (line.startsWith("id: ")) id = line.slice(4);
      else if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) {
        data += (data ? "\n" : "") + line.slice(6);
      }
    }
    if (event === eventName) return { id, data };
  }
  return null;
}

/**
 * Retires one event the way the retention sweep does, by removing its row.
 *
 * The sweep is the only thing that moves the log's oldest id, and it retires
 * only an event older than the retention, an hour at the shortest, so a stale
 * cursor is arranged here rather than provoked.
 */
async function retireEvent(id: bigint): Promise<void> {
  const db = ctx.storage.betterAuthDb as {
    delete: (table: unknown) => {
      where: (predicate: unknown) => Promise<unknown>;
    };
  };
  await db.delete(eventLog).where(eq(eventLog.id, Number(id)));
  const oldest = await ctx.storage.eventLog.getMinRetainedId();
  expect(oldest).not.toBeNull();
  expect(oldest! > id).toBe(true);
}

describe("GET /events — catchup_too_old", () => {
  it("refuses a cursor behind a log the sweep has retired to its newest event", async () => {
    // Every row older than the retention: the sweep keeps the newest, so the
    // log never empties and a cursor behind the retired stretch meets the
    // refusal rather than an empty log that cannot say anything is missing.
    const behind = await createNote("swept-1");
    await createNote("swept-2");
    const newest = await createNote("swept-3");
    const run = (
      ctx.storage as unknown as {
        __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
      }
    ).__sqliteRun;
    await run("UPDATE event_log SET created_at = ?", [
      new Date(Date.now() - 3 * 3_600_000).toISOString(),
    ]);
    await ctx.storage.eventLog.cleanup(1);
    expect(await ctx.storage.eventLog.getMinRetainedId()).toBe(newest);

    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.workingKey,
      headers: { "Last-Event-ID": String(behind) },
    });
    const { text } = await readSse(res, { untilClosed: true });
    const frame = findEvent(text, "catchup_too_old");
    expect(
      frame,
      "a cursor behind the swept log was replayed nothing, so the events it missed are lost untold",
    ).not.toBeNull();
    expect(frame!.id).toBe(String(newest));
    // The cases after this one arrange the log's oldest id themselves.
    await run("DELETE FROM event_log", []);
  });

  it("emits terminal catchup_too_old when the event after the cursor is no longer retained", async () => {
    const retired = await createNote("stale-cursor-1");
    const gone = await createNote("stale-cursor-2");
    const survivor = await createNote("stale-cursor-3");
    expect(gone > retired && survivor > gone).toBe(true);
    // The cursor names `retired` as the last event applied, so the client
    // needs everything after it, and the first of those is `gone`. Retiring
    // `retired` alone leaves that need answerable, which is the boundary the
    // in-step case below pins; retiring `gone` too is what makes the cursor
    // stale, because the event after it is no longer held.
    await retireEvent(retired);
    await retireEvent(gone);
    const oldest = (await ctx.storage.eventLog.getMinRetainedId())!;
    expect(oldest).toBe(survivor);
    // A cursor two or more behind the oldest retained id has lost an event.
    expect(oldest > retired + 1n).toBe(true);

    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.workingKey,
      headers: { "Last-Event-ID": String(retired) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    // Waits for the close rather than for the frame. Terminal is a claim
    // about what the server does *after* emitting, and a read that stopped at
    // the frame never observed it.
    const { text, closed } = await readSse(res, { untilClosed: true });
    const frame = findEvent(text, "catchup_too_old");
    expect(frame).not.toBeNull();
    expect(frame!.id).toBe(String(oldest));
    const payload = JSON.parse(frame!.data) as {
      type: string;
      min_retained_id: string;
      requested: string;
    };
    expect(payload.type).toBe("catchup_too_old");
    expect(payload.min_retained_id).toBe(String(oldest));
    expect(payload.requested).toBe(String(retired));

    // Terminal means the server closes the stream after emitting, and a
    // stream that delivered nothing would satisfy "no item frames" on its
    // own, so the close is what is asserted.
    expect(closed).toBe(true);
    expect(text).not.toContain("item.");
    // A stream that ended short is never said to be live: the marker's
    // cursor is one a client may adopt, and this stream has none to
    // offer. `events-cursor.test.ts` is the witness that a stream which
    // finishes its prologue does send it.
    expect(text).not.toContain("event: stream_live");
  });

  it("refuses a replay the sweep overtakes after the cursor was checked", async () => {
    const cursor = await createNote("overtaken-1");
    await createNote("overtaken-2");
    await createNote("overtaken-3");
    const newest = await createNote("overtaken-4");

    // The first read of the replay waits here, after the cursor was checked
    // against the oldest retained id and before the log is read.
    const store = ctx.storage.eventLog;
    const real = store.getAfter.bind(store);
    let reached!: () => void;
    const atRead = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let armed = true;
    store.getAfter = async (afterId, limit) => {
      if (armed && afterId === cursor) {
        armed = false;
        reached();
        await released;
      }
      return real(afterId, limit);
    };
    try {
      const res = await request(ctx.app, "GET", "/events", {
        key: ctx.workingKey,
        headers: { "Last-Event-ID": String(cursor) },
      });
      await atRead;
      const run = (
        ctx.storage as unknown as {
          __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
        }
      ).__sqliteRun;
      await run("DELETE FROM event_log WHERE id < ?", [Number(newest)]);
      expect(await store.getMinRetainedId()).toBe(newest);
      release();

      const { text } = await readSse(res, {
        until: (seen) =>
          seen.includes("event: catchup_too_old") ||
          seen.includes("event: stream_live"),
      });
      expect(
        text,
        "a sweep that retired the events after the cursor mid-replay was replayed over in silence, so the reader resumes past events it never saw",
      ).not.toContain("event: stream_live");
      const frame = findEvent(text, "catchup_too_old");
      expect(frame).not.toBeNull();
      expect(frame!.id).toBe(String(newest));
    } finally {
      store.getAfter = real;
      await (
        ctx.storage as unknown as {
          __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
        }
      ).__sqliteRun("DELETE FROM event_log", []);
    }
  });

  it("replays from a cursor one below the oldest retained id, which is a client exactly in step", async () => {
    // A cursor of `0` against a log whose first event is `1` is a device
    // that hydrated an empty instance and has missed nothing, and a
    // comparison without the plus one refuses it. The log here is not empty
    // and not fresh, so the boundary is arranged the way the sweep arranges
    // it: retire everything before one event, then resume from the cursor
    // just below it.
    // One event written just to be retired, so the boundary is arranged by
    // this case rather than inherited from whatever ran before it.
    await createNote("boundary-before");
    const first = await createNote("boundary-first");
    const rows = await ctx.storage.eventLog.getAfter(0n, 10_000);
    let retired = 0;
    for (const row of rows) {
      if (row.id < first) {
        await retireEvent(row.id);
        retired += 1;
      }
    }
    expect(retired).toBeGreaterThan(0);
    const oldest = (await ctx.storage.eventLog.getMinRetainedId())!;
    expect(oldest).toBe(first);
    const cursor = oldest - 1n;

    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.workingKey,
      headers: { "Last-Event-ID": String(cursor) },
    });
    expect(res.status).toBe(200);
    const { text } = await readSse(res, {
      until: (t) => t.includes(`id: ${String(first)}\n`),
    });
    expect(findEvent(text, "catchup_too_old")).toBeNull();
    expect(text).toContain(`id: ${String(first)}\n`);
  });

  it("replays normally when Last-Event-ID is within retention", async () => {
    const firstId = await createNote("within-retention-1");
    const secondId = await createNote("within-retention-2");

    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.workingKey,
      headers: { "Last-Event-ID": String(firstId) },
    });
    expect(res.status).toBe(200);

    const { text } = await readSse(res, {
      until: (t) => t.includes(`id: ${String(secondId)}`),
    });
    expect(findEvent(text, "catchup_too_old")).toBeNull();
    // The second event should show up on replay.
    expect(text).toContain(`id: ${String(secondId)}`);
  });

  it("does not emit catchup_too_old when Last-Event-ID is absent", async () => {
    await createNote("no-cursor");
    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    // `requireSeen` is what makes the absence mean something: the stream
    // opens with a `: connected` comment, so a window that saw it was
    // genuinely reading, and one that saw nothing fails loudly rather than
    // satisfying the assertion by delivering nothing.
    const { text } = await readSse(res, {
      requireSeen: (t) => t.startsWith(": connected\n\n"),
    });
    expect(findEvent(text, "catchup_too_old")).toBeNull();
  });

  it("emits an initial `: connected` SSE comment so proxies flush headers", async () => {
    const res = await request(ctx.app, "GET", "/events", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    // Waits on the comment rather than betting that 100ms is long enough to
    // schedule the stream, which is the same wall-clock bet the replay tests
    // were losing under load.
    const { text } = await readSse(res, {
      until: (t) => t.startsWith(": connected\n\n"),
    });
    expect(text.startsWith(": connected\n\n")).toBe(true);
  });

  it("does not emit catchup_too_old when the event log is empty", async () => {
    // Spin up a second context with its own fresh storage so min(id) is
    // genuinely null. Sharing `ctx` would mean any prior test that
    // appended events makes min(id) non-null.
    const fresh = await createTestContext();
    initEventLog(fresh.storage.eventLog);
    try {
      const res = await request(fresh.app, "GET", "/events", {
        key: fresh.workingKey,
        headers: { "Last-Event-ID": "5" },
      });
      expect(res.status).toBe(200);
      const { text } = await readSse(res, {
        requireSeen: (t) => t.startsWith(": connected\n\n"),
      });
      expect(findEvent(text, "catchup_too_old")).toBeNull();
    } finally {
      await fresh.cleanup();
      // Restore the suite-wide event log binding so later tests keep
      // persisting through `ctx.storage.eventLog`.
      initEventLog(ctx.storage.eventLog);
    }
  });
});

describe("MARFA_EVENT_LOG_RETENTION_HOURS parser", () => {
  it("defaults to 168 when unset or empty", () => {
    expect(parseEventLogRetentionHours(undefined)).toBe(168);
    expect(parseEventLogRetentionHours("")).toBe(168);
  });

  it("accepts positive integers", () => {
    expect(parseEventLogRetentionHours("1")).toBe(1);
    expect(parseEventLogRetentionHours("24")).toBe(24);
    expect(parseEventLogRetentionHours("720")).toBe(720);
  });

  it("falls back to 168 for invalid values", () => {
    expect(parseEventLogRetentionHours("0")).toBe(168);
    expect(parseEventLogRetentionHours("-5")).toBe(168);
    expect(parseEventLogRetentionHours("1.5")).toBe(168);
    expect(parseEventLogRetentionHours("not-a-number")).toBe(168);
  });
});

describe("GET /events — a replay that sends nothing for a while", () => {
  it("says it is still reading, so a reader waiting on silence does not give up", async () => {
    const cursor = await createNote("withheld-cursor");
    const withheld = await createNote("withheld-row");
    await createNote("withheld-row-2");

    // A read of the log slow enough to outlast the progress interval, over
    // rows the type filter withholds, so the replay itself sends nothing.
    const store = ctx.storage.eventLog;
    const real = store.getAfter.bind(store);
    store.getAfter = async (afterId, limit) => {
      const rows = await real(afterId, limit);
      if (afterId === cursor) await new Promise((r) => setTimeout(r, 1_200));
      return rows;
    };
    try {
      const withheldRes = await request(
        ctx.app,
        "GET",
        "/events?type=core.task",
        {
          key: ctx.workingKey,
          headers: { "Last-Event-ID": String(cursor) },
        },
      );
      const { text } = await readSse(withheldRes, {
        until: (seen) => seen.includes("event: stream_live"),
      });
      expect(text).not.toContain(`id: ${String(withheld)}`);
      const said = text.indexOf(": replaying");
      expect(
        said,
        "a replay reading withheld rows sent nothing until its marker, so a reader that ends on silence stops short of the head",
      ).toBeGreaterThan(-1);
      expect(said).toBeLessThan(text.indexOf("event: stream_live"));

      // The witness: a replay whose read is quick says nothing extra.
      store.getAfter = real;
      const quickRes = await request(ctx.app, "GET", "/events?type=core.task", {
        key: ctx.workingKey,
        headers: { "Last-Event-ID": String(cursor) },
      });
      const quick = await readSse(quickRes, {
        until: (seen) => seen.includes("event: stream_live"),
      });
      expect(quick.text).not.toContain(": replaying");
    } finally {
      store.getAfter = real;
    }
  });

  /**
   * A replay over 30,000 rows the type filter withholds, with writers
   * taking their turns between its reads, as requests arriving on sockets
   * do, and publishing notes this reader may see.
   *
   * The writes are placed by the replay's reads, a page of notes after
   * each, until more than the hold holds have been published. Racing a
   * free-running writer against the replay instead makes the number of
   * writes, each a committed transaction, a function of how many reads
   * the replay needs, and the run then costs more than a thousand commits
   * on a loaded machine to prove what a few hundred prove.
   *
   * `damaged` puts a row the replay cannot read ahead of the withheld rows:
   * `"stored"` one written straight to the log, which no subscriber was
   * ever sent, and `"published"` a note published to this stream while its
   * replay waits, whose stored copy is then spoiled, so its live copy is the
   * one it has.
   */
  async function busyReplay(
    damaged?: "stored" | "published" | "published-late",
  ): Promise<string> {
    const cursor = await createNote("busy-cursor");
    const run = (
      ctx.storage as unknown as {
        __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
      }
    ).__sqliteRun;
    const seed = () =>
      run(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30000)
         INSERT INTO event_log (event_type, item_id, payload, enable_fanout, created_at)
         SELECT event_type, item_id, REPLACE(payload, '"core.note"', '"core.task"'), 0, created_at
         FROM event_log, n WHERE event_log.id = ?`,
        [Number(cursor)],
      );
    if (damaged === "stored") {
      await run(
        "INSERT INTO event_log (event_type, item_id, payload, enable_fanout, created_at) VALUES ('created', 'unreadable', 'not json', 0, ?)",
        [new Date().toISOString()],
      );
    }
    const published = damaged === "published" || damaged === "published-late";
    if (!published) await seed();

    const store = ctx.storage.eventLog;
    const real = store.getAfter.bind(store);
    let reached!: () => void;
    const atRead = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let read = real;
    if (published) {
      let armed = true;
      read = async (afterId, limit) => {
        if (armed) {
          armed = false;
          reached();
          await released;
        }
        return real(afterId, limit);
      };
    }

    // Past the hold's cap of 500 frames, and done well inside the 60 reads
    // the seeded rows alone take, so every write lands mid-replay.
    const WRITES = 520;
    const WRITES_PER_READ = 20;
    let written = 0;
    const write = async (count: number) => {
      const res = await request(ctx.app, "POST", "/items/bulk", {
        key: ctx.workingKey,
        body: {
          items: Array.from({ length: count }, () => ({
            type: "core.note",
            properties: { body: "busy" },
          })),
        },
      });
      expect(res.status).toBe(200);
    };
    // Awaited again after the read: the stream can end inside a write,
    // while its notes are being published, so the count is read only once
    // that write has returned, and a refused write is reported as itself
    // rather than as the failed replay it caused.
    let writing: Promise<void> = Promise.resolve();
    store.getAfter = async (afterId, limit) => {
      const rows = await read(afterId, limit);
      if (written < WRITES) {
        writing = write(WRITES_PER_READ).then(() => {
          written += WRITES_PER_READ;
        });
        await writing;
      }
      return rows;
    };
    try {
      const res = await request(ctx.app, "GET", "/events?type=core.note", {
        key: ctx.workingKey,
        headers: { "Last-Event-ID": String(cursor) },
      });
      if (published) {
        await atRead;
        // Early, the replay reads the spoiled row before the hold fills;
        // late, behind the withheld rows, after the hold was given up.
        if (damaged === "published-late") await seed();
        await write(1);
        await run(
          "UPDATE event_log SET payload = 'not json' WHERE id = (SELECT MAX(id) FROM event_log)",
          [],
        );
        if (damaged === "published") await seed();
        release();
      }
      const { text } = await readSse(res, {
        until: (seen) =>
          seen.includes("event: stream_live") ||
          seen.includes("event: stream_incomplete"),
      });
      await writing;
      // The damaged note's own live copy is held beside the writes.
      expect(
        written + (published ? 1 : 0),
        "fewer frames were held during the replay than the hold holds, so it was never tested past its cap",
      ).toBeGreaterThan(500);
      if (damaged === undefined) {
        const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) =>
          BigInt(m[1]!),
        );
        expect(new Set(ids).size).toBe(ids.length);
        expect([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(
          ids,
        );
        const logged = await real(cursor + 30_000n, 5_000);
        const marker = /"cursor":"(\d+)"/.exec(
          text.slice(text.indexOf("event: stream_live")),
        );
        const reached = BigInt(marker![1]!);
        expect(ids).toEqual(
          logged.map((row) => row.id).filter((id) => id <= reached),
        );
      }
      return text;
    } finally {
      release();
      await writing.catch(() => undefined);
      store.getAfter = real;
      await run("DELETE FROM event_log", []);
    }
  }

  it("keeps the stream through more writes during a long replay than it can hold", async () => {
    const text = await busyReplay();
    expect(
      text,
      "writes during the replay filled the hold and ended the stream, so a busy instance never lets a long catch-up finish",
    ).toContain("event: stream_live");
  });

  it("ends short rather than pass a row it cannot read whose live copy the hold gave up", async () => {
    const text = await busyReplay("published");
    expect(
      text,
      "the replay went on past a row whose one carrier it had given up, so the reader resumes past an event it never had",
    ).toContain('"reason":"backlog_overflow"');
    expect(text).not.toContain("event: stream_live");
  });

  it("ends short at a row it cannot read whose live copy it took over from the hold", async () => {
    const text = await busyReplay("published-late");
    expect(
      text,
      "the replay passed a row it could not read after taking over its live copy, so the reader resumes past an event it never had",
    ).toContain('"reason":"backlog_overflow"');
    expect(text).not.toContain("event: stream_live");
  });

  it("reads again after an empty read while frames it took over are past it", async () => {
    // One transaction for the lot: the hold counts frames, not commits,
    // and five hundred commits in a row is the run's whole cost.
    const notes = async (count: number) => {
      const res = await request(ctx.app, "POST", "/items/bulk", {
        key: ctx.workingKey,
        body: {
          items: Array.from({ length: count }, () => ({
            type: "core.note",
            properties: { body: "race" },
          })),
        },
      });
      expect(res.status).toBe(200);
    };
    const cursor = await createNote("race-cursor");
    const store = ctx.storage.eventLog;
    const real = store.getAfter.bind(store);
    let reads = 0;
    let late: bigint | undefined;
    // The first read fills the hold to its cap; the second comes back
    // empty, and a write landing while it is out gives the hold up past
    // what it saw.
    store.getAfter = async (afterId, limit) => {
      reads += 1;
      if (reads === 1) await notes(500);
      const rows = await real(afterId, limit);
      if (reads === 2) {
        await notes(1);
        late = (await store.getMaxId()) ?? undefined;
      }
      return rows;
    };
    try {
      const res = await request(ctx.app, "GET", "/events?type=core.note", {
        key: ctx.workingKey,
        headers: { "Last-Event-ID": String(cursor) },
      });
      const { text } = await readSse(res, {
        until: (seen) =>
          seen.includes("event: stream_live") ||
          seen.includes("event: stream_incomplete"),
      });
      expect(late).toBeDefined();
      expect(
        text,
        "a frame given up while an empty read was out was never sent",
      ).toContain(`id: ${String(late)}\n`);
    } finally {
      store.getAfter = real;
      await (
        ctx.storage as unknown as {
          __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
        }
      ).__sqliteRun("DELETE FROM event_log", []);
    }
  });

  it("passes a row it cannot read that was never this stream's to hold", async () => {
    const text = await busyReplay("stored");
    expect(
      text,
      "a row nobody published to this stream ended it, so every reconnect ends on it again for as long as writes go on",
    ).toContain("event: stream_live");
  });

  it("refuses a replay the sweep overtakes between its reads", async () => {
    const run = (
      ctx.storage as unknown as {
        __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
      }
    ).__sqliteRun;
    const newest = await createNote("sweep-newest");
    // Rows older than the retention below the newest, more than one batch
    // of them, so the sweep can land between two reads.
    await run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
       INSERT INTO event_log (id, event_type, item_id, payload, enable_fanout, created_at)
       SELECT ? - 2001 + i, event_type, item_id, payload, 0, ?
       FROM event_log, n WHERE event_log.id = ?`,
      [
        Number(newest),
        new Date(Date.now() - 3 * 3_600_000).toISOString(),
        Number(newest),
      ],
    );
    const cursor = newest - 2001n;
    expect(await ctx.storage.eventLog.getMinRetainedId()).toBe(cursor + 1n);

    // The sweep runs in the turn the replay gives up after its first read.
    const store = ctx.storage.eventLog;
    const real = store.getAfter.bind(store);
    let armed = true;
    store.getAfter = async (afterId, limit) => {
      const rows = await real(afterId, limit);
      if (armed) {
        armed = false;
        setImmediate(() => void store.cleanup(1));
      }
      return rows;
    };
    try {
      const res = await request(ctx.app, "GET", "/events", {
        key: ctx.workingKey,
        headers: { "Last-Event-ID": String(cursor) },
      });
      const { text } = await readSse(res, {
        until: (seen) =>
          seen.includes("event: catchup_too_old") ||
          seen.includes("event: stream_live"),
      });
      expect(
        text,
        "a sweep between two reads of the replay was replayed over in silence",
      ).not.toContain("event: stream_live");
      expect(findEvent(text, "catchup_too_old")).not.toBeNull();
    } finally {
      store.getAfter = real;
      await run("DELETE FROM event_log", []);
    }
  });

  it("lets the process answer other work between its reads of the log", async () => {
    const cursor = await createNote("yield-cursor");
    const run = (
      ctx.storage as unknown as {
        __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
      }
    ).__sqliteRun;
    // More than one batch of rows the type filter withholds, copied from a
    // real row so each decodes as an item of another type.
    await run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
       INSERT INTO event_log (event_type, item_id, payload, enable_fanout, created_at)
       SELECT event_type, item_id, REPLACE(payload, '"core.note"', '"core.task"'), 0, created_at
       FROM event_log, n WHERE event_log.id = ?`,
      [Number(cursor)],
    );

    // A task queued at each read has run by the next only where the replay
    // gave the event loop a turn between them.
    const store = ctx.storage.eventLog;
    const real = store.getAfter.bind(store);
    const turns: boolean[] = [];
    let turned = true;
    store.getAfter = async (afterId, limit) => {
      turns.push(turned);
      turned = false;
      setImmediate(() => (turned = true));
      return real(afterId, limit);
    };
    try {
      const res = await request(ctx.app, "GET", "/events?type=core.task", {
        key: ctx.workingKey,
        headers: { "Last-Event-ID": String(cursor) },
      });
      await readSse(res, {
        until: (seen) => seen.includes("event: stream_live"),
      });
      expect(
        turns.length,
        "the replay read the log once, so there was no second read to have yielded before",
      ).toBeGreaterThan(1);
      expect(
        turns.slice(1),
        "the replay read batch after batch without a turn of the event loop, so a long one answers no other request and flushes nothing it wrote",
      ).not.toContain(false);
    } finally {
      store.getAfter = real;
    }
  });
});
