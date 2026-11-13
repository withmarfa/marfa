import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { listEntries } from "../../utils/archive.js";
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
 * An archive export held to the reserve of free space the instance keeps, on
 * a server of the fixture's own. The export writes what it has read into the
 * disk store's `tmp` folder before its first byte, so those files count
 * against the reserve. The fixture gives the disk store's volume the room it
 * chooses through the target interface's `free` fault (`conformance/TARGET-INTERFACE.md`,
 * "Faults").
 */
const MiB = 1024 * 1024;
const RESERVE = MiB;

let server: FreshServer;

beforeAll(async () => {
  server = await bootFreshServer("export-reserve", {
    ...DISK_ONLY,
    MARFA_DISK_RESERVE_BYTES: String(RESERVE),
  });
  const { working } = clientsFor(server);
  const created = await working.bulkItems(
    Array.from({ length: 20 }, (_, at) => ({
      type: "core.note",
      properties: { title: `note ${String(at)}` },
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

function spooled(): string[] {
  const folder = join(blobFolder(server), "tmp");
  return existsSync(folder) ? readdirSync(folder) : [];
}

function exportArchive(): Promise<Response> {
  return fetch(`${server.apiUrl}/export?format=archive`, {
    headers: { Authorization: `Bearer ${server.workingKey}` },
  });
}

describe("an archive export held to the reserve", () => {
  it("is sent whole while the volume has room beside the reserve, which is the witness for the refusal below", async () => {
    await server.setFault(`free:blobs=${String(64 * MiB)}`);
    const response = await exportArchive();
    expect(response.status).toBe(200);
    const names = listEntries(new Uint8Array(await response.arrayBuffer())).map(
      (entry) => entry.name,
    );
    expect(names).toContain("items.ndjson.gz");
  });

  it("is refused 507 insufficient_storage before any archive byte, naming the reserve and the room, and leaves nothing on disk", async () => {
    const available = RESERVE - 1;
    await server.setFault(`free:blobs=${String(available)}`);
    const response = await exportArchive();
    expect(response.status).toBe(507);
    const body = (await response.json()) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe("insufficient_storage");
    expect(body.error.details).toMatchObject({
      reserve_bytes: RESERVE,
      available_bytes: available,
    });
    await waitFor("the spool to empty", () =>
      Promise.resolve(spooled().length === 0 ? true : undefined),
    );
  });
});
