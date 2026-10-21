import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MarfaClient } from "../../client/api.js";
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
  diskPath,
  DISK_ONLY,
  pastInstant,
  runJob,
} from "../../utils/own-blob-server.js";

/**
 * The copy record and the stores behind it, on a server of the fixture's
 * own that keeps its bytes on one disk and has no object store.
 *
 * **Why a server of its own.** With an object store attached, an upload wakes
 * replication and a second copy appears within a second, and the run's other
 * files run the integrity check over every copy it holds. Here the one disk
 * store is the only place a copy can be, and the server holds only the blobs
 * this file uploads, so what a run of `blob-integrity` answers is a count of
 * them. The tests read in order: each leaves the blobs the next counts.
 *
 * **A store is its folder.** A store's id is read from the marker its folder
 * holds, so the folder the server is restarted over decides which store it
 * is. The folder tests restart the server over a folder that kept its
 * marker, over another folder, and over its own folder with the marker or
 * the whole folder gone while the log still records copies there.
 */
let server: FreshServer | undefined;
let operator: MarfaClient;
let working: MarfaClient;

const sizes = { first: 90, second: 110, altered: 130, missing: 150 } as const;
const content = {
  first: bytesOf("the first blob of the folder fixtures", sizes.first),
  second: bytesOf("the second blob of the folder fixtures", sizes.second),
  altered: bytesOf("a blob altered on the disk", sizes.altered),
  missing: bytesOf("a blob removed from the disk", sizes.missing),
};
const hashes = {} as Record<keyof typeof content, string>;
const stamps = {} as Record<"first" | "second", string>;

