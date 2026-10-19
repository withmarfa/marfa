import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { MarfaClient } from "../../client/api.js";
import { blobHash, itemsArchive } from "../../utils/archive.js";
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
import { inParts, pause, slowPost } from "../../utils/slow-body.js";
import { waitFor } from "../../utils/wait.js";

/**
 * What a restore and a blob upload do about time, on a server of the
 * fixture's own: the body takes as long as it takes while bytes keep
 * arriving, and the server ends one that stops arriving. The private control
 * socket is the door, because it is the one a fixture can hold a request on
 * for longer than its fixed request deadline, 30 seconds, without waiting for
 * the public listener's 300.
 *
 * A server that keeps a 30-second request deadline checked every 30 seconds,
 * as Node's own is, cuts the body at the second check, a minute in. The long
 * case therefore runs for 66 seconds, a part every 2 seconds, so a server
 * that still cuts it fails here.
 *
 * The server is booted with an idle limit of 3 seconds, so each part comes
 * well inside it and a stall is ended quickly.
 */
const IDLE_MS = 3000;
const PARTS = 33;
const GAP_MS = 2000;
const HEADERS = { "content-type": "application/octet-stream" };

let server: FreshServer;
let management: MarfaClient;
let working: MarfaClient;
/** The two long uploads begin together, so the file waits 66 seconds once. */
let longRestore: Promise<Long>;
let longBlob: Promise<Long>;
const longRestoreId = uuidv7();
const longBlobBytes = Buffer.from("a blob sent a part at a time ".repeat(2000));

beforeAll(async () => {
  server = await bootFreshServer("upload-timing", {
    ...DISK_ONLY,
    MARFA_UPLOAD_IDLE_TIMEOUT_MS: String(IDLE_MS),
  });
  ({ operator: management, working } = clientsFor(server));
  longRestore = sendSlowly(
    "/restore",
    { "content-type": "application/gzip" },
    noteArchive(longRestoreId, "restored after a long upload"),
  );
  longBlob = sendSlowly("/blobs", HEADERS, longBlobBytes);
  // A fixture that fails before it awaits them must not leave them unhandled.
  longRestore.catch(() => undefined);
  longBlob.catch(() => undefined);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

/** What the upload spools into while a body arrives. */
function spooled(): string[] {
  const folder = join(blobFolder(server), "tmp");
  return existsSync(folder) ? readdirSync(folder) : [];
}

function noteArchive(id: string, body: string): Uint8Array {
  return itemsArchive([
    {
      id,
      type: "core.note",
      properties: { body },
      source: "upload-timing",
    },
  ]);
}

/** A blob of its own, so no case finds another's bytes already stored. */
function blobOf(seed: string): Uint8Array {
  return Buffer.from(seed.repeat(2000));
}

interface Long {
  started: number;
  finished: number;
  status: number;
  body: string;
}

/**
 * Sends `body` to `path` in parts, a part every `GAP_MS`, and says how long it
 * took and what the server answered.
 */
async function sendSlowly(
  path: string,
  headers: Record<string, string>,
  body: Uint8Array,
): Promise<Long> {
  const upload = slowPost({ socketPath: server.controlSocket }, path, headers);
  const started = Date.now();
  for (const part of inParts(body, PARTS)) {
    await upload.write(part);
    await pause(GAP_MS);
  }
  upload.end();
  const answered = await upload.answered;
  return { started, finished: Date.now(), ...answered };
}

describe("a body that takes longer than the fixed request deadline", () => {
  it("restores an archive whose body takes 66 seconds to arrive, a part at a time", async () => {
    const answered = await longRestore;
    expect(answered.finished - answered.started).toBeGreaterThan(60_000);
    expect(answered.status, answered.body).toBe(200);
    expect(JSON.parse(answered.body)).toMatchObject({ imported: 1 });
    expect((await working.getItem(longRestoreId)).status).toBe(200);
  }, 120_000);

  it("stores a blob whose body takes 66 seconds to arrive, a part at a time", async () => {
    const answered = await longBlob;
    expect(answered.finished - answered.started).toBeGreaterThan(60_000);
    expect(answered.status, answered.body).toBe(201);
    expect(JSON.parse(answered.body)).toMatchObject({
      hash: blobHash(longBlobBytes),
      size_bytes: longBlobBytes.length,
    });
    expect(
      (await management.downloadBlob(blobHash(longBlobBytes))).status,
    ).toBe(200);
  }, 120_000);
});

describe("a body that stops arriving", () => {
  it("ends a restore with 408 request_timeout, writes nothing and removes what it spooled", async () => {
    const id = uuidv7();
    const archive = noteArchive(id, "never finished arriving");
    const parts = inParts(archive, 4);
    const upload = slowPost({ socketPath: server.controlSocket }, "/restore", {
      "content-type": "application/gzip",
    });
    for (const part of parts.slice(0, 3)) await upload.write(part);
    // The witness for the absence below: the part that arrived is on disk.
    await waitFor("the part of the archive to be spooled", () =>
      Promise.resolve(spooled().length > 0 ? true : undefined),
    );
    const answered = await upload.answered;
    expect(answered.status, answered.body).toBe(408);
    expect(JSON.parse(answered.body).error.code).toBe("request_timeout");
    expect((await working.getItem(id)).status).toBe(404);
    await waitFor("the spool to empty", () =>
      Promise.resolve(spooled().length === 0 ? true : undefined),
    );

    // The same archive, whole, restores: it was the stall that stopped it.
    const whole = slowPost({ socketPath: server.controlSocket }, "/restore", {
      "content-type": "application/gzip",
    });
    await whole.write(archive);
    whole.end();
    expect((await whole.answered).status).toBe(200);
    expect((await working.getItem(id)).status).toBe(200);
  });

  it("ends a blob upload with 408 request_timeout and stores no blob, neither whole nor as far as it got", async () => {
    const bytes = blobOf("a blob that stopped arriving ");
    const parts = inParts(bytes, 4);
    const arrived = Buffer.concat(parts.slice(0, 3));
    const upload = slowPost(
      { socketPath: server.controlSocket },
      "/blobs",
      HEADERS,
    );
    for (const part of parts.slice(0, 3)) await upload.write(part);
    await waitFor("the part of the blob to be spooled", () =>
      Promise.resolve(spooled().length > 0 ? true : undefined),
    );
    const answered = await upload.answered;
    expect(answered.status, answered.body).toBe(408);
    expect(JSON.parse(answered.body).error.code).toBe("request_timeout");
    expect((await management.downloadBlob(blobHash(bytes))).status).toBe(404);
    expect((await management.downloadBlob(blobHash(arrived))).status).toBe(404);
    await waitFor("the spool to empty", () =>
      Promise.resolve(spooled().length === 0 ? true : undefined),
    );

    // The same bytes, whole, are stored: the stall alone kept them out.
    const whole = slowPost(
      { socketPath: server.controlSocket },
      "/blobs",
      HEADERS,
    );
    await whole.write(bytes);
    whole.end();
    expect((await whole.answered).status).toBe(201);
    expect((await management.downloadBlob(blobHash(bytes))).status).toBe(200);
  });
});
