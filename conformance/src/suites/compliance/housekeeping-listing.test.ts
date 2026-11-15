import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { operatorOf } from "../../utils/moved-clock.js";
import { DISK_ONLY, ownObjectStore } from "../../utils/own-blob-server.js";

/**
 * Which jobs `GET /housekeeping` lists. Twelve are listed on every instance.
 * Three are listed only where something switches them on: the heartbeat by
 * the receiver the environment names, the orphan sweep by `blob_cleanup_enabled`
 * and the backup by a place to put backups and `backup_interval_seconds`.
 *
 * Each case boots a server of its own, because the receiver and the stores
 * are the server's. The two stored settings are changed through `/config` on
 * a server that lists every job, which is the witness that a job left out
 * was listed before.
 */

const EVERY_INSTANCE = [
  "audit-cleanup",
  "blob-integrity",
  "blob-replicate",
  "bulk-action-gc",
  "credential-cleanup",
  "enrichment-sweep",
  "event-log-cleanup",
  "feed-expiry",
  "inbound-delivery-cleanup",
  "table-row-cleanup",
  "trash-purge",
  "version-thinning",
];

/** A receiver that nothing listens at: the listing is read, no heartbeat is. */
const RECEIVER = { MARFA_HEARTBEAT_URL: "http://127.0.0.1:9/heartbeat" };

const servers: FreshServer[] = [];
const folders: string[] = [];

afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop()));
  for (const folder of folders)
    rmSync(folder, { recursive: true, force: true });
}, FRESH_SERVER_TIMEOUT_MS);

async function listed(
  label: string,
  settings: Record<string, string>,
): Promise<{ names: string[]; server: FreshServer }> {
  const server = await bootFreshServer(label, settings);
  servers.push(server);
  const listing = await operatorOf(server).listHousekeeping();
  expect(listing.status).toBe(200);
  return { names: listing.data.data.map((row) => row.name).sort(), server };
}

describe("the jobs the listing holds", () => {
  it(
    "lists the twelve jobs every instance runs, and no job that something switches on, on an instance with none of them",
    async () => {
      // The orphan sweep is on by default, so the instance has it too.
      const { names } = await listed("housekeeping-listing-bare", DISK_ONLY);
      expect(names).toEqual([...EVERY_INSTANCE, "blob-orphans"].sort());
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "lists each job that something switches on, where it is switched on, and leaves it out where it is not",
    async () => {
      const folder = mkdtempSync(join(tmpdir(), "marfa-listing-"));
      folders.push(folder);
      const everything = { ...ownObjectStore(), ...RECEIVER };
      const all = [
        ...EVERY_INSTANCE,
        "backup",
        "blob-orphans",
        "heartbeat",
      ].sort();
      const without = (...left: string[]) =>
        all.filter((name) => !left.includes(name));

      // The witness: each of the three is listed where it is switched on.
      const on = await listed("housekeeping-listing-on", everything);
      expect(on.names).toEqual(all);

      // The two stored settings are changed with no restart, and the listing
      // follows each.
      const operator = operatorOf(on.server);
      const nameOf = async (): Promise<string[]> =>
        (await operator.listHousekeeping()).data.data
          .map((row) => row.name)
          .sort();
      for (const [setting, off, job] of [
        ["blob_cleanup_enabled", false, "blob-orphans"],
        ["backup_interval_seconds", 0, "backup"],
      ] as const) {
        const changed = await operator.patchConfig({ [setting]: off });
        expect(changed.status, JSON.stringify(changed.error)).toBe(200);
        expect(await nameOf(), setting).toEqual(without(job));
        const refused = await operator.runHousekeeping(job);
        expect(refused.status, job).toBe(404);
        expect(refused.error?.error.code, job).toBe(
          "housekeeping_job_not_found",
        );
        const cleared = await operator.patchConfig({ [setting]: null });
        expect(cleared.status, JSON.stringify(cleared.error)).toBe(200);
        expect(await nameOf(), setting).toEqual(all);
      }

      // No receiver: no heartbeat.
      const { MARFA_HEARTBEAT_URL: _receiver, ...withoutReceiver } = everything;
      expect(
        (await listed("housekeeping-listing-no-receiver", withoutReceiver))
          .names,
      ).toEqual(without("heartbeat"));

      // No place to put a backup, with an interval above 0: no backup.
      const nowhere = await listed("housekeeping-listing-nowhere", {
        ...DISK_ONLY,
        ...RECEIVER,
      });
      expect(nowhere.names).toEqual(without("backup"));

      // A backup folder is a place to put one, where there is no object store.
      const folderOnly = await listed("housekeeping-listing-folder", {
        ...DISK_ONLY,
        MARFA_BACKUP_PATH: folder,
      });
      expect(folderOnly.names).toEqual(without("heartbeat"));
    },
    4 * FRESH_SERVER_TIMEOUT_MS,
  );
});
