import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bucketAt,
  instanceIdOf,
  ownerOf,
  type Bucket,
} from "../../utils/backups.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { clientsFor, DISK_ONLY } from "../../utils/own-blob-server.js";
import { tempFolder } from "../../utils/temp-folder.js";
import { waitFor } from "../../utils/wait.js";

const SETTINGS = { ...DISK_ONLY, MARFA_BACKUP_INTERVAL_SECONDS: "0" };

/** A destination `PATCH /config` can set, with how to see which backups it holds. */
interface Destination {
  set: Record<string, string | boolean>;
  unset: Record<string, string>;
  /** The names of this instance's backups the destination holds. */
  holds(instance: string): Promise<string[]>;
}

function objectStore(): Destination {
  for (const name of [
    "MARFA_OBJECT_STORE_BUCKET",
    "MARFA_OBJECT_STORE_ENDPOINT",
  ]) {
    if (!process.env[name]) {
      throw new Error(
        `${name} is required for the object-store fixtures: source the env file \`pnpm garage:up\` writes.`,
      );
    }
  }
  const prefix = `fixture-${randomUUID()}`;
  const bucket: Bucket = bucketAt(prefix);
  return {
    set: {
      object_store_bucket: process.env.MARFA_OBJECT_STORE_BUCKET!,
      object_store_endpoint: process.env.MARFA_OBJECT_STORE_ENDPOINT!,
      object_store_region: process.env.MARFA_OBJECT_STORE_REGION ?? "",
      object_store_access_key_id:
        process.env.MARFA_OBJECT_STORE_ACCESS_KEY_ID ?? "",
      object_store_secret_access_key:
        process.env.MARFA_OBJECT_STORE_SECRET_ACCESS_KEY ?? "",
      object_store_path_style: true,
      object_store_prefix: prefix,
    },
    unset: { object_store_bucket: "" },
    async holds(instance) {
      return (await bucket.backupKeys())
        .filter((key) => key.startsWith(`${prefix}/backups/${instance}/`))
        .map((key) => key.slice(`${prefix}/backups/${instance}/`.length));
    },
  };
}

function backupFolder(): Destination {
  const root = tempFolder("marfa-backup-destination-");
  return {
    set: { backup_path: root },
    unset: { backup_path: "" },
    async holds(instance) {
      try {
        return readdirSync(join(root, "backups", instance)).sort();
      } catch {
        return [];
      }
    },
  };
}

async function setTo(
  server: FreshServer,
  settings: Record<string, string | boolean>,
): Promise<void> {
  const written = await clientsFor(server).local.patchConfig(settings);
  expect(written.status, JSON.stringify(written.error)).toBe(200);
}

async function names(server: FreshServer): Promise<string[]> {
  const listed = await ownerOf(server).listBackups();
  expect(listed.status, JSON.stringify(listed.error)).toBe(200);
  return listed.data.data.map((backup) => backup.name);
}

/** Sets a destination and waits until a list answers from it, for a test's setup. */
async function setAndWait(
  server: FreshServer,
  settings: Record<string, string | boolean>,
): Promise<void> {
  await setTo(server, settings);
  await waitFor("the destination to be in use", async () =>
    (await ownerOf(server).listBackups()).status === 200 ? true : undefined,
  );
}

async function took(server: FreshServer): Promise<string> {
  const taken = await ownerOf(server).runBackup();
  expect(taken.status, JSON.stringify(taken.error)).toBe(200);
  expect(taken.data.outcome).toBe("put");
  return taken.data.backup!.name;
}

