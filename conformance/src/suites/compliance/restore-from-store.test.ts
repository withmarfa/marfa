import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import { archiveManifest, itemsArchive } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  bytesOf,
  clientsFor,
  ownObjectStore,
  runJob,
} from "../../utils/own-blob-server.js";
import { TEST_OWNER } from "../../utils/target.js";

/**
 * A restore of an archive that names a file it does not carry, such as one
 * exported with `files=false`, into a fresh server started on the bucket the
 * origin kept its files in. The fresh server takes the bucket's store id from
 * its marker, so the restore finds each file's bytes under its name there,
 * checks them, and records them as the store's copy. `hold:blob-has` makes
 * the object store hang while the restore looks, and `store-check-deadline`
 * shortens how long the server waits for it.
 */
let origin: FreshServer;
let fresh: FreshServer;
const store = ownObjectStore();

beforeAll(async () => {
  origin = await bootFreshServer("restore-from-store-origin", store);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await fresh?.stop();
  await origin?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

function ownerOf(server: FreshServer): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    ownerCookie: server.ownerCookie,
    ownerCredentials: TEST_OWNER,
    ownerSessionFile: `${server.stateDir}/owner-session.json`,
  });
}

/** A file on the origin whose bytes the object store holds. */
async function fileInTheBucket(words: string) {
  const { operator, working } = clientsFor(origin);
  const bytes = bytesOf(words, 4096);
  const uploaded = await working.uploadBlob(bytes, "text/plain");
  expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(201);
  const item = await working.createItem({
    type: "core.file",
    properties: { blob_ref: uploaded.data.hash, mime_type: "text/plain" },
  });
  expect(item.status, JSON.stringify(item.error)).toBe(201);
  for (let run = 0; run < 20; run++) {
    const { result } = await runJob<{ remaining: number }>(
      operator,
      "blob-replicate",
    );
    if (result.remaining === 0) break;
  }
  const copies = await operator.listBlobCopies(uploaded.data.hash);
  expect(copies.data.data.map((copy) => copy.kind).sort()).toEqual([
    "disk",
    "s3",
  ]);
  return { bytes, hash: uploaded.data.hash, id: item.data.item.id };
}

describe("a restore of files the archive names and does not carry", () => {
  it("takes each file from the object store it was kept in, checked against its name, and records the copy", async () => {
    const one = await fileInTheBucket("kept in the bucket");
    const archive = await ownerOf(origin).exportArchive({ files: "false" });
    expect(archive.status).toBe(200);
    const manifest = archiveManifest<{
      blobs: Record<string, unknown>;
      missing_blobs: Record<string, unknown>;
    }>(archive.data);
    expect(Object.keys(manifest.missing_blobs)).toContain(one.hash);
    expect(manifest.blobs).toEqual({});

    fresh = await bootFreshServer("restore-from-store-fresh", store);
    const owner = ownerOf(fresh);
    const { operator, working } = clientsFor(fresh);

    // The witness: while the object store hangs, the restore cannot tell
    // whether the file is there, and writes nothing.
    await fresh.setFault("store-check-deadline=200");
    await fresh.setFault("hold:blob-has");
    const refused = await owner.restoreArchive(archive.data);
    expect(refused.status, JSON.stringify(refused.error)).toBe(503);
    expect(refused.error?.error.code).toBe("blob_store_unavailable");
    expect((await working.getItem(one.id)).status).toBe(404);
    expect((await operator.downloadBlob(one.hash)).status).toBe(404);
    await fresh.clearFault();

    const restored = await owner.restoreArchive(archive.data);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.blobs_missing).toEqual([]);
    expect(restored.data.blobs_imported).toBe(0);
    const read = await operator.downloadBlob(one.hash);
    expect(read.status).toBe(200);
    expect(new Uint8Array(read.data)).toEqual(one.bytes);
    const copies = await operator.listBlobCopies(one.hash);
    expect(copies.data.data.map((copy) => copy.kind)).toContain("s3");
  });

  it("answers in blobs_missing a file the object store does not hold", async () => {
    const id = uuidv7();
    const absent = `sha256:${"ab".repeat(32)}`;
    const archive = itemsArchive(
      [
        {
          id,
          type: "core.file",
          source: "restore-from-store",
          properties: { blob_ref: absent, mime_type: "text/plain" },
        },
      ],
      [],
      [],
      (manifest) => ({
        ...manifest,
        missing_blobs: { [absent]: { mime_type: null, size_bytes: null } },
      }),
    );
    const restored = await ownerOf(fresh).restoreArchive(archive);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.blobs_missing).toEqual([absent]);
    expect(restored.data.imported).toBe(1);
  });

  it("answers nothing in blobs_missing on an instance that holds every file the archive names", async () => {
    const held = await fileInTheBucket("held by the instance that exported it");
    const archive = await ownerOf(origin).exportArchive({ files: "false" });
    expect(archive.status).toBe(200);
    const manifest = archiveManifest<{
      missing_blobs: Record<string, unknown>;
    }>(archive.data);
    // The witness: the archive names the file and carries none of its bytes.
    expect(Object.keys(manifest.missing_blobs)).toContain(held.hash);

    const restored = await ownerOf(origin).restoreArchive(archive.data);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.blobs_missing).toEqual([]);
    expect(restored.data.blobs_imported).toBe(0);
  });
});
