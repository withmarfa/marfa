import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { blobFolder, clientsFor } from "../../utils/own-blob-server.js";
import { waitFor } from "../../utils/wait.js";

/**
 * What an archive export leaves on the server's disk, on a server of the
 * fixture's own: the export keeps what it has read in a folder under the disk
 * store, and nothing may stay there once the response is over, however it
 * ended.
 *
 * Each case holds an export open before it ends it. The archive carries a blob
 * of bytes that cannot be compressed, larger than the buffers between the
 * server and a client that is not reading, so the response is still being
 * written when the case looks at the folder, and a folder found empty then
 * would mean the export keeps nothing on disk rather than that it cleaned up.
 */
let server: FreshServer | undefined;
let working: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("export-spool");
  ({ working } = clientsFor(server));
  const bytes = new Uint8Array(randomBytes(24 * 1024 * 1024));
  const upload = await working.uploadBlob(bytes, "application/octet-stream");
  expect(upload.status, JSON.stringify(upload.error)).toBe(201);
  const note = await working.createItem({
    type: "core.note",
    properties: { body: `![bytes](${upload.data.hash})` },
  });
  expect(note.ok, JSON.stringify(note.error)).toBe(true);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

/** What the export holds in the spool under the disk store. */
function spooled(): string[] {
  const folder = join(blobFolder(server!), "tmp");
  return existsSync(folder) ? readdirSync(folder) : [];
}

/** An export whose headers have arrived and whose body nobody is reading. */
async function heldOpen(): Promise<{
  response: Response;
  controller: AbortController;
}> {
  const controller = new AbortController();
  const response = await fetch(`${server!.apiUrl}/export?format=archive`, {
    headers: { Authorization: `Bearer ${server!.workingKey}` },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  expect(
    spooled().length,
    "the export holds nothing on disk while its response is open",
  ).toBeGreaterThan(0);
  return { response, controller };
}

const emptied = (what: string) =>
  waitFor(what, async () => (spooled().length === 0 ? true : undefined));

describe("what an archive export leaves on disk", () => {
  it("leaves nothing in the spool once the whole archive has been read", async () => {
    expect(spooled()).toEqual([]);
    const { response } = await heldOpen();
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.length).toBeGreaterThan(24 * 1024 * 1024);
    await emptied("the spool to empty after a complete read");
  });

  it("leaves nothing in the spool once the client has left", async () => {
    const { response, controller } = await heldOpen();
    controller.abort();
    await expect(response.arrayBuffer()).rejects.toThrow();
    await emptied("the spool to empty after the client left");
  });

  it("keeps the spool of an export a stopped process was writing until the next start, and then clears it", async () => {
    const { response } = await heldOpen();
    const stranded = response.arrayBuffer().catch(() => undefined);
    let heldWhileStopped = 0;
    await server!.restart({
      signal: "SIGKILL",
      whileStopped: () => {
        heldWhileStopped = spooled().length;
      },
    });
    await stranded;
    expect(
      heldWhileStopped,
      "a process that was killed mid-export left its spool behind",
    ).toBeGreaterThan(0);
    expect(spooled()).toEqual([]);
  });
});
