import { request } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import { blobHash, itemsArchive } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  blobFolder,
  clientsFor,
  diskPath,
} from "../../utils/own-blob-server.js";
import { TEST_OWNER } from "../../utils/target.js";
import { waitFor } from "../../utils/wait.js";

/**
 * What the server does as the room on its volumes shrinks, on a server of the
 * fixture's own: `GET /health` reads the free space of the database's volume
 * and the disk store's, and an upload or a restore is held to the reserve of
 * free space the instance keeps. The fixtures give the server a volume with
 * the room they choose through the target interface's `free` fault
 * (`conformance/README.md`, "Faults"), and fill it as an upload streams by
 * setting the fault again while the body is on its way. A blob store that has
 * no room is made through `fail:blob-write`.
 *
 * The reserve is 1 MiB. The server looks at the volume every half of it while
 * a body streams, so a body of a few MiB is looked at several times.
 */
const MiB = 1024 * 1024;
const RESERVE = MiB;

let server: FreshServer;
let operator: MarfaClient;
let working: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("disk-space-faults", {
    MARFA_DISK_RESERVE_BYTES: String(RESERVE),
  });
  ({ operator, working } = clientsFor(server));
}, FRESH_SERVER_TIMEOUT_MS);

afterEach(async () => {
  await server.clearFault();
});

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

function ownerClient(): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    ownerCookie: server.ownerCookie,
    ownerCredentials: TEST_OWNER,
    ownerSessionFile: `${server.stateDir}/owner-session.json`,
  });
}

/** Gives the server this much room on each volume. */
async function room(options: {
  database: number;
  blobs: number;
}): Promise<void> {
  await server.setFault(`free:database=${String(options.database)}`);
  await server.setFault(`free:blobs=${String(options.blobs)}`);
}

interface Health {
  status: string;
  components: Record<string, { status: string; error?: string }>;
}

async function health(): Promise<{ httpStatus: number; body: Health }> {
  const response = await fetch(`${server.apiUrl}/health`, {
    headers: { Authorization: `Bearer ${server.managementKey}` },
  });
  return {
    httpStatus: response.status,
    body: (await response.json()) as Health,
  };
}

describe("GET /health as the room on the volumes shrinks", () => {
  it("answers the disk component ok with room on both volumes, which is the witness for the cases below", async () => {
    await room({ database: 1024 * MiB, blobs: 1024 * MiB });
    const answer = await health();
    expect(answer.httpStatus).toBe(200);
    expect(answer.body.components.disk?.status).toBe("ok");
    expect(answer.body.status).toBe("ok");
  });

  it("answers the disk component down, and the status 503, when the lesser of the two volumes has under 1 MiB", async () => {
    for (const [database, blobs] of [
      [MiB - 1, 1024 * MiB],
      [1024 * MiB, MiB - 1],
      [0, 0],
      [500 * 1024, 30 * MiB],
      [30 * MiB, 500 * 1024],
    ] as const) {
      await room({ database, blobs });
      const answer = await health();
      const wanted = `database ${String(database)}, blobs ${String(blobs)}`;
      expect(answer.body.components.disk?.status, wanted).toBe("down");
      expect(answer.body.status, wanted).toBe("down");
      expect(answer.httpStatus, wanted).toBe(503);
    }
  });

  it("answers the disk component degraded, and the status 200, when the lesser of the two volumes has 1 MiB or more and under 64 MiB", async () => {
    for (const [database, blobs] of [
      [MiB, 1024 * MiB],
      [1024 * MiB, MiB],
      [64 * MiB - 1, 1024 * MiB],
      [1024 * MiB, 64 * MiB - 1],
      [100 * MiB, 30 * MiB],
      [30 * MiB, 100 * MiB],
    ] as const) {
      await room({ database, blobs });
      const answer = await health();
      const wanted = `database ${String(database)}, blobs ${String(blobs)}`;
      expect(answer.body.components.disk?.status, wanted).toBe("degraded");
      expect(answer.body.status, wanted).toBe("degraded");
      expect(answer.httpStatus, wanted).toBe(200);
    }
    // 64 MiB on both is room enough.
    await room({ database: 64 * MiB, blobs: 64 * MiB });
    expect((await health()).body.components.disk?.status).toBe("ok");
  });
});

/** What an upload with no declared length is answered, sent in the parts the
 *  caller writes. `write` sends a part and resolves once it is on its way. */
async function chunkedUpload(
  send: (write: (part: Uint8Array) => Promise<void>) => Promise<void>,
): Promise<{ status: number; body: string }> {
  const url = new URL(server.apiUrl);
  const req = request({
    host: url.hostname,
    port: url.port,
    method: "POST",
    path: "/blobs",
    headers: {
      Authorization: `Bearer ${server.workingKey}`,
      "Content-Type": "application/octet-stream",
      "Transfer-Encoding": "chunked",
    },
  });
  const answered = new Promise<{ status: number; body: string }>((resolve) => {
    req.on("response", (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (text: string) => (body += text));
      response.on("end", () => resolve({ status: response.statusCode!, body }));
    });
    // The server may end the connection once it has answered; the answer is
    // what this reports, and a connection that fails before one is a test
    // that fails on the missing status.
    req.on("error", () => resolve({ status: 0, body: "" }));
  });
  const write = (part: Uint8Array) =>
    new Promise<void>((resolve) => {
      if (req.destroyed) resolve();
      else req.write(part, () => resolve());
    });
  await send(write);
  req.end();
  return answered;
}

function bytes(size: number, fill: number): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

/** What is in the folder the upload spools into. */
function spooled(): string[] {
  const folder = join(blobFolder(server), "tmp");
  return existsSync(folder) ? readdirSync(folder) : [];
}

