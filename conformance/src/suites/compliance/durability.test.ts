import {
  cpSync,
  existsSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { controlRequest } from "../../utils/control-request.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import type { SseEvent } from "../../utils/sse.js";
import { collectUntil, withStream } from "../../utils/stream.js";

const NOTE = "core.note";
const SOURCE = "durability";
/** Rounds of kills a run makes; a longer drill raises it. */
const ROUNDS = Number(process.env.MARFA_DURABILITY_ROUNDS ?? "3");

let server: FreshServer;

beforeAll(async () => {
  server = await bootFreshServer(SOURCE);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
});

const clientOf = (): MarfaClient =>
  new MarfaClient({ baseUrl: server.apiUrl, apiKey: server.workingKey });

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The id of every write the server confirmed, as the clients saw it. */
interface Confirmed {
  ids: Set<string>;
}

/** Writes until `running()` is false: one item at a time, a best-effort page and an atomic page. */
function writers(confirmed: Confirmed, running: () => boolean) {
  const client = clientOf();
  const page = (kind: string, round: number, n: number) =>
    Array.from({ length: 40 }, (_, i) => ({
      type: NOTE,
      source_id: `${kind}-${round}-${n}-${i}`,
      properties: { body: `${kind} ${round} ${n} ${i}` },
    }));
  const single = async (round: number) => {
    for (let n = 0; running(); n++) {
      try {
        const made = await client.createItem({
          type: NOTE,
          source: SOURCE,
          properties: { body: `single ${round} ${n}` },
        });
        if (made.status === 201) confirmed.ids.add(made.data.item.id);
      } catch {
        return;
      }
    }
  };
  const bulk = async (round: number, atomic: boolean) => {
    for (let n = 0; running(); n++) {
      try {
        const sent = await client.bulkItems({
          atomic,
          mode: "upsert",
          items: page(atomic ? "atomic" : "best-effort", round, n),
        });
        if (sent.status !== 200) continue;
        for (const entry of sent.data.results) {
          if (entry.outcome === "created" && entry.id !== undefined)
            confirmed.ids.add(entry.id);
        }
      } catch {
        return;
      }
    }
  };
  return (round: number) => [
    single(round),
    bulk(round, false),
    bulk(round, true),
  ];
}

/** `PRAGMA integrity_check` of the files as a kill left them, read from a copy. */
function integrityOfCopy(sqlitePath: string): string[] {
  const copy = mkdtempSync(join(tmpdir(), "marfa-durability-"));
  try {
    cpSync(sqlitePath, join(copy, "marfa.db"));
    if (existsSync(`${sqlitePath}-wal`))
      cpSync(`${sqlitePath}-wal`, join(copy, "marfa.db-wal"));
    return withInstanceDatabase(join(copy, "marfa.db"), (db) =>
      db
        .prepare("PRAGMA integrity_check")
        .all()
        .map((row) => String(row.integrity_check)),
    );
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

describe("a write the server confirmed survives a power cut", () => {
  it("syncs each commit in full on every connection", async () => {
    const answer = await controlRequest(
      server.controlSocket,
      "/_control/test/database",
    );
    expect(answer.status).toBe(200);
    const { writer, readers } = answer.body as {
      writer: Record<string, unknown>;
      readers: Record<string, unknown>[];
    };
    expect(writer).toMatchObject({
      journal_mode: "wal",
      synchronous: 2,
      fullfsync: 1,
      checkpoint_fullfsync: 1,
    });
    expect(readers.length).toBeGreaterThan(0);
    for (const reader of readers) {
      expect(reader).toMatchObject({
        synchronous: 2,
        fullfsync: 1,
        checkpoint_fullfsync: 1,
      });
    }
  });

  it("keeps every write it confirmed through kills at random points, and leaves a file that checks out", async () => {
    const confirmed: Confirmed = { ids: new Set() };
    let writing = true;
    const start = writers(confirmed, () => writing);
    for (let round = 0; round < ROUNDS; round++) {
      writing = true;
      const running = start(round);
      await sleep(100 + Math.random() * 700);
      const checks: string[][] = [];
      const killed = await server.restart({
        signal: "SIGKILL",
        whileStopped: () => {
          checks.push(integrityOfCopy(server.sqlitePath));
        },
      });
      writing = false;
      await Promise.all(running);
      // The witness that this was a crash and not a stop: no exit status.
      expect(killed).toMatchObject({ code: null, signal: "SIGKILL" });
      expect(checks).toEqual([["ok"]]);

      const ids = [...confirmed.ids];
      expect(ids.length).toBeGreaterThan(0);
      const client = clientOf();
      const present = new Set<string>();
      for (let from = 0; from < ids.length; from += 100) {
        const found = await client.bulkGet(ids.slice(from, from + 100));
        expect(found.status).toBe(200);
        for (const item of found.data.items) present.add(item.id);
      }
      const missing = ids.filter((id) => !present.has(id));
      expect(missing, `round ${String(round)} lost confirmed writes`).toEqual(
        [],
      );
    }
  }, 600_000);
});

describe("an announcement of a write", () => {
  /** The frames a stream resumed after `cursor` replays, up to `stream_live`. */
  async function replayAfter(cursor: string): Promise<SseEvent[]> {
    return withStream(
      server.apiUrl,
      server.workingKey,
      { lastEventId: cursor },
      async (stream) =>
        (
          await collectUntil(
            stream,
            (events) => events.some((event) => event.event === "stream_live"),
            "stream_live",
          )
        ).events,
    );
  }

  const bodyOf = (event: SseEvent) =>
    (event.data as { item?: { properties?: { body?: string } } }).item
      ?.properties?.body;

  it("sends no event for an entry of a best-effort page until the page is answered", async () => {
    const client = clientOf();
    const cursor = await withStream(
      server.apiUrl,
      server.workingKey,
      {},
      async (stream) => {
        const { events } = await collectUntil(
          stream,
          (seen) => seen.some((event) => event.event === "stream_cursor"),
          "stream_cursor",
        );
        const opened = events.find((event) => event.event === "stream_cursor");
        return (opened?.data as { cursor: string }).cursor;
      },
    );
    const tag = `announced-${String(Date.now())}`;
    await server.setFault("hold:bulk-page=2");
    const page = client.bulkItems({
      atomic: false,
      items: [0, 1].map((n) => ({
        type: NOTE,
        source_id: `${tag}-${String(n)}`,
        properties: { body: `${tag}-${String(n)}` },
      })),
    });
    try {
      await server.waitForHold("hold:bulk-page");
      // The first entry is written and the page holds before its second.
      const held = await replayAfter(cursor);
      expect(held.filter((event) => bodyOf(event)?.startsWith(tag))).toEqual(
        [],
      );
    } finally {
      await server.clearFault("hold:bulk-page");
    }
    const answered = await page;
    expect(answered.status).toBe(200);
    expect(answered.data.counts.created).toBe(2);
    // The witness: once the page is answered, the same replay carries its entries.
    const after = await replayAfter(cursor);
    expect(
      after
        .map((event) => bodyOf(event))
        .filter((body) => body?.startsWith(tag)),
    ).toEqual([`${tag}-0`, `${tag}-1`]);
  }, 120_000);
});

describe("a database file with damaged pages", () => {
  it("answers 500 for what reads them, reports the database down, and keeps serving", async () => {
    const client = clientOf();
    const made = await client.createItem({
      type: NOTE,
      source: SOURCE,
      properties: { body: "before the damage" },
    });
    expect(made.status).toBe(201);
    const witness = await client.listItems({ limit: 1 });
    expect(witness.status, "the listing answers before the damage").toBe(200);

    await server.restart({
      whileStopped: () => {
        const root = withInstanceDatabase(server.sqlitePath, (db) =>
          Number(
            db
              .prepare(
                "SELECT rootpage FROM sqlite_schema WHERE name = 'items'",
              )
              .get()?.rootpage,
          ),
        );
        const pageSize = withInstanceDatabase(server.sqlitePath, (db) =>
          Number(db.prepare("PRAGMA page_size").get()?.page_size),
        );
        const fd = openSync(server.sqlitePath, "r+");
        try {
          // A page type SQLite does not know.
          const at = (root - 1) * pageSize;
          writeSync(fd, Buffer.from([0xff]), 0, 1, at);
        } finally {
          closeSync(fd);
        }
      },
    });

    const damaged = await clientOf().listItems({ limit: 1 });
    expect(damaged.status).toBe(500);
    expect(damaged.error?.error.code).toBe("internal_error");
    const health = await fetch(`${server.apiUrl}/health`);
    const report = (await health.json()) as {
      components: { database: { status: string } };
    };
    expect(health.status).toBe(503);
    expect(report.components.database.status).toBe("down");
    // Still serving: a read that meets no damaged page answers as before.
    const types = await fetch(`${server.apiUrl}/types`, {
      headers: { Authorization: `Bearer ${server.workingKey}` },
    });
    expect(types.status).toBe(200);
  }, 120_000);
});
