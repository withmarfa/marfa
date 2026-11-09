import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  backupName,
  bucketAt,
  instanceIdOf,
  ownerOf,
} from "../../utils/backups.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { ownObjectStore } from "../../utils/own-blob-server.js";

/**
 * Which backups a put leaves. Objects named as backups from earlier days are
 * put straight into the bucket: in this instance's folder, in another
 * instance's folder on the same prefix, and beside objects that are not
 * backups: a file's object, a stray name in the backups folder, a backup's
 * name directly in the backups folder, one folder deeper, and one with a
 * suffix. The server's clock is the fixture's until the last test pauses and
 * moves it.
 */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OTHER_INSTANCE = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const store = ownObjectStore();
const bucket = bucketAt(store.S3_PREFIX);
const folder = `${store.S3_PREFIX}/backups`;
let server: FreshServer;
let own: string;

beforeAll(async () => {
  server = await bootFreshServer("backup-thinning", {
    ...store,
    MARFA_BACKUP_INTERVAL_MS: "0",
  });
  own = `${folder}/${await instanceIdOf(server)}`;
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

/** Noon UTC `days` days before today, moved by `hours`. */
function before(days: number, hours = 0): Date {
  const noon = new Date();
  noon.setUTCHours(12, 0, 0, 0);
  return new Date(noon.getTime() - days * DAY + hours * HOUR);
}

describe("thinning the backups", () => {
  it("keeps the last day and the newest of each older day for thirty days, and deletes nothing that is not a listed backup of this instance", async () => {
    const recent = new Date(Date.now() - 2 * HOUR);
    const kept = [
      backupName(recent),
      backupName(before(10, 3)),
      backupName(before(30)),
    ];
    const deleted = [
      backupName(before(10, -3)),
      backupName(before(40)),
      backupName(before(400)),
    ];
    const others = [
      `${folder}/${OTHER_INSTANCE}/${backupName(before(10, -3))}`,
      `${folder}/${OTHER_INSTANCE}/${backupName(before(40))}`,
      `${folder}/${OTHER_INSTANCE}/${backupName(before(400))}`,
    ];
    const strays = [
      `${store.S3_PREFIX}/${"ab".repeat(32)}/0190a1b2c3d4`,
      `${folder}/notes.txt`,
      `${folder}/${backupName(before(45))}`,
      `${own}/${backupName(before(50))}.partial`,
      `${own}/deeper/${backupName(before(60))}`,
      `${store.S3_PREFIX}/${backupName(before(70))}`,
    ];
    for (const name of [...kept, ...deleted]) {
      await bucket.put(`${own}/${name}`, "an earlier backup");
    }
    for (const key of others) {
      await bucket.put(key, "another instance's backup");
    }
    for (const key of strays) {
      await bucket.put(key, "not a backup");
    }

    const run = await ownerOf(server).runBackup();
    expect(run.status, JSON.stringify(run.error)).toBe(200);
    expect(run.data.removed).toBe(deleted.length);
    expect(run.data.unremoved).toBe(0);

    const left = await bucket.keys();
    for (const name of [...kept, run.data.backup.name]) {
      expect(left).toContain(`${own}/${name}`);
    }
    for (const name of deleted) {
      expect(left).not.toContain(`${own}/${name}`);
    }
    for (const key of [...others, ...strays]) {
      expect(left).toContain(key);
    }
    expect(left).toContain(`${store.S3_PREFIX}/.marfa-store`);
  });

  it("keeps every backup taken in the day before the one just put, however long the put took", async () => {
    const taken = await server.pauseClock(true);
    try {
      // Two on one day, which the newest-of-the-day rule would thin to one
      // if the day were counted from when the put ended.
      const earlier = new Date(taken - 23 * HOUR);
      const later = new Date(earlier.getTime() + 1);
      for (const at of [earlier, later]) {
        await bucket.put(`${own}/${backupName(at)}`, "an earlier backup");
      }

      await server.setFault("hold:backup:put");
      const run = ownerOf(server).runBackup();
      await server.waitForHold("hold:backup:put");
      await server.advanceClock(2 * HOUR);
      await server.clearFault();
      const done = await run;
      expect(done.status, JSON.stringify(done.error)).toBe(200);
      expect(done.data.backup.created_at).toBe(new Date(taken).toISOString());

      const left = await bucket.keys();
      for (const at of [earlier, later]) {
        expect(left).toContain(`${own}/${backupName(at)}`);
      }
    } finally {
      await server.pauseClock(false);
    }
  });
});
