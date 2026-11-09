import { afterAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { storeSettingRow } from "../../utils/instance-database.js";
import {
  DAY_MS,
  movedClock,
  QUIET_SCHEDULE,
  quiet,
  runJob,
  writerOf,
} from "../../utils/moved-clock.js";

// No API stores a value outside a setting's bounds, so the row is written as a
// hand edit or a release that narrows a bound would leave it.

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

const storeRow = (server: FreshServer, key: string, value: string | null) =>
  storeSettingRow(server.sqlitePath, key, value);

describe("a stored setting that decides what a job deletes and does not read", () => {
  it(
    "ends a trash-purge run in error and purges nothing, and purges on the seeded retention once the row is gone",
    async () => {
      const server = await bootFreshServer("trash-unreadable-retention", {
        ...QUIET_SCHEDULE,
        MARFA_TRASH_RETENTION_DAYS: "1",
      });
      await quiet(server, ["trash-purge"]);
      const writer = writerOf(server);
      const created = await writer.createItem({
        type: "core.note",
        properties: { body: "binned" },
      });
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      const id = created.data.item.id;
      expect((await writer.deleteItem(id)).ok).toBe(true);
      await movedClock(server).advance(2 * DAY_MS);
      const inBin = async (): Promise<string[]> => {
        const listed = await writer.listItems({ state: "trashed", limit: 100 });
        expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
        return listed.data.data.map((item) => item.id);
      };

      storeRow(server, "trash_retention_days", "soon");
      const refused = await runJob(server, "trash-purge");
      expect(refused.outcome).toBe("error");
      expect(refused.error).toEqual(expect.any(String));
      expect(await inBin()).toEqual([id]);

      storeRow(server, "trash_retention_days", null);
      const purged = await runJob(server, "trash-purge");
      expect(purged.outcome, String(purged.error)).toBe("ok");
      expect(purged.result).toEqual({ deleted: 1 });
      expect(await inBin()).toEqual([]);
    },
    4 * FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "ends a version-thinning run in error and thins nothing, and thins on the seeded maximum once the row is gone",
    async () => {
      const server = await bootFreshServer("thinning-unreadable-maximum", {
        ...QUIET_SCHEDULE,
        MARFA_VERSION_MAX_VERSIONS: "1",
      });
      await quiet(server, ["version-thinning"]);
      const writer = writerOf(server);
      const created = await writer.createItem({
        type: "core.note",
        properties: { body: "v1" },
      });
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      const id = created.data.item.id;
      for (let version = 1; version <= 3; version += 1) {
        const updated = await writer.updateItem(id, {
          properties: { body: `v${String(version + 1)}` },
          version,
        });
        expect(updated.ok, JSON.stringify(updated.error)).toBe(true);
      }
      const snapshots = async (): Promise<number> => {
        const listed = await writer.getVersions(id);
        expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
        return listed.data.data.length;
      };
      const written = await snapshots();
      expect(written).toBeGreaterThan(2);

      storeRow(server, "version_max_versions", "many");
      const refused = await runJob(server, "version-thinning");
      expect(refused.outcome).toBe("error");
      expect(refused.error).toEqual(expect.any(String));
      expect(await snapshots()).toBe(written);

      storeRow(server, "version_max_versions", null);
      const thinned = await runJob(server, "version-thinning");
      expect(thinned.outcome, String(thinned.error)).toBe("ok");
      expect(await snapshots()).toBeLessThan(written);
    },
    4 * FRESH_SERVER_TIMEOUT_MS,
  );
});
