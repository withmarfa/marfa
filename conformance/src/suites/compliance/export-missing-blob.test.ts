import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  bytesOf,
  clientsFor,
  DISK_ONLY,
  ownObjectStore,
  runJob,
} from "../../utils/own-blob-server.js";
import {
  type ArchiveFileLine,
  blobHash,
  carriedFiles,
  itemsArchive,
  archiveManifest,
  listEntries,
  notCarried,
} from "../../utils/archive.js";
import {
  damageBlobs,
  loseBlobs,
  unreadBlobs,
} from "../../utils/store-faults.js";

/**
 * What an archive export does with a blob it should carry and cannot read,
 * and what a restore answers of an archive that lacks a blob it names.
 *
 * **Why a server of its own.** A blob's file is removed from, or altered on,
 * the server's disk, and the archive carries every blob the working key may
 * read. On a server of its own, nothing another file uploads reaches the
 * archive, and no object store holds a second copy unless the fixture
 * attaches one. The tests read in order on the disk-only server: each leaves
 * the blobs the next archive names.
 */

interface Manifest {
  blob_count: number;
}

async function upload(client: MarfaClient, bytes: Uint8Array) {
  const res = await client.uploadBlob(bytes, "text/plain");
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.data.hash;
}

async function noteNaming(client: MarfaClient, hash: string) {
  const res = await client.createItem({
    type: "core.note",
    properties: { body: `![bytes](${hash})` },
  });
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.data.item.id;
}

async function archiveOf(client: MarfaClient) {
  const res = await client.exportArchive();
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  const archive = res.data;
  const manifest = archiveManifest<Manifest>(archive);
  const entries = listEntries(archive).map((entry) => entry.name);
  return {
    archive,
    manifest,
    entries,
    carried: carriedFiles(archive),
    missing: notCarried(archive),
  };
}

function ownerOf(server: FreshServer): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: "",
    controlSocket: server.controlSocket,
  });
}

