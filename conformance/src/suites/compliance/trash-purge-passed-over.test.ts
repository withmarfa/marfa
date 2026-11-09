import { afterAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import {
  DAY_MS,
  movedClock,
  QUIET_SCHEDULE,
  quiet,
  runJob,
  writerOf,
} from "../../utils/moved-clock.js";

// No API refuses removal of one row, so a database trigger creates that failure.

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

describe("a run of trash-purge", () => {
  it(
    "gives the number of items it left for the next run as passed_over, and leaves passed_over out of a run that passed over none",
    async () => {
      const server = await bootFreshServer("trash-passed-over", QUIET_SCHEDULE);
      await quiet(server, ["trash-purge"]);
      const writer = writerOf(server);
      const config = (await writer.getConfig()).data as Record<string, unknown>;
      const set = await writer.updateConfig({
        ...config,
        trash_retention_days: 1,
      });
      expect(set.status, JSON.stringify(set.error)).toBe(200);

      const binned = async (body: string): Promise<string> => {
        const created = await writer.createItem({
          type: "core.note",
          properties: { body },
        });
        expect(created.ok, JSON.stringify(created.error)).toBe(true);
        const id = created.data.item.id;
        expect((await writer.deleteItem(id)).ok).toBe(true);
        return id;
      };
      const inBin = async (): Promise<string[]> => {
        const listed = await writer.listItems({ state: "trashed", limit: 100 });
        expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
        return listed.data.data.map((item) => item.id).sort();
      };
      const stuck = await binned("stuck");
      withInstanceDatabase(server.sqlitePath, (db) => {
        db.exec(
          `CREATE TRIGGER refuse_one_purge BEFORE DELETE ON items
           WHEN old.id = '${stuck}'
           BEGIN SELECT RAISE(ABORT, 'refused'); END`,
        );
      });

      await movedClock(server).advance(2 * DAY_MS);
      // Put in the bin after the move, so it is not yet old enough.
      const recent = await binned("recent");

      const first = await runJob(server, "trash-purge");
      expect(first.outcome, String(first.error)).toBe("ok");
      expect(first.result).toEqual({ deleted: 0, passed_over: 1 });
      expect(await inBin()).toEqual([stuck, recent].sort());

      // Removing the trigger lets the same purge succeed.
      withInstanceDatabase(server.sqlitePath, (db) => {
        db.exec("DROP TRIGGER refuse_one_purge");
      });
      const second = await runJob(server, "trash-purge");
      expect(second.outcome, String(second.error)).toBe("ok");
      expect(second.result).toEqual({ deleted: 1 });
      expect(await inBin()).toEqual([recent]);
    },
    4 * FRESH_SERVER_TIMEOUT_MS,
  );
});