describe("an upload whose body declares no length", () => {
  it("is stored while the room holds, which is the witness for the refusal below", async () => {
    await room({ database: 1024 * MiB, blobs: 1024 * MiB });
    const body = new Uint8Array(3 * MiB).fill(7);
    const done = await chunkedUpload(async (write) => {
      for (let sent = 0; sent < body.length; sent += MiB / 2) {
        await write(body.subarray(sent, sent + MiB / 2));
      }
    });
    expect(done.status, done.body).toBe(201);
    expect(existsSync(diskPath(server, blobHash(body)))).toBe(true);
  });

  it("is answered 507 insufficient_storage and leaves nothing when the volume falls inside the reserve as the bytes arrive", async () => {
    await room({ database: 1024 * MiB, blobs: 1024 * MiB });
    const before = readdirSync(blobFolder(server)).sort();
    const refused = await chunkedUpload(async (write) => {
      // Enough to be looked at more than once, with the room there.
      for (let part = 0; part < 4; part++) await write(bytes(MiB / 2, 11));
      // The volume fills while the body is still arriving.
      await server.setFault(`free:blobs=${String(RESERVE - 1)}`);
      for (let part = 0; part < 8; part++) await write(bytes(MiB / 2, 12));
    });
    expect(refused.status, refused.body).toBe(507);
    const error = JSON.parse(refused.body) as {
      error: { code: string; details: Record<string, unknown> };
    };
    expect(error.error.code).toBe("insufficient_storage");
    expect(error.error.details).toMatchObject({
      reserve_bytes: RESERVE,
      available_bytes: RESERVE - 1,
    });

    await waitFor("the spool to empty", () =>
      Promise.resolve(spooled().length === 0 ? true : undefined),
    );
    expect(readdirSync(blobFolder(server)).sort()).toEqual(before);
  });
});

describe("a restore whose archive inflates past the room", () => {
  const entry = bytes(6 * MiB, 21);
  const entryHash = blobHash(entry);
  const itemId = uuidv7();
  const archive = () =>
    itemsArchive(
      [
        {
          id: itemId,
          type: "core.file",
          source: "disk-space-faults",
          properties: {
            blob_ref: entryHash,
            mime_type: "application/octet-stream",
          },
        },
      ],
      [{ data: entry, mime_type: "application/octet-stream" }],
    );

  it("is answered 507 insufficient_storage and writes no row and no blob when an entry would take the volume inside the reserve", async () => {
    const body = archive();
    // Repeated bytes compress to a few KiB; the entry needs 6 MiB, and
    // the volume has 5 MiB.
    expect(body.length).toBeLessThan(64 * 1024);
    await room({ database: 1024 * MiB, blobs: 5 * MiB });
    const refused = await ownerClient().restoreArchive(body);
    expect(refused.status, JSON.stringify(refused.error)).toBe(507);
    expect(refused.error?.error.code).toBe("insufficient_storage");
    expect((await working.getItem(itemId)).status).toBe(404);
    expect((await operator.downloadBlob(entryHash)).status).toBe(404);
    expect(existsSync(diskPath(server, entryHash))).toBe(false);
    await waitFor("the spool to empty", () =>
      Promise.resolve(spooled().length === 0 ? true : undefined),
    );
  });

  it("is taken once the volume has the room, which is the witness for the refusal above", async () => {
    await room({ database: 1024 * MiB, blobs: 1024 * MiB });
    const done = await ownerClient().restoreArchive(archive());
    expect(done.status, JSON.stringify(done.error)).toBe(200);
    expect((await working.getItem(itemId)).status).toBe(200);
    expect(existsSync(diskPath(server, entryHash))).toBe(true);
  });
});

describe("a write that meets a volume with no room", () => {
  it("is answered 507 insufficient_storage when the disk store has no room for the bytes of an upload, which are not kept, and the next upload lands", async () => {
    const body = new TextEncoder().encode(
      "bytes the disk store has no room for",
    );
    const hash = blobHash(body);
    await server.setFault("fail:blob-write");
    const refused = await working.uploadBlob(body, "text/plain");
    expect(refused.status, JSON.stringify(refused.error)).toBe(507);
    expect(refused.error?.error.code).toBe("insufficient_storage");
    expect(
      (await server.faults()).find((f) => f.name === "fail:blob-write")?.fired,
    ).toBe(1);
    expect((await operator.downloadBlob(hash)).status).toBe(404);
    expect(existsSync(diskPath(server, hash))).toBe(false);
    expect(spooled()).toEqual([]);

    const landed = await working.uploadBlob(body, "text/plain");
    expect(landed.status, JSON.stringify(landed.error)).toBe(201);
    expect(existsSync(diskPath(server, hash))).toBe(true);
  });

  it("is answered 507 insufficient_storage when the disk store has no room for the bytes of a restore, which writes no row", async () => {
    const entry = new TextEncoder().encode("restored bytes with no room");
    const id = uuidv7();
    const archive = itemsArchive(
      [
        {
          id,
          type: "core.file",
          source: "disk-space-faults",
          properties: {
            blob_ref: blobHash(entry),
            mime_type: "text/plain",
          },
        },
      ],
      [{ data: entry, mime_type: "text/plain" }],
    );
    await server.setFault("fail:blob-write");
    const refused = await ownerClient().restoreArchive(archive);
    expect(refused.status, JSON.stringify(refused.error)).toBe(507);
    expect(refused.error?.error.code).toBe("insufficient_storage");
    expect((await working.getItem(id)).status).toBe(404);
    expect(existsSync(diskPath(server, blobHash(entry)))).toBe(false);

    await server.clearFault();
    const landed = await ownerClient().restoreArchive(archive);
    expect(landed.status, JSON.stringify(landed.error)).toBe(200);
    expect((await working.getItem(id)).status).toBe(200);
  });
});
