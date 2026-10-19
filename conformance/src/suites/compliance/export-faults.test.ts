import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { listTarGzEntries } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  blobFolder,
  clientsFor,
  DISK_ONLY,
} from "../../utils/own-blob-server.js";
import { waitFor } from "../../utils/wait.js";

/**
 * What an archive export does when a read fails while it answers, on a server
 * of the fixture's own: a page of items it cannot read, which fails it before
 * it has sent a byte, and a blob it cannot read, which fails it with the body
 * under way. The reads are failed through the target interface's `fail`
 * faults (`conformance/README.md`, "Faults").
 *
 * The archive carries two blobs of bytes that cannot be compressed, so a
 * complete read is the witness that the archive is whole when nothing fails.
 * The server attaches only its disk: a blob whose read fails before its bytes
 * begin is read from another store that holds it, where there is one
 * (`search-and-filters/archive-blob-any-store`).
 */
const BLOB_BYTES = 1024 * 1024;
const ITEMS = 60;

let server: FreshServer;
let working: MarfaClient;
const hashes: string[] = [];

beforeAll(async () => {
  // On the disk store alone: with a second store, replication reads and
  // writes blob bytes in the background and can take a blob fault armed for
  // the request under test.
  server = await bootFreshServer("export-faults", DISK_ONLY);
  ({ working } = clientsFor(server));
  for (let blob = 0; blob < 2; blob++) {
    const upload = await working.uploadBlob(
      new Uint8Array(randomBytes(BLOB_BYTES)),
      "application/octet-stream",
    );
    expect(upload.status, JSON.stringify(upload.error)).toBe(201);
    hashes.push(upload.data.hash);
  }
  // Sixty notes are three pages of the export's read, so a page after the
  // first exists to fail; two of them name the blobs.
  const created = await working.bulkItems(
    Array.from({ length: ITEMS }, (_, at) => ({
      type: "core.note",
      properties: {
        body: at < 2 ? `![bytes](${hashes[at]!})` : `note ${String(at)}`,
      },
    })),
  );
  expect(created.status, JSON.stringify(created.error)).toBe(200);
}, FRESH_SERVER_TIMEOUT_MS);

afterEach(async () => {
  await server.clearFault();
});

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

/** What the export holds in the spool under the disk store. */
function spooled(): string[] {
  const folder = join(blobFolder(server), "tmp");
  return existsSync(folder) ? readdirSync(folder) : [];
}

function exportArchive(): Promise<Response> {
  return fetch(`${server.apiUrl}/export?format=archive`, {
    headers: { Authorization: `Bearer ${server.workingKey}` },
  });
}

async function fired(name: string): Promise<number | undefined> {
  return (await server.faults()).find((fault) => fault.name === name)?.fired;
}

describe("an archive export that reads everything", () => {
  it("answers a whole archive carrying both blobs and leaves nothing in the spool, which is the witness for the cases below", async () => {
    const response = await exportArchive();
    expect(response.status).toBe(200);
    const archive = new Uint8Array(await response.arrayBuffer());
    const names = listTarGzEntries(archive).map((entry) => entry.name);
    for (const hash of hashes) expect(names).toContain(`blobs/${hash}`);
    await waitFor("the spool to empty", () =>
      Promise.resolve(spooled().length === 0 ? true : undefined),
    );
  });
});

describe("an archive export whose read of a page of items fails", () => {
  it("is answered with an error, not an archive, and leaves nothing of the export on disk", async () => {
    // The first page has been read and kept in the spool when the second fails.
    await server.setFault("fail:export-read=2");
    const response = await exportArchive();
    expect(response.status).toBe(500);
    await response.arrayBuffer();
    expect(await fired("fail:export-read")).toBe(1);
    await waitFor("the spool to empty", () =>
      Promise.resolve(spooled().length === 0 ? true : undefined),
    );
  });
});

describe("an archive export whose read of a blob fails after the body has begun", () => {
  it("ends the response with an error, so the archive is cut short and cannot be taken for a whole one, and leaves nothing on disk", async () => {
    // The first blob is read and written into the archive; the second fails.
    await server.setFault("fail:blob-read=2");
    const response = await exportArchive();
    // The status and the headers are sent before the first byte.
    expect(response.status).toBe(200);
    // The connection is cut short, which a clean end of the body would not be:
    // the gzip stream without its end is how the cut shows in the bytes.
    await expect(response.arrayBuffer()).rejects.toThrow();
    expect(await fired("fail:blob-read")).toBe(1);
    await waitFor("the spool to empty", () =>
      Promise.resolve(spooled().length === 0 ? true : undefined),
    );
  });
});
