import { afterAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, renameSync, rmSync } from "node:fs";
import {
  bootFreshServer,
  bootRefused,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
  type RefusedBoot,
} from "../../utils/fresh-server.js";
import {
  blobFolder,
  bytesOf,
  clientsFor,
  ownObjectStore,
  runJob,
  whenCopied,
} from "../../utils/own-blob-server.js";

/**
 * A disk folder missing at start beside an object store, on a server of the
 * fixture's own whose object store sits under a prefix of its own. The bucket
 * the server kept copies in rebuilds the folder; any other refuses the start.
 */
let server: FreshServer | undefined;

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

describe("a missing folder beside an object store", () => {
  it(
    "refuses to start over a missing folder beside a bucket the server never kept copies in, and rebuilds the folder from the bucket it did",
    async () => {
      server = await bootFreshServer("blob-store-rebuild", ownObjectStore());
      let { operator, working } = clientsFor(server);
      const bytes = bytesOf("rebuilt from the bucket", 120);
      const uploaded = await working.uploadBlob(bytes, "text/plain");
      expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(201);
      const hash = uploaded.data.hash;
      await whenCopied(operator, [hash]);
      const before = (await operator.listBlobStores()).data.data;
      const disk = before.find((store) => store.kind === "disk")!;

      const folder = blobFolder(server);
      const image = await server.image();
      let refused: RefusedBoot | undefined;
      try {
        await server.restart(async () => {
          renameSync(folder, `${folder}.away`);
          // Another prefix of the same bucket: a store with no marker, which
          // holds none of the copies.
          refused = await bootRefused("blob-store-rebuild-refused", {
            prepare: (_database, state) =>
              cpSync(image, state, { recursive: true }),
            extraEnv: { ...ownObjectStore(), BLOB_PATH: folder },
          });
          expect(refused.code).toBe(1);
          expect(refused.output).toContain(folder);
          expect(existsSync(folder)).toBe(false);
        });
      } finally {
        await refused?.stop();
        rmSync(image, { recursive: true, force: true });
      }

      // Restarted over the same missing folder with the bucket it kept copies
      // in: a fresh disk store, filled by replication.
      ({ operator, working } = clientsFor(server));
      const after = (await operator.listBlobStores()).data.data;
      const fresh = after.find(
        (store) => store.kind === "disk" && store.detached_at === null,
      )!;
      expect(fresh.id).not.toBe(disk.id);
      expect(
        after.find((store) => store.id === disk.id)!.detached_at,
      ).not.toBeNull();
      const download = await operator.downloadBlob(hash);
      expect(download.status).toBe(200);
      expect(
        Buffer.from(download.data as ArrayBuffer).equals(Buffer.from(bytes)),
      ).toBe(true);
      const replicated = await runJob(operator, "blob-replicate");
      expect(replicated.result).toMatchObject({ remaining: 0 });
      const rows = (await operator.listBlobCopies(hash)).data.data;
      expect(
        rows.some((row) => row.store_id === fresh.id && !row.detached),
      ).toBe(true);
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );
});