/** Where a disk store kept in `folder` keeps one blob's bytes. */
function pathIn(folder: string, hash: string): string {
  const hex = hash.slice("sha256:".length);
  return join(folder, hex.slice(0, 4), hex);
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function upload(name: keyof typeof content): Promise<void> {
  const res = await working.uploadBlob(content[name], "text/plain");
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  expect(res.data.hash).toBe(sha256(content[name]));
  hashes[name] = res.data.hash;
}

async function copies(hash: string) {
  const res = await operator.listBlobCopies(hash);
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data.data;
}

beforeAll(async () => {
  server = await bootFreshServer("blob-store-folders", DISK_ONLY);
  ({ operator, working } = clientsFor(server));
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

describe("the copy record on an instance with one disk store", () => {
  it("records a new blob's one copy as the disk store, unverified", async () => {
    await upload("first");
    const stores = (await operator.listBlobStores()).data.data;
    expect(stores.map((store) => store.kind)).toEqual(["disk"]);
    expect(await copies(hashes.first)).toEqual([
      expect.objectContaining({
        store_id: stores[0]!.id,
        kind: "disk",
        policy: "all",
        detached: false,
        verified_at: null,
      }),
    ]);
  });

  it("stamps each intact copy with the time of the check, and moves the stamp on the next check", async () => {
    await upload("second");
    const first = await runJob(operator, "blob-integrity");
    expect(first.result).toEqual({
      verified: 2,
      struck: 0,
      bytes: sizes.first + sizes.second,
      unreachable: 0,
    });
    const afterFirst = await Promise.all(
      [hashes.first, hashes.second].map(async (hash) => copies(hash)),
    );
    for (const [row] of afterFirst) {
      expect(row!.verified_at).not.toBeNull();
      expect(row!.verified_at! >= first.started_at).toBe(true);
      expect(row!.verified_at! <= first.finished_at).toBe(true);
    }
    stamps.first = afterFirst[0]![0]!.verified_at!;
    stamps.second = afterFirst[1]![0]!.verified_at!;

    await pastInstant(first.finished_at);
    const second = await runJob(operator, "blob-integrity");
    expect(second.result.verified).toBe(2);
    for (const [index, hash] of [hashes.first, hashes.second].entries()) {
      const [row] = await copies(hash);
      expect(row!.verified_at! > [stamps.first, stamps.second][index]!).toBe(
        true,
      );
      expect(row!.verified_at! >= second.started_at).toBe(true);
      expect(row!.verified_at! <= second.finished_at).toBe(true);
    }
    stamps.first = (await copies(hashes.first))[0]!.verified_at!;
    stamps.second = (await copies(hashes.second))[0]!.verified_at!;
  });

  it("keeps a copy's recorded and verified times when the same bytes are uploaded again", async () => {
    const [before] = await copies(hashes.first);
    expect(before!.verified_at).toBe(stamps.first);
    await pastInstant(before!.recorded_at);

    const again = await working.uploadBlob(content.first, "text/plain");
    expect(again.status).toBe(201);
    expect(again.data.hash).toBe(hashes.first);

    expect(await copies(hashes.first)).toEqual([before]);
  });

  it("strikes a copy found altered or missing, counts it, and leaves a blob that lost its last copy with none recorded", async () => {
    await upload("altered");
    await upload("missing");
    // The witness: every copy is intact, so the strikes below are about
    // what is done to the two.
    const sound = await runJob(operator, "blob-integrity");
    expect(sound.result).toEqual({
      verified: 4,
      struck: 0,
      bytes: sizes.first + sizes.second + sizes.altered + sizes.missing,
      unreachable: 0,
    });
    for (const hash of [hashes.altered, hashes.missing]) {
      expect(await copies(hash)).toHaveLength(1);
    }

    // The same length, so only the digest can tell.
    writeFileSync(
      diskPath(server!, hashes.altered),
      new Uint8Array(sizes.altered).fill(0x41),
    );
    unlinkSync(diskPath(server!, hashes.missing));
    const struck = await runJob(operator, "blob-integrity");
    expect(struck.result).toEqual({
      verified: 2,
      struck: 2,
      bytes: sizes.first + sizes.second + sizes.altered + sizes.missing,
      unreachable: 0,
    });

    for (const hash of [hashes.altered, hashes.missing]) {
      expect(await copies(hash)).toEqual([]);
      const audited = await working.listAudit({
        action: "blob.copy_struck",
        resource_id: hash,
      });
      expect(audited.data.data).toHaveLength(1);
      expect(audited.data.data[0]?.details).toMatchObject({ kind: "disk" });
      // The blob is still registered and the bytes are gone, so the door that
      // serves them answers as it does for a hash it never saw.
      const download = await operator.downloadBlob(hash);
      expect(download.status).toBe(404);
      expect(download.error?.error.code).toBe("blob_not_found");
    }
    expect((await copies(hashes.first))[0]!.verified_at).not.toBeNull();
  });
});

describe("a blob that lost its last copy", () => {
  it("answers HEAD as GET does for a blob that lost its last copy", async () => {
    const bytes = bytesOf("a blob whose last copy goes", 140);
    const upload = await working.uploadBlob(bytes, "text/plain");
    expect(upload.status, JSON.stringify(upload.error)).toBe(201);
    const hash = upload.data.hash;
    const link = (await operator.getBlobUrl(hash)).data.url;
    expect(new URL(link).host).toBe(new URL(server!.apiUrl).host);
    const headLink = () => fetch(link, { method: "HEAD" });

    // The witness: every door that reads the bytes answers 200 while the
    // copy is there, so the 404s below are about the copy.
    expect((await operator.headBlob(hash)).status).toBe(200);
    expect((await operator.downloadBlob(hash)).status).toBe(200);
    expect((await headLink()).status).toBe(200);
    const served = await fetch(link);
    expect(served.status).toBe(200);
    await served.arrayBuffer();

    unlinkSync(diskPath(server!, hash));
    const struck = await runJob(operator, "blob-integrity");
    expect(struck.result.struck).toBe(1);
    expect(await copies(hash)).toEqual([]);

    const download = await operator.downloadBlob(hash);
    expect(download.status).toBe(404);
    expect(download.error?.error.code).toBe("blob_not_found");
    expect((await operator.headBlob(hash)).status).toBe(404);
    // The link the instance serves reads the same bytes, so it answers the
    // same.
    const gone = await fetch(link);
    expect(gone.status).toBe(404);
    expect(
      ((await gone.json()) as { error: { code: string } }).error.code,
    ).toBe("blob_not_found");
    expect((await headLink()).status).toBe(404);
  });
});

describe("a store is its folder", () => {
  it("keeps one store through a folder that holds its marker, and detaches it for a fresh folder", async () => {
    const before = (await operator.listBlobStores()).data.data;
    expect(before).toHaveLength(1);
    const original = before[0]!;
    const lastChecked = (await copies(hashes.second))[0]!.verified_at;
    const folder = blobFolder(server!);

    // The folder emptied of every blob but not of its marker: the same
    // store, still attached, still claiming the copies the log names.
    await server!.restart(() => {
      for (const entry of readdirSync(folder)) {
        if (entry !== ".marfa-store") {
          rmSync(join(folder, entry), { recursive: true, force: true });
        }
      }
    });
    ({ operator, working } = clientsFor(server!));
    const kept = (await operator.listBlobStores()).data.data;
    expect(kept.map((store) => [store.id, store.detached_at])).toEqual([
      [original.id, null],
    ]);
    expect(await copies(hashes.first)).toEqual([
      expect.objectContaining({ store_id: original.id, detached: false }),
    ]);
    expect(existsSync(diskPath(server!, hashes.first))).toBe(false);

    // Another folder, which holds no marker: a fresh store with no copies
    // claimed, and the first one stays listed, detached.
    const other = join(server!.stateDir, "other-blobs");
    await server!.restart({ env: { BLOB_PATH: other } });
    ({ operator, working } = clientsFor(server!));
    const after = (await operator.listBlobStores()).data.data;
    expect(after).toHaveLength(2);
    const old = after.find((store) => store.id === original.id)!;
    const fresh = after.find((store) => store.id !== original.id)!;
    expect(old.detached_at).not.toBeNull();
    expect(Date.parse(old.detached_at!)).not.toBeNaN();
    expect(old.attached_at).toBe(original.attached_at);
    expect(fresh.detached_at).toBeNull();
    expect(fresh.kind).toBe("disk");

    // A blob uploaded before keeps its row in the store it was recorded in,
    // now detached, and no row in the new one.
    expect(await copies(hashes.first)).toEqual([
      expect.objectContaining({ store_id: original.id, detached: true }),
    ]);

    // Its copy stops counting: the checks leave it alone and replication
    // does not count it missing from the new store.
    const replication = await runJob(operator, "blob-replicate");
    expect(replication.result).toMatchObject({ copied: 0, remaining: 0 });
    const integrity = await runJob(operator, "blob-integrity");
    expect(integrity.result).toMatchObject({ verified: 0, struck: 0 });
    expect((await copies(hashes.second))[0]).toMatchObject({
      store_id: original.id,
      detached: true,
      verified_at: lastChecked,
    });

    // The same bytes sent again are held by the new store, beside the
    // detached copy, which does not count toward the minimum a drop keeps.
    const again = await working.uploadBlob(content.first, "text/plain");
    expect(again.status).toBe(201);
    const rows = await copies(hashes.first);
    expect(rows.map((row) => [row.store_id, row.detached])).toEqual([
      [original.id, true],
      [fresh.id, false],
    ]);
    const checked = await runJob(operator, "blob-integrity");
    expect(checked.result).toMatchObject({ verified: 1, struck: 0 });

    const detachedDrop = await operator.deleteBlobCopy(
      hashes.first,
      original.id,
    );
    expect(detachedDrop.status).toBe(404);
    expect(detachedDrop.error?.error.code).toBe("blob_copy_not_found");
    const notHeld = await operator.deleteBlobCopy(hashes.second, fresh.id);
    expect(notHeld.status).toBe(404);
    expect(notHeld.error?.error.code).toBe("blob_copy_not_found");
    const refused = await operator.deleteBlobCopy(hashes.first, fresh.id);
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("copies_below_minimum");
    expect(refused.error?.error.details).toMatchObject({
      live: 1,
      min_copies: 1,
    });
    expect((await copies(hashes.first)).map((row) => row.store_id)).toEqual([
      original.id,
      fresh.id,
    ]);
    expect(existsSync(pathIn(other, hashes.first))).toBe(true);

    // Back on the first folder without its marker: the store recorded there
    // is detached and claims nothing, so the folder is a fresh store.
    await server!.restart(() => {
      rmSync(join(folder, ".marfa-store"));
    });
    ({ operator, working } = clientsFor(server!));
    const back = (await operator.listBlobStores()).data.data;
    const attached = back.filter((store) => store.detached_at === null);
    expect(attached).toHaveLength(1);
    expect([original.id, fresh.id]).not.toContain(attached[0]!.id);
    expect(attached[0]!.kind).toBe("disk");
  });
});

describe("a store whose folder is away", () => {
  const away = () => `${blobFolder(server!)}.away`;

  it("strikes nothing, answers 503 for the blob while no store can, and serves it again when the folder returns", async () => {
    const bytes = bytesOf("on a drive that goes away", 120);
    const uploaded = await working.uploadBlob(bytes, "text/plain");
    expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(201);
    const hash = uploaded.data.hash;

    // The witness: with the folder there, the copy is checked and the blob
    // is served, so what follows is about the folder.
    const sound = await runJob(operator, "blob-integrity");
    expect(sound.result).toMatchObject({ struck: 0, unreachable: 0 });
    expect(sound.result.verified).toBeGreaterThanOrEqual(1);
    expect((await operator.downloadBlob(hash)).status).toBe(200);
    const recorded = await copies(hash);
    expect(recorded).toHaveLength(1);

    renameSync(blobFolder(server!), away());
    const gone = await runJob(operator, "blob-integrity");
    expect(gone.result).toEqual({
      verified: 0,
      struck: 0,
      bytes: 0,
      unreachable: 1,
    });
    expect(await copies(hash)).toEqual(recorded);
    const refused = await operator.downloadBlob(hash);
    expect(refused.status).toBe(503);
    expect(refused.error?.error.code).toBe("blob_store_unavailable");
    const audited = await working.listAudit({
      action: "blob.copy_struck",
      resource_id: hash,
    });
    expect(audited.data.data).toEqual([]);

    renameSync(away(), blobFolder(server!));
    const back = await operator.downloadBlob(hash);
    expect(back.status).toBe(200);
    expect(
      Buffer.from(back.data as ArrayBuffer).equals(Buffer.from(bytes)),
    ).toBe(true);
    const again = await runJob(operator, "blob-integrity");
    expect(again.result).toMatchObject({ struck: 0, unreachable: 0 });
    expect((await copies(hash))[0]!.verified_at).not.toBeNull();
  });

  it("strikes nothing while an empty folder stands where the store was, as a mount point does without its drive", async () => {
    const bytes = bytesOf("on a drive that did not mount", 130);
    const uploaded = await working.uploadBlob(bytes, "text/plain");
    expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(201);
    const hash = uploaded.data.hash;

    renameSync(blobFolder(server!), away());
    mkdirSync(blobFolder(server!));
    const empty = await runJob(operator, "blob-integrity");
    expect(empty.result).toMatchObject({ struck: 0, unreachable: 1 });
    expect(await copies(hash)).toHaveLength(1);
    expect((await operator.downloadBlob(hash)).status).toBe(503);

    rmSync(blobFolder(server!), { recursive: true });
    renameSync(away(), blobFolder(server!));
    expect((await operator.downloadBlob(hash)).status).toBe(200);
  });

  it("still strikes a copy missing from a folder that is there", async () => {
    const uploaded = await working.uploadBlob(
      bytesOf("removed from a folder that is present", 140),
      "text/plain",
    );
    expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(201);
    const hash = uploaded.data.hash;

    unlinkSync(diskPath(server!, hash));
    const run = await runJob(operator, "blob-integrity");
    expect(run.result).toMatchObject({ struck: 1, unreachable: 0 });
    expect(await copies(hash)).toEqual([]);
  });
});

describe("a store whose folder is missing at start", () => {
  it(
    "refuses to start while the folder or its marker is missing and the copy record names copies there, and creates neither",
    async () => {
      const uploaded = await working.uploadBlob(
        bytesOf("saved before the drive went away", 120),
        "text/plain",
      );
      expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(201);
      const hash = uploaded.data.hash;
      const [copy] = await copies(hash);
      const folder = blobFolder(server!);
      const away = `${folder}.away`;
      const database = join(
        mkdtempSync(join(tmpdir(), "blob-folder-missing-")),
        "marfa.db",
      );
      const refusals: RefusedBoot[] = [];
      /** Boots on a copy of the stopped server's database and its folder. */
      const refusedStart = async (): Promise<RefusedBoot> => {
        const refused = await bootRefused("blob-folder-missing", {
          prepare: (sqlitePath) => copyFileSync(database, sqlitePath),
          extraEnv: { ...DISK_ONLY, BLOB_PATH: folder },
        });
        refusals.push(refused);
        return refused;
      };
      try {
        await server!.restart(async () => {
          copyFileSync(server!.sqlitePath, database);
          renameSync(folder, away);

          const missing = await refusedStart();
          expect(missing.code).toBe(1);
          expect(missing.output).toContain(folder);
          expect(missing.output).toContain("Mount or restore it");
          expect(existsSync(folder)).toBe(false);

          // A mount point left empty by a drive that did not mount.
          mkdirSync(folder);
          const unmarked = await refusedStart();
          expect(unmarked.code).toBe(1);
          expect(unmarked.output).toContain(folder);
          expect(readdirSync(folder)).toEqual([]);

          rmSync(folder, { recursive: true });
          renameSync(away, folder);
        });
      } finally {
        for (const refused of refusals) await refused.stop();
        rmSync(join(database, ".."), { recursive: true, force: true });
      }

      // The witness: with the folder back, the same store serves the blob.
      ({ operator, working } = clientsFor(server!));
      const stores = (await operator.listBlobStores()).data.data;
      expect(
        stores
          .filter((store) => store.detached_at === null)
          .map((store) => store.id),
      ).toEqual([copy!.store_id]);
      expect((await operator.downloadBlob(hash)).status).toBe(200);
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );
});