describe("a destination set or unset through /config", () => {
  it(
    "is the one the next GET /backups lists, whether it is an object store or a backup folder, with a backup in each destination to tell them apart",
    async () => {
      for (const make of [objectStore, backupFolder]) {
        const server = await bootFreshServer(
          "backup-destination-set-list",
          SETTINGS,
        );
        try {
          const [first, second] = [make(), make()];
          await setTo(server, first.set);
          const inFirst = await took(server);
          await setTo(server, second.set);
          const inSecond = await took(server);

          await setTo(server, first.set);
          expect(await names(server)).toEqual([inFirst]);
          await setTo(server, second.set);
          expect(await names(server)).toEqual([inSecond]);
        } finally {
          await server.stop();
        }
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "is the one the next POST /backups writes to, whether it is an object store or a backup folder",
    async () => {
      for (const make of [objectStore, backupFolder]) {
        const server = await bootFreshServer(
          "backup-destination-set-take",
          SETTINGS,
        );
        try {
          const instance = await instanceIdOf(server);
          const [first, second] = [make(), make()];
          await setTo(server, first.set);
          const inFirst = await took(server);
          await setTo(server, second.set);
          const inSecond = await took(server);
          expect(await first.holds(instance)).toEqual([inFirst]);
          expect(await second.holds(instance)).toEqual([inSecond]);
        } finally {
          await server.stop();
        }
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "is the one the next restore reads from, whether it is an object store or a backup folder, with a backup in each destination to tell them apart",
    async () => {
      for (const make of [objectStore, backupFolder]) {
        const server = await bootFreshServer(
          "backup-destination-set-restore",
          SETTINGS,
        );
        try {
          const owner = ownerOf(server);
          const instance = await instanceIdOf(server);
          const [first, second] = [make(), make()];
          await setAndWait(server, first.set);
          const inFirst = await took(server);
          await setAndWait(server, second.set);
          const inSecond = await took(server);

          await setTo(server, first.set);
          const absent = await owner.restoreBackup(instance, inSecond);
          expect(absent.status, JSON.stringify(absent.error)).toBe(404);
          expect(absent.error?.error.code).toBe("backup_not_found");

          await setTo(server, second.set);
          const gone = await owner.restoreBackup(instance, inFirst);
          expect(gone.status, JSON.stringify(gone.error)).toBe(404);
          expect(gone.error?.error.code).toBe("backup_not_found");

          await setTo(server, first.set);
          await setTo(server, second.set);
          const restored = await owner.restoreBackup(instance, inSecond);
          expect(restored.status, JSON.stringify(restored.error)).toBe(200);
        } finally {
          await server.stop();
        }
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "is no destination in the next GET /backups, POST /backups, adopt and restore once a write to /config unsets it, even when the server could not record that it let the store go",
    async () => {
      for (const make of [objectStore, backupFolder]) {
        const server = await bootFreshServer(
          "backup-destination-unset",
          SETTINGS,
        );
        try {
          const owner = ownerOf(server);
          const instance = await instanceIdOf(server);
          const destination = make();
          await setTo(server, destination.set);
          const kept = await took(server);

          const refused = async (): Promise<void> => {
            for (const answer of [
              await owner.listBackups(),
              await owner.runBackup(),
              await owner.adoptBackupFolder(),
              await owner.restoreBackup(instance, kept),
            ]) {
              expect(answer.status, JSON.stringify(answer.error)).toBe(409);
              expect(answer.error?.error.code).toBe("no_backup_destination");
            }
          };

          await setTo(server, destination.unset);
          await refused();

          await setTo(server, destination.set);
          expect(await names(server)).toEqual([kept]);
          await server.setFault("fail:stores-record");
          try {
            await setTo(server, destination.unset);
            await refused();
            await server.setFault("fail:stores-record");
            await refused();
          } finally {
            await server.clearFault("fail:stores-record");
          }
        } finally {
          await server.stop();
        }
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "is answered 503 blob_store_unavailable by the next GET /backups, POST /backups and restore when the object store a write to /config names cannot be used, and never 409",
    async () => {
      const server = await bootFreshServer(
        "backup-destination-unusable",
        SETTINGS,
      );
      try {
        const owner = ownerOf(server);
        const set = objectStore().set;
        await setTo(server, {
          ...set,
          object_store_secret_access_key: `wrong-${randomUUID()}`,
        });

        const instance = await instanceIdOf(server);
        for (const answer of [
          await owner.listBackups(),
          await owner.runBackup(),
          await owner.restoreBackup(instance, "20260101T000000.000Z.json"),
        ]) {
          expect(answer.status, JSON.stringify(answer.error)).toBe(503);
          expect(answer.error?.error.code).toBe("blob_store_unavailable");
        }
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
