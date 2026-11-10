import { afterAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import {
  DAY_MS,
  movedClock,
  QUIET_SCHEDULE,
  runJob,
  writerOf,
} from "../../utils/moved-clock.js";

/**
 * How long a table's change log keeps a batch. The age of a batch is a clock
 * a fixture cannot wait out, so each case writes its batches, moves the
 * server's clock forward and runs `table-row-cleanup` itself.
 */

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

const TYPE = "user.rows-retention";

async function ledger(server: FreshServer): Promise<{
  writer: MarfaClient;
  item: string;
}> {
  const owner = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: "",
    controlSocket: server.controlSocket,
  });
  const type = await owner.registerType({
    id: TYPE,
    fields: { title: { type: "string" } },
    tables: { lines: { columns: { amount: { type: "number" } } } },
  } as never);
  expect(type.status, JSON.stringify(type.error)).toBe(201);
  const writer = writerOf(server);
  const made = await writer.createItem({
    type: TYPE,
    properties: { title: "Ledger" },
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return { writer, item: made.data.item.id };
}

async function batchOf(
  writer: MarfaClient,
  item: string,
  amount: number,
): Promise<string> {
  const res = await writer.writeRows(item, "lines", {
    operations: [{ op: "put", values: { amount } }],
  });
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data.batch!;
}

async function held(writer: MarfaClient, item: string): Promise<string[]> {
  const listed = await writer.listBatches(item, "lines");
  expect(listed.status, JSON.stringify(listed.error)).toBe(200);
  return listed.data.data.map((batch) => batch.id);
}

describe("the change log's retention", () => {
  it(
    "removes the batches older than row_log_retention_days at the next table-row-cleanup run, and keeps the newer",
    async () => {
      const server = await bootFreshServer("rows-retention", {
        ...QUIET_SCHEDULE,
        MARFA_ROW_LOG_RETENTION_DAYS: "30",
      });
      const clock = movedClock(server);
      const { writer, item } = await ledger(server);
      const old = await batchOf(writer, item, 1);
      await clock.advance(20 * DAY_MS);
      const recent = await batchOf(writer, item, 2);

      // The witness: before the clock passes the retention, the run keeps both.
      expect((await runJob(server, "table-row-cleanup")).outcome).toBe("ok");
      expect(await held(writer, item)).toEqual([recent, old]);

      await clock.advance(11 * DAY_MS);
      const run = await runJob(server, "table-row-cleanup");
      expect(run.outcome, String(run.error)).toBe("ok");
      expect(await held(writer, item)).toEqual([recent]);
      const gone = await writer.undoBatch(item, "lines", old);
      expect(gone.status).toBe(404);
      expect(gone.error?.error.code).toBe("batch_not_found");
      const kept = await writer.undoBatch(item, "lines", recent);
      expect(kept.status, JSON.stringify(kept.error)).toBe(200);
      const rows = await writer.listRows(item, "lines");
      expect(rows.data.data.map((row) => row.values)).toEqual([{ amount: 1 }]);
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "keeps a batch whose stored time does not read and every batch after it, and removes the older batches before it",
    async () => {
      const server = await bootFreshServer("rows-retention-unread", {
        ...QUIET_SCHEDULE,
        MARFA_ROW_LOG_RETENTION_DAYS: "30",
      });
      const clock = movedClock(server);
      const { writer, item } = await ledger(server);
      const first = await batchOf(writer, item, 1);
      const unread = await batchOf(writer, item, 2);
      const after = await batchOf(writer, item, 3);
      await clock.advance(31 * DAY_MS);
      const storeAt = (at: string) =>
        withInstanceDatabase(server.sqlitePath, (db) => {
          db.prepare("UPDATE row_batches SET at = ? WHERE id = ?").run(
            at,
            unread,
          );
        });
      // "0" sorts before any cutoff, so only reading the time keeps the batch.
      storeAt("0");

      const run = await runJob(server, "table-row-cleanup");
      expect(run.outcome, String(run.error)).toBe("ok");
      const gone = await writer.undoBatch(item, "lines", first);
      expect(gone.status).toBe(404);
      expect(gone.error?.error.code).toBe("batch_not_found");

      // The witness: with an old time that reads, the same batch and the one after it go.
      storeAt("2000-01-01T00:00:00.000Z");
      expect(await held(writer, item)).toEqual([after, unread]);
      const next = await runJob(server, "table-row-cleanup");
      expect(next.outcome, String(next.error)).toBe("ok");
      expect(await held(writer, item)).toEqual([]);
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "keeps every batch while row_log_retention_days is 0, however far the clock moves",
    async () => {
      const server = await bootFreshServer("rows-retention-zero", {
        ...QUIET_SCHEDULE,
        MARFA_ROW_LOG_RETENTION_DAYS: "0",
      });
      const clock = movedClock(server);
      const { writer, item } = await ledger(server);
      const first = await batchOf(writer, item, 1);
      const second = await batchOf(writer, item, 2);
      expect(await held(writer, item)).toEqual([second, first]);

      await clock.advance(3650 * DAY_MS);
      const run = await runJob(server, "table-row-cleanup");
      expect(run.outcome, String(run.error)).toBe("ok");
      expect(await held(writer, item)).toEqual([second, first]);
      const undone = await writer.undoBatch(item, "lines", first);
      expect(undone.status, JSON.stringify(undone.error)).toBe(200);
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );
});
