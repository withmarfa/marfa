import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ownerOf } from "../../utils/backups.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
} from "../../utils/fresh-server.js";
import { clientsFor, DISK_ONLY } from "../../utils/own-blob-server.js";
import { tempFolder } from "../../utils/temp-folder.js";
import { waitFor } from "../../utils/wait.js";

function objectStore(): Record<string, string | boolean> {
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
  return {
    object_store_bucket: process.env.MARFA_OBJECT_STORE_BUCKET!,
    object_store_endpoint: process.env.MARFA_OBJECT_STORE_ENDPOINT!,
    object_store_region: process.env.MARFA_OBJECT_STORE_REGION ?? "",
    object_store_access_key_id:
      process.env.MARFA_OBJECT_STORE_ACCESS_KEY_ID ?? "",
    object_store_secret_access_key:
      process.env.MARFA_OBJECT_STORE_SECRET_ACCESS_KEY ?? "",
    object_store_path_style: true,
    object_store_prefix: `fixture-${randomUUID()}`,
  };
}

const SETTINGS = {
  ...DISK_ONLY,
  MARFA_BACKUP_INTERVAL_SECONDS: "0",
};

describe("a destination set through /config", () => {
  it(
    "is the one the next GET /backups, POST /backups and restore use, whether it is an object store or a backup folder",
    async () => {
      const store = await bootFreshServer(
        "backup-destination-bucket",
        SETTINGS,
      );
      const folder = tempFolder("marfa-backup-destination-");
      const local = await bootFreshServer(
        "backup-destination-folder",
        SETTINGS,
      );
      try {
        for (const [server, write] of [
          [store, objectStore()],
          [local, { backup_path: folder }],
        ] as const) {
          const set = await clientsFor(server).operator.patchConfig(write);
          expect(set.status, JSON.stringify(set.error)).toBe(200);
          const owner = ownerOf(server);

          const listed = await owner.listBackups();
          expect(listed.status, JSON.stringify(listed.error)).toBe(200);
          expect(listed.data.data).toEqual([]);

          const taken = await owner.runBackup();
          expect(taken.status, JSON.stringify(taken.error)).toBe(200);

          const absent = await owner.restoreBackup(
            randomUUID(),
            "20260101T000000.000Z.json",
          );
          expect(absent.error?.error.code).not.toBe("no_backup_destination");
        }
      } finally {
        await Promise.all([store.stop(), local.stop()]);
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "is no destination in the next GET /backups once a write to /config unsets it",
    async () => {
      const server = await bootFreshServer(
        "backup-destination-unset",
        SETTINGS,
      );
      try {
        const { operator } = clientsFor(server);
        const owner = ownerOf(server);
        const set = await operator.patchConfig(objectStore());
        expect(set.status, JSON.stringify(set.error)).toBe(200);
        await waitFor("the object store to be the destination", async () =>
          (await owner.listBackups()).status === 200 ? true : undefined,
        );

        const unset = await operator.patchConfig({ object_store_bucket: "" });
        expect(unset.status, JSON.stringify(unset.error)).toBe(200);
        const refused = await owner.listBackups();
        expect(refused.status, JSON.stringify(refused.data)).toBe(409);
        expect(refused.error?.error.code).toBe("no_backup_destination");
        expect((await owner.runBackup()).error?.error.code).toBe(
          "no_backup_destination",
        );
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "is answered 503 blob_store_unavailable by the next GET /backups when the object store a write to /config names cannot be used",
    async () => {
      const server = await bootFreshServer(
        "backup-destination-unusable",
        SETTINGS,
      );
      try {
        const set = await clientsFor(server).operator.patchConfig({
          ...objectStore(),
          object_store_secret_access_key: `wrong-${randomUUID()}`,
        });
        expect(set.status, JSON.stringify(set.error)).toBe(200);

        const refused = await ownerOf(server).listBackups();
        expect(refused.status, JSON.stringify(refused.error)).toBe(503);
        expect(refused.error?.error.code).toBe("blob_store_unavailable");
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});