describe("an archive export on an instance with one disk store", () => {
  let server: FreshServer | undefined;
  let operator: MarfaClient;
  let working: MarfaClient;
  const lostBytes = bytesOf("a blob whose file leaves the disk", 120);
  let lost: string;

  beforeAll(async () => {
    server = await bootFreshServer("export-missing-blob", DISK_ONLY);
    ({ operator, working } = clientsFor(server));
  }, FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
  }, FRESH_SERVER_TIMEOUT_MS);

  it("names a blob whose file has left the disk as not carried, and carries the rest", async () => {
    const keptBytes = bytesOf("a blob that stays on the disk", 110);
    const kept = await upload(working, keptBytes);
    lost = await upload(working, lostBytes);
    await noteNaming(working, kept);
    await noteNaming(working, lost);

    // The witness: both are carried while both files are there.
    const before = await archiveOf(working);
    expect(Object.keys(before.carried).sort()).toEqual([kept, lost].sort());
    expect(before.missing).toEqual({});
    expect(before.entries).toContain(`blobs/${lost}`);

    await loseBlobs(server!, [lost]);
    const { manifest, entries, carried, missing } = await archiveOf(working);
    expect(manifest.blob_count).toBe(1);
    expect(carried).toEqual({
      [kept]: { mime_type: "text/plain", size_bytes: keptBytes.length },
    });
    expect(missing).toEqual({
      [lost]: { mime_type: "text/plain", size_bytes: lostBytes.length },
    });
    expect(entries).toContain(`blobs/${kept}`);
    expect(entries).not.toContain(`blobs/${lost}`);
  });

  it("names a blob whose struck copy is the only one as not carried, and answers a whole archive", async () => {
    const content = bytesOf("a blob altered and then struck", 130);
    const hash = await upload(working, content);
    await noteNaming(working, hash);
    // The same length, so only the digest can tell.
    await damageBlobs(server!, [hash]);
    const struck = await runJob(operator, "blob-integrity");
    expect(struck.result.struck).toBeGreaterThanOrEqual(1);
    expect((await operator.listBlobCopies(hash)).data.data).toEqual([]);

    const { entries, carried, missing } = await archiveOf(working);
    expect(Object.keys(missing)).toContain(hash);
    expect(Object.keys(carried)).not.toContain(hash);
    expect(entries).not.toContain(`blobs/${hash}`);
  });

  it("ends the response with an error when a copy's bytes do not hash to the blob's name, and strikes the copy", async () => {
    const content = bytesOf("a blob whose bytes rot in place", 140);
    const hash = await upload(working, content);
    await noteNaming(working, hash);
    const read = () =>
      fetch(`${server!.apiUrl}/export?format=archive`, {
        headers: { Authorization: `Bearer ${server!.workingKey}` },
      });

    // The witness: the same export reads whole while the bytes are sound.
    const sound = await read();
    expect(sound.status).toBe(200);
    expect((await sound.arrayBuffer()).byteLength).toBeGreaterThan(0);

    await damageBlobs(server!, [hash]);
    const res = await read();
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();

    // Struck as the integrity check would strike it, so the next export,
    // with no other store to read, names it instead of cutting again.
    expect((await operator.listBlobCopies(hash)).data.data).toEqual([]);
    const { missing } = await archiveOf(working);
    expect(Object.keys(missing)).toContain(hash);
  });

  it("answers 503 blob_store_unavailable to an export and a restore when the disk cannot be read for a blob", async () => {
    const owner = ownerOf(server!);
    const content = bytesOf("a blob behind a folder that cannot be read", 150);
    const hash = await upload(working, content);
    await noteNaming(working, hash);
    const id = uuidv7();
    // An archive that names the blob and does not carry it, so the restore
    // asks the disk whether the instance holds it.
    const lacking = itemsArchive(
      [
        {
          id,
          type: "core.note",
          source: "export-missing-blob",
          properties: { body: `![bytes](${hash})` },
        },
      ],
      [],
      [],
      undefined,
      [],
      [
        {
          hash,
          mime_type: "text/plain",
          size_bytes: 150,
          state: "carried",
        },
      ],
    );

    await unreadBlobs(server!, [hash]);
    try {
      const res = await fetch(`${server!.apiUrl}/export?format=archive`, {
        headers: { Authorization: `Bearer ${server!.workingKey}` },
      });
      expect(res.status).toBe(503);
      expect(
        ((await res.json()) as { error: { code: string } }).error.code,
      ).toBe("blob_store_unavailable");

      const restored = await owner.restoreArchive(lacking);
      expect(restored.status).toBe(503);
      expect(restored.error?.error.code).toBe("blob_store_unavailable");
      expect((await working.getItem(id)).status).toBe(404);
    } finally {
      await server!.clearFault("damage:blob-unreadable");
    }

    // The same archive restores once the disk answers, and the blob is held.
    const again = await owner.restoreArchive(lacking);
    expect(again.status, JSON.stringify(again.error)).toBe(200);
    expect(again.data.blobs_missing).toEqual([]);
  });

  it("names as not carried in a later archive a file's blob that a restore answered missing", async () => {
    const owner = ownerOf(server!);
    const absent = blobHash(new Uint8Array(randomBytes(64)));
    // A run of hex in a note's text that no upload made, which is no blob.
    const noted = blobHash(new Uint8Array(randomBytes(64)));
    const file = uuidv7();
    const note = uuidv7();
    const restored = await owner.restoreArchive(
      itemsArchive(
        [
          {
            id: file,
            type: "core.file",
            source: "export-missing-blob",
            properties: { blob_ref: absent, mime_type: "image/png" },
          },
          {
            id: note,
            type: "core.note",
            source: "export-missing-blob",
            properties: { body: `checksum ${noted.slice("sha256:".length)}` },
          },
        ],
        [],
        [],
        undefined,
        [],
        [
          {
            hash: absent,
            mime_type: "image/png",
            size_bytes: 64,
            state: "carried",
          },
        ],
      ),
    );
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.blobs_missing).toEqual([absent]);

    const res = await working.exportArchive();
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    const missing = notCarried(res.data);
    expect(missing[absent]).toEqual({
      mime_type: null,
      size_bytes: null,
    });
    expect(Object.keys(missing)).not.toContain(noted);
    expect(Object.keys(carriedFiles(res.data))).not.toContain(absent);

    // The archive that names it with no type or size restores as well.
    const again = await owner.restoreArchive(res.data);
    expect(again.status, JSON.stringify(again.error)).toBe(200);
    expect(again.data.blobs_missing).toContain(absent);
  });

  it("answers in blobs_missing a blob the archive names and lacks, and none the instance holds", async () => {
    const owner = ownerOf(server!);
    const { archive, missing } = await archiveOf(working);
    const named = Object.keys(missing).sort();
    expect(named).toContain(lost);

    const restored = await owner.restoreArchive(archive);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.blobs_missing).toEqual(named);

    // Once the bytes are uploaded again the instance holds them, and the
    // same archive no longer answers them as missing.
    expect((await working.downloadBlob(lost)).status).toBe(404);
    expect(await upload(working, lostBytes)).toBe(lost);
    const again = await owner.restoreArchive(archive);
    expect(again.status, JSON.stringify(again.error)).toBe(200);
    expect(again.data.blobs_missing).toEqual(
      named.filter((hash) => hash !== lost),
    );
  });

  it("answers in blobs_missing a blob the archive lists as carried and carries no bytes for", async () => {
    const owner = ownerOf(server!);
    const carried = new Uint8Array(randomBytes(48));
    const absent = blobHash(new Uint8Array(randomBytes(48)));
    const archive = (extra: ArchiveFileLine[]) =>
      itemsArchive(
        [],
        [{ data: carried, mime_type: "text/plain" }],
        [],
        undefined,
        [],
        extra,
      );

    // The witness: the same archive without the extra name answers none.
    const whole = await owner.restoreArchive(archive([]));
    expect(whole.status, JSON.stringify(whole.error)).toBe(200);
    expect(whole.data.blobs_missing).toEqual([]);

    const lacking = await owner.restoreArchive(
      archive([
        {
          hash: absent,
          mime_type: "text/plain",
          size_bytes: 48,
          state: "carried",
        },
      ]),
    );
    expect(lacking.status, JSON.stringify(lacking.error)).toBe(200);
    expect(lacking.data).toMatchObject({
      blobs_imported: 1,
      blobs_missing: [absent],
    });
  });

  /** Exports with `fault` set, which cuts the response, and answers that the
   *  archive after it lists the blobs the archive before it did. */
  async function cutBy(fault: string, label: string) {
    const hash = await upload(working, bytesOf(label, 120));
    await noteNaming(working, hash);
    // The witness: the archive before the fault, carrying the blob.
    const before = await archiveOf(working);
    expect(Object.keys(before.carried)).toContain(hash);

    await server!.setFault(`${fault}=1`);
    try {
      const res = await fetch(`${server!.apiUrl}/export?format=archive`, {
        headers: { authorization: `Bearer ${server!.workingKey}` },
      });
      expect(res.status).toBe(200);
      await expect(res.arrayBuffer()).rejects.toThrow();
      expect(
        (await server!.faults()).find((f) => f.name === fault)?.fired,
      ).toBe(1);
    } finally {
      await server!.clearFault();
    }

    const after = await archiveOf(working);
    expect(Object.keys(after.carried).sort()).toEqual(
      Object.keys(before.carried).sort(),
    );
    expect(after.missing).toEqual(before.missing);
  }

  it("strikes no copy when a read of a blob's bytes fails", async () => {
    await cutBy("fail:blob-read", "a blob whose read fails once");
  });

  it("strikes no copy when a read of a blob's bytes ends short", async () => {
    await cutBy("fail:blob-read-short", "a blob whose read ends short once");
  });

  it("ends the response with an error when a listed blob's file goes before its entry is written", async () => {
    // Incompressible bytes ahead of the blob in the archive, so the export
    // cannot reach its entry while the response is not read.
    const ahead: string[] = [];
    for (let i = 0; i < 4; i++) {
      ahead.push(await upload(working, new Uint8Array(randomBytes(8 << 20))));
    }
    let last = "";
    for (;;) {
      last = await upload(
        working,
        bytesOf("a blob whose file goes during the export", 140),
      );
      if (ahead.every((hash) => hash < last)) break;
    }
    for (const hash of [...ahead, last]) await noteNaming(working, hash);

    // The witness: the same export ends cleanly and carries the blob while
    // its file is there.
    const whole = await archiveOf(working);
    expect(whole.entries).toContain(`blobs/${last}`);

    // The export waits at its first read of a blob's bytes, with the
    // manifest already written, while the last blob's file goes.
    await server!.setFault("hold:blob-read");
    const sent = fetch(`${server!.apiUrl}/export?format=archive`, {
      headers: { Authorization: `Bearer ${server!.workingKey}` },
    });
    await server!.waitForHold("hold:blob-read");
    await loseBlobs(server!, [last]);
    await server!.clearFault("hold:blob-read");
    const res = await sent;
    expect(res.status).toBe(200);
    await res.arrayBuffer().then(
      () => {
        throw new Error("the archive ended without the blob it listed");
      },
      () => undefined,
    );
  });
});

