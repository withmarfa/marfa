import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
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
  diskPath,
  DISK_ONLY,
  ownObjectStore,
  runJob,
} from "../../utils/own-blob-server.js";
import {
  blobHash,
  itemsArchive,
  listTarGzEntries,
  readTarGzEntry,
} from "../../utils/archive.js";
import { TEST_OWNER } from "../../utils/target.js";

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
  blobs: Record<string, { mime_type: string; size_bytes: number }>;
  missing_blobs: Record<
    string,
    { mime_type: string | null; size_bytes: number | null }
  >;
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
  const manifest = JSON.parse(
    readTarGzEntry(archive, "manifest.json") ?? "{}",
  ) as Manifest;
  const entries = listTarGzEntries(archive).map((entry) => entry.name);
  return { archive, manifest, entries };
}

function ownerOf(server: FreshServer): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: "",
    ownerCookie: server.ownerCookie,
    ownerCredentials: TEST_OWNER,
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

  it("names a blob whose file has left the disk under missing_blobs, and carries the rest", async () => {
    const keptBytes = bytesOf("a blob that stays on the disk", 110);
    const kept = await upload(working, keptBytes);
    lost = await upload(working, lostBytes);
    await noteNaming(working, kept);
    await noteNaming(working, lost);

    // The witness: both are carried while both files are there.
    const before = await archiveOf(working);
    expect(Object.keys(before.manifest.blobs).sort()).toEqual(
      [kept, lost].sort(),
    );
    expect(before.manifest.missing_blobs).toEqual({});
    expect(before.entries).toContain(`blobs/${lost}`);

    unlinkSync(diskPath(server!, lost));
    const { manifest, entries } = await archiveOf(working);
    expect(manifest.blob_count).toBe(1);
    expect(manifest.blobs).toEqual({
      [kept]: { mime_type: "text/plain", size_bytes: keptBytes.length },
    });
    expect(manifest.missing_blobs).toEqual({
      [lost]: { mime_type: "text/plain", size_bytes: lostBytes.length },
    });
    expect(entries).toContain(`blobs/${kept}`);
    expect(entries).not.toContain(`blobs/${lost}`);
  });

  it("names a blob whose struck copy is the only one under missing_blobs, and answers a whole archive", async () => {
    const content = bytesOf("a blob altered and then struck", 130);
    const hash = await upload(working, content);
    await noteNaming(working, hash);
    // The same length, so only the digest can tell.
    writeFileSync(
      diskPath(server!, hash),
      new Uint8Array(content.length).fill(0x41),
    );
    const struck = await runJob(operator, "blob-integrity");
    expect(struck.result.struck).toBeGreaterThanOrEqual(1);
    expect((await operator.listBlobLocations(hash)).data.data).toEqual([]);

    const { manifest, entries } = await archiveOf(working);
    expect(Object.keys(manifest.missing_blobs)).toContain(hash);
    expect(Object.keys(manifest.blobs)).not.toContain(hash);
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

    writeFileSync(
      diskPath(server!, hash),
      new Uint8Array(content.length).fill(0x42),
    );
    const res = await read();
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();

    // Struck as the integrity check would strike it, so the next export,
    // with no other store to read, names it instead of cutting again.
    expect((await operator.listBlobLocations(hash)).data.data).toEqual([]);
    const { manifest } = await archiveOf(working);
    expect(Object.keys(manifest.missing_blobs)).toContain(hash);
  });

  it("answers 503 blob_store_unavailable to an export and a restore when the disk cannot be read for a blob", async () => {
    const owner = ownerOf(server!);
    const content = bytesOf("a blob behind a folder that cannot be read", 150);
    const hash = await upload(working, content);
    await noteNaming(working, hash);
    const folder = dirname(diskPath(server!, hash));
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
      (m) => ({
        ...m,
        blobs: { [hash]: { mime_type: "text/plain", size_bytes: 150 } },
      }),
    );

    chmodSync(folder, 0o000);
    try {
      // The witness: the folder really cannot be read by this user.
      expect(() => statSync(diskPath(server!, hash))).toThrow();

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
      chmodSync(folder, 0o755);
    }

    // The same archive restores once the disk answers, and the blob is held.
    const again = await owner.restoreArchive(lacking);
    expect(again.status, JSON.stringify(again.error)).toBe(200);
    expect(again.data.blobs_missing).toEqual([]);
  });

  it("names in a later archive's missing_blobs a file's blob that a restore answered missing", async () => {
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
        (m) => ({
          ...m,
          blobs: { [absent]: { mime_type: "image/png", size_bytes: 64 } },
        }),
      ),
    );
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.blobs_missing).toEqual([absent]);

    const res = await owner.exportArchive();
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    const manifest = JSON.parse(
      readTarGzEntry(res.data, "manifest.json") ?? "{}",
    ) as Manifest;
    expect(manifest.missing_blobs[absent]).toEqual({
      mime_type: null,
      size_bytes: null,
    });
    expect(Object.keys(manifest.missing_blobs)).not.toContain(noted);
    expect(Object.keys(manifest.blobs)).not.toContain(absent);

    // The archive that names it with no type or size restores as well.
    const again = await owner.restoreArchive(res.data);
    expect(again.status, JSON.stringify(again.error)).toBe(200);
    expect(again.data.blobs_missing).toContain(absent);
  });

  it("answers in blobs_missing a blob the archive names and lacks, and none the instance holds", async () => {
    const owner = ownerOf(server!);
    const { archive, manifest } = await archiveOf(working);
    const named = Object.keys(manifest.missing_blobs).sort();
    expect(named).toContain(lost);

    const restored = await owner.restoreArchive(archive);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data.blobs_missing).toEqual(named);

    // Once the bytes are uploaded again the instance holds them, and the
    // same archive no longer answers them as missing.
    expect(existsSync(diskPath(server!, lost))).toBe(false);
    expect(await upload(working, lostBytes)).toBe(lost);
    const again = await owner.restoreArchive(archive);
    expect(again.status, JSON.stringify(again.error)).toBe(200);
    expect(again.data.blobs_missing).toEqual(
      named.filter((hash) => hash !== lost),
    );
  });

  it("answers in blobs_missing a blob the manifest lists that the archive carries no bytes for", async () => {
    const owner = ownerOf(server!);
    const carried = new Uint8Array(randomBytes(48));
    const absent = blobHash(new Uint8Array(randomBytes(48)));
    const archive = (extra: Record<string, unknown>) =>
      itemsArchive(
        [],
        [{ data: carried, mime_type: "text/plain" }],
        [],
        (m) => ({
          ...m,
          blobs: { ...(m.blobs as Record<string, unknown>), ...extra },
        }),
      );

    // The witness: the same archive without the extra name answers none.
    const whole = await owner.restoreArchive(archive({}));
    expect(whole.status, JSON.stringify(whole.error)).toBe(200);
    expect(whole.data.blobs_missing).toEqual([]);

    const lacking = await owner.restoreArchive(
      archive({ [absent]: { mime_type: "text/plain", size_bytes: 48 } }),
    );
    expect(lacking.status, JSON.stringify(lacking.error)).toBe(200);
    expect(lacking.data).toMatchObject({
      blobs_imported: 1,
      blobs_missing: [absent],
    });
  });

  it("strikes no copy when a read of a blob's bytes fails", async () => {
    const owner = ownerOf(server!);
    const hash = await upload(
      working,
      bytesOf("a blob whose read fails once", 120),
    );
    await noteNaming(working, hash);
    // The witness: the archive before the fault, carrying the blob.
    const before = await archiveOf(owner);
    expect(Object.keys(before.manifest.blobs)).toContain(hash);

    await server!.setFault("fail:blob-read=1");
    try {
      const res = await fetch(`${server!.apiUrl}/export?format=archive`, {
        headers: { cookie: server!.ownerCookie },
      });
      expect(res.status).toBe(200);
      await expect(res.arrayBuffer()).rejects.toThrow();
      expect(
        (await server!.faults()).find((f) => f.name === "fail:blob-read")
          ?.fired,
      ).toBe(1);
    } finally {
      await server!.clearFault();
    }

    const after = await archiveOf(owner);
    expect(Object.keys(after.manifest.blobs).sort()).toEqual(
      Object.keys(before.manifest.blobs).sort(),
    );
    expect(after.manifest.missing_blobs).toEqual(before.manifest.missing_blobs);
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

    const res = await fetch(`${server!.apiUrl}/export?format=archive`, {
      headers: { Authorization: `Bearer ${server!.workingKey}` },
    });
    expect(res.status).toBe(200);
    unlinkSync(diskPath(server!, last));
    await expect(res.arrayBuffer()).rejects.toThrow();
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
    const kinds = (await operator.listBlobLocations(hash)).data.data
      .map((row) => row.kind)
      .sort();
    expect(kinds).toEqual(["disk", "s3"]);

    unlinkSync(diskPath(server!, hash));
    const { archive, manifest } = await archiveOf(working);
    expect(manifest.missing_blobs).toEqual({});
    expect(Object.keys(manifest.blobs)).toEqual([hash]);
    const entry = listTarGzEntries(archive).find(
      (e) => e.name === `blobs/${hash}`,
    );
    expect(entry).toBeDefined();
    expect(blobHash(entry!.body)).toBe(hash);
  });
});
