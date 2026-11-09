import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backupName, bucketAt, ownerOf } from "../../utils/backups.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { ownObjectStore } from "../../utils/own-blob-server.js";

/**
 * Which backups a put leaves. Objects named as backups from earlier days are
 * put straight into the bucket beside objects that are not backups: a file's
 * object, a stray name in the backups folder, a backup's name one folder
 * deeper, and one with a suffix. The server's clock is the fixture's.
 */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const store = ownObjectStore();
const bucket = bucketAt(store.S3_PREFIX);
let server: FreshServer;

beforeAll(async () => {
  server = await bootFreshServer("backup-thinning", {
    ...store,
    MARFA_BACKUP_INTERVAL_MS: "0",
  });
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
  it("keeps the last day and the newest of each older day for thirty days, and deletes nothing that is not a listed backup", async () => {
    const folder = `${store.S3_PREFIX}/backups`;
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
    const strays = [
      `${store.S3_PREFIX}/${"ab".repeat(32)}/0190a1b2c3d4`,
      `${folder}/notes.txt`,
      `${folder}/${backupName(before(50))}.partial`,
      `${folder}/deeper/${backupName(before(60))}`,
      `${store.S3_PREFIX}/${backupName(before(70))}`,
    ];
    for (const name of [...kept, ...deleted]) {
      await bucket.put(`${folder}/${name}`, "an earlier backup");
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
      expect(left).toContain(`${folder}/${name}`);
    }
    for (const name of deleted) {
      expect(left).not.toContain(`${folder}/${name}`);
    }
    for (const key of strays) {
      expect(left).toContain(key);
    }
    expect(left).toContain(`${store.S3_PREFIX}/.marfa-store`);
  });
});