describe("an archive export on an instance with an object store", () => {
  let server: FreshServer | undefined;
  let operator: MarfaClient;
  let working: MarfaClient;

  beforeAll(async () => {
    server = await bootFreshServer("export-missing-blob-store", {
      ...ownObjectStore(),
    });
    ({ operator, working } = clientsFor(server));
  }, FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
  }, FRESH_SERVER_TIMEOUT_MS);

  it("carries a blob whose disk file is gone from the object store's copy", async () => {
    const content = bytesOf("a blob the object store also holds", 150);
    const hash = await upload(working, content);
    await noteNaming(working, hash);
    await runJob(operator, "blob-replicate");
    const kinds = (await operator.listBlobCopies(hash)).data.data
      .map((row) => row.kind)
      .sort();
    expect(kinds).toEqual(["disk", "s3"]);

    await loseBlobs(server!, [hash]);
    const { archive, carried, missing } = await archiveOf(working);
    expect(missing).toEqual({});
    expect(Object.keys(carried)).toEqual([hash]);
    const entry = listEntries(archive).find((e) => e.name === `blobs/${hash}`);
    expect(entry).toBeDefined();
    expect(blobHash(entry!.body)).toBe(hash);
  });

  it("restores an archive lacking a blob that the object store holds whole while the disk cannot be read for it", async () => {
    const owner = ownerOf(server!);
    const content = bytesOf("a blob the disk cannot answer for", 160);
    const hash = await upload(working, content);
    await noteNaming(working, hash);
    await runJob(operator, "blob-replicate");
    const kinds = (await operator.listBlobCopies(hash)).data.data
      .map((row) => row.kind)
      .sort();
    expect(kinds).toEqual(["disk", "s3"]);
    const id = uuidv7();
    const lacking = itemsArchive(
      [
        {
          id,
          type: "core.note",
          source: "export-missing-blob",
          properties: { body: `![bytes](${hash})` },
        },
      ],
      [],
      [],
      undefined,
      [],
      [
        {
          hash,
          mime_type: "text/plain",
          size_bytes: content.length,
          state: "carried",
        },
      ],
    );

    // The disk cannot be read for the blob; the object store answers for it.
    await unreadBlobs(server!, [hash]);
    try {
      const restored = await owner.restoreArchive(lacking);
      expect(restored.status, JSON.stringify(restored.error)).toBe(200);
      expect(restored.data.blobs_missing).toEqual([]);
      expect((await working.getItem(id)).status).toBe(200);
    } finally {
      await server!.clearFault("damage:blob-unreadable");
    }
  });
});
