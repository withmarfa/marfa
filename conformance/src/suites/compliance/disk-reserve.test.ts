import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import { blobHash, itemsArchive } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { clientsFor } from "../../utils/own-blob-server.js";
import { TEST_OWNER } from "../../utils/target.js";

/**
 * What an upload and a restore do when the volume cannot keep the instance's
 * reserve of free space (the `blobs/upload-reserve` and
 * `blobs/restore-reserve` rules, and `errors/storage-reserve-details`).
 *
 * **One server, booted twice on the same state.** A reserve larger than any
 * volume is how a fixture makes the volume short without filling one: the
 * server is booted with a reserve of 2^50 bytes, so every body is one it
 * cannot keep room beside. The same server is then booted again with no
 * reserve, and each request that was refused is sent again and lands. That
 * is the witness for the refusals: the bytes and the rows were producible,
 * so their absence in between is the refusal's doing and not an upload or a
 * restore that cannot work on this server.
 *
 * A body that outgrows the room as it arrives, and a volume that is full,
 * need a volume the fixture controls; they wait on #1444.
 */
const HUGE_RESERVE = 2 ** 50;

let server: FreshServer;
let management: MarfaClient;
let working: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("disk-reserve", {
    MARFA_DISK_RESERVE_BYTES: String(HUGE_RESERVE),
  });
  ({ operator: management, working } = clientsFor(server));
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

/** The server again on the same state, under no reserve. The keys stay. */
async function withoutReserve(): Promise<void> {
  await server.restart({ env: { MARFA_DISK_RESERVE_BYTES: "0" } });
  ({ operator: management, working } = clientsFor(server));
}

function ownerClient(): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    ownerCookie: server.ownerCookie,
    ownerCredentials: TEST_OWNER,
    ownerSessionFile: `${server.stateDir}/owner-session.json`,
  });
}

describe("a reserve the volume cannot keep", () => {
  const bytes = new TextEncoder().encode("a body no reserve can keep room for");
  const hash = blobHash(bytes);
  const id = uuidv7();
  const restored = new TextEncoder().encode("a blob an archive carries");
  const restoredHash = blobHash(restored);

  const typeId = "user.disk_reserve_note";

  const archive = () =>
    itemsArchive(
      [
        {
          id,
          type: "core.file",
          source: "disk-reserve",
          properties: {
            blob_ref: restoredHash,
            mime_type: "application/octet-stream",
          },
        },
      ],
      [{ data: restored, mime_type: "application/octet-stream" }],
      [
        {
          id: typeId,
          label: "Disk reserve note",
          description: "A type the archive registers",
          version: 1,
          fields: { body: { type: "string", description: "Body" } },
        },
      ],
    );

  it("refuses an upload 507 insufficient_storage, naming the reserve and the room, and stores nothing", async () => {
    const refused = await working.uploadBlob(bytes, "application/octet-stream");
    expect(refused.status).toBe(507);
    expect(refused.error?.error.code).toBe("insufficient_storage");
    expect(refused.error?.error.details).toMatchObject({
      reserve_bytes: HUGE_RESERVE,
    });
    expect(
      typeof (refused.error?.error.details as { available_bytes?: unknown })
        .available_bytes,
    ).toBe("number");
    expect((await management.downloadBlob(hash)).status).toBe(404);
  });

  it("refuses a restore 507 insufficient_storage, and writes no row, no type and no blob", async () => {
    const refused = await ownerClient().restoreArchive(archive());
    expect(refused.status).toBe(507);
    expect(refused.error?.error.code).toBe("insufficient_storage");
    expect((await working.getItem(id)).status).toBe(404);
    expect((await management.downloadBlob(restoredHash)).status).toBe(404);
    expect((await working.getType(typeId)).status).toBe(404);
  });

  it("takes a write that carries a JSON body, which the reserve is not asked of", async () => {
    const created = await working.createItem({
      type: "core.note",
      properties: { body: "a write the reserve does not touch" },
    });
    expect(created.status).toBe(201);
  });

  it("takes the same upload and the same restore once the instance holds no reserve", async () => {
    await withoutReserve();

    const uploaded = await working.uploadBlob(
      bytes,
      "application/octet-stream",
    );
    expect(uploaded.status).toBe(201);
    expect(uploaded.data.hash).toBe(hash);
    expect((await management.downloadBlob(hash)).status).toBe(200);

    const done = await ownerClient().restoreArchive(archive());
    expect(done.status).toBe(200);
    expect(done.data.imported).toBe(1);
    expect((await working.getItem(id)).status).toBe(200);
    expect((await management.downloadBlob(restoredHash)).status).toBe(200);
    expect((await working.getType(typeId)).status).toBe(200);
  });
});
