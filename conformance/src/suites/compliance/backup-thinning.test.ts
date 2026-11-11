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
 * Which backups a put leaves. The server puts its own backups at instants its
 * paused clock is moved to. Objects named as backups are put straight into
 * the bucket beside them: in another instance's folder on the same prefix, in
 * this instance's folder though the server never put them, and beside
 * objects that are not backups: a file's object, a stray name in the backups
 * folder, a backup's name directly in the backups folder, one folder deeper,
 * and one with a suffix.
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
    MARFA_BACKUP_INTERVAL_SECONDS: "0",
  });
  own = `${folder}/${await instanceIdOf(server)}`;
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

/** Puts a backup at `at`, moving the paused clock there; answers its name and how many it removed. */
async function backUpAt(
  at: number,
): Promise<{ name: string; removed: number }> {
  const now = await server.pauseClock(true);
  if (at > now) await server.advanceClock(at - now);
  const run = await ownerOf(server).runBackup();
  expect(run.status, JSON.stringify(run.error)).toBe(200);
  expect(run.data.unremoved).toBe(0);
  return { name: run.data.backup.name, removed: run.data.removed };
}

describe("thinning the backups", () => {
  it("keeps the last day and the newest of each older day for thirty days, and deletes nothing that is not a listed backup of this instance", async () => {
    const start = await server.pauseClock(true);
    try {
      // Noon UTC on a day more than 400 days ahead, so every backup is put
      // after the clock's present.
      const noon = new Date(start + 402 * DAY);
      noon.setUTCHours(12, 0, 0, 0);
      const last = noon.getTime();
      const before = (days: number, hours = 0) =>
        last - days * DAY + hours * HOUR;
      const keptAt = [before(30), before(10, 3), last - 2 * HOUR];
      const deletedAt = [before(400), before(40), before(10, -3)];
      const others = [
        `${folder}/${OTHER_INSTANCE}/${backupName(new Date(before(10, -3)))}`,
        `${folder}/${OTHER_INSTANCE}/${backupName(new Date(before(40)))}`,
        `${folder}/${OTHER_INSTANCE}/${backupName(new Date(before(400)))}`,
      ];
      const strays = [
        `${store.S3_PREFIX}/blobs/${"ab".repeat(32)}/0190a1b2c3d4`,
        `${folder}/notes.txt`,
        `${folder}/${backupName(new Date(before(45)))}`,
        `${own}/${backupName(new Date(before(35)))}`,
        `${own}/${backupName(new Date(before(50)))}.partial`,
        `${own}/deeper/${backupName(new Date(before(60)))}`,
        `${store.S3_PREFIX}/${backupName(new Date(before(70)))}`,
      ];
      for (const key of others) {
        await bucket.put(key, "another instance's backup");
      }
      for (const key of strays) {
        await bucket.put(key, "not a backup this instance put");
      }

      const names = new Map<number, string>();
      let removed = 0;
      for (const at of [...keptAt, ...deletedAt].sort((a, b) => a - b)) {
        const put = await backUpAt(at);
        names.set(at, put.name);
        removed += put.removed;
      }
      const final = await backUpAt(last);
      removed += final.removed;
      expect(removed).toBe(deletedAt.length);

      const left = await bucket.keys();
      for (const name of [...keptAt.map((at) => names.get(at)!), final.name]) {
        expect(left).toContain(`${own}/${name}`);
      }
      for (const at of deletedAt) {
        expect(left).not.toContain(`${own}/${names.get(at)!}`);
      }
      for (const key of [...others, ...strays]) {
        expect(left).toContain(key);
      }
      expect(left).toContain(`${store.S3_PREFIX}/blobs/.marfa-store`);
    } finally {
      await server.pauseClock(false);
    }
  });

  it("keeps every backup taken in the day before the one just put, however long the put took", async () => {
    const start = await server.pauseClock(true);
    try {
      // Two on one day, which the newest-of-the-day rule would thin to one
      // if the day were counted from when the put ended.
      const earlier = await backUpAt(start + HOUR);
      const later = await backUpAt(start + HOUR + 1);
      const taken = start + 24 * HOUR;
      await server.advanceClock(taken - (start + HOUR + 1));

      await server.setFault("hold:backup:put");
      const run = ownerOf(server).runBackup();
      await server.waitForHold("hold:backup:put");
      await server.advanceClock(2 * HOUR);
      await server.clearFault();
      const done = await run;
      expect(done.status, JSON.stringify(done.error)).toBe(200);
      expect(done.data.backup.created_at).toBe(new Date(taken).toISOString());

      const left = await bucket.keys();
      for (const put of [earlier, later]) {
        expect(left).toContain(`${own}/${put.name}`);
      }
    } finally {
      await server.pauseClock(false);
    }
  });
});
