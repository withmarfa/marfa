import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { listTarGzEntries } from "../../utils/archive.js";
import {
  approvedApp,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { clientsFor, DISK_ONLY } from "../../utils/own-blob-server.js";

/**
 * What an export does when the credential it was admitted on ends or narrows
 * while the response is open, on a server of the fixture's own.
 *
 * Every case reads the response slowly: it takes a first part, waits for the
 * server to fill the buffers between it and the client, changes the
 * credential, and reads on. The data is larger than those buffers, so a
 * response that kept sending after the change would still be sending when
 * the client reads on. Each case that cuts the response has a witness, the
 * same export read the same way with the credential left alone, which
 * arrives whole.
 */
const NOTES = 800;
/** Random bytes in each note, which come to about 40 KB as base64. */
const NOTE_BYTES = 30 * 1024;
const BLOB_BYTES = 24 * 1024 * 1024;
/** How much the client takes before the credential changes. */
const FIRST_PART = 256 * 1024;
/** Time for the server to fill what sits between it and the client. */
const BUFFERS_FILL_MS = 1000;
const TEST_MS = 180_000;

let server: FreshServer;
let working: MarfaClient;
let keys = 0;

beforeAll(async () => {
  server = await bootFreshServer("export-credential", DISK_ONLY);
  ({ working } = clientsFor(server));
  for (let first = 0; first < NOTES; first += 25) {
    const made = await working.bulkItems(
      Array.from({ length: 25 }, (_, at) => ({
        type: "core.note",
        properties: {
          body: randomBytes(NOTE_BYTES).toString("base64"),
          title: `note ${String(first + at)}`,
        },
      })),
    );
    expect(made.status, JSON.stringify(made.error)).toBe(200);
  }
  const blob = await working.uploadBlob(
    new Uint8Array(randomBytes(BLOB_BYTES)),
    "application/octet-stream",
  );
  expect(blob.status, JSON.stringify(blob.error)).toBe(201);
  const file = await working.createItem({
    type: "core.file",
    properties: {
      blob_ref: blob.data.hash,
      mime_type: "application/octet-stream",
    },
  });
  expect(file.status, JSON.stringify(file.error)).toBe(201);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.clearFault();
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

interface Scoped {
  id: string;
  key: string;
}

async function mint(
  typePermissions: Record<string, string>,
  expiresAt?: string,
): Promise<Scoped> {
  keys += 1;
  const minted = await working.createKey({
    label: `export-credential-${String(keys)}`,
    source: `export-credential-${String(keys)}`,
    type_permissions: typePermissions,
    permissions: [],
    ...(expiresAt && { expires_at: expiresAt }),
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  return { id: minted.data.id, key: minted.data.key };
}

/** An app the person approved for notes, and the means to disconnect it. */
async function connectedApp(): Promise<{
  token: string;
  disconnect: () => Promise<void>;
}> {
  const { token, clientId } = await approvedApp(server, ["core.note:read"]);
  const headers = { authorization: `Bearer ${server.managementKey}` };
  return {
    token,
    async disconnect() {
      const listed = await fetch(`${server.apiUrl}/auth/grants`, { headers });
      const { data } = (await listed.json()) as {
        data: { id: string; client_id: string }[];
      };
      const grant = data.find((one) => one.client_id === clientId);
      expect(grant, "the approved app is not listed").toBeDefined();
      const revoked = await fetch(`${server.apiUrl}/auth/grants/${grant!.id}`, {
        method: "DELETE",
        headers,
      });
      expect(revoked.status).toBe(204);
    },
  };
}

const readsNotes = () => mint({ "core.note": "read", "core.task": "read" });

function open(format: "ndjson" | "archive", type: string, key: string) {
  return fetch(`${server.apiUrl}/export?format=${format}&type=${type}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
}

interface Taken {
  bytes: Buffer;
  /** Whether the body ended with an error rather than cleanly. */
  failed: boolean;
}

/** Takes the first part, waits, runs `change`, and reads to the end. */
async function takeAcross(
  response: Response,
  change?: () => Promise<unknown>,
): Promise<Taken> {
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  let changed = change === undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      received += value.length;
      if (!changed && received >= FIRST_PART) {
        changed = true;
        await new Promise((resolve) => setTimeout(resolve, BUFFERS_FILL_MS));
        await change!();
      }
    }
  } catch {
    return { bytes: Buffer.concat(chunks), failed: true };
  }
  expect(changed).toBe(true);
  return { bytes: Buffer.concat(chunks), failed: false };
}

const noteLines = (bytes: Buffer) =>
  bytes
    .toString("utf8")
    .split("\n")
    .filter((line) => line.startsWith('{"item"')).length;

function archivedNotes(bytes: Buffer): number {
  const items = listTarGzEntries(new Uint8Array(bytes)).find(
    (entry) => entry.name === "items.ndjson",
  );
  return items!.body.toString().trim().split("\n").length;
}

describe("an ndjson export read slowly", () => {
  it("arrives whole when its credential stands, which is the witness for the cases below", async () => {
    const { key } = await readsNotes();
    const taken = await takeAcross(await open("ndjson", "core.note", key), () =>
      Promise.resolve(),
    );
    expect(taken.failed).toBe(false);
    expect(noteLines(taken.bytes)).toBe(NOTES);
  });

  it(
    "ends with an error when its key is revoked",
    async () => {
      const { id, key } = await readsNotes();
      const taken = await takeAcross(
        await open("ndjson", "core.note", key),
        async () => {
          expect((await working.revokeKey(id)).status).toBe(200);
        },
      );
      expect(taken.failed).toBe(true);
      expect(noteLines(taken.bytes)).toBeLessThan(NOTES);
    },
    TEST_MS,
  );

  it(
    "ends with an error when the app that opened it is disconnected",
    async () => {
      const app = await connectedApp();
      const taken = await takeAcross(
        await open("ndjson", "core.note", app.token),
        app.disconnect,
      );
      expect(taken.failed).toBe(true);
      expect(noteLines(taken.bytes)).toBeLessThan(NOTES);
    },
    TEST_MS,
  );

  it(
    "ends with an error when its key passes its expiry",
    async () => {
      const hour = 60 * 60 * 1000;
      const { key } = await mint(
        { "core.note": "read" },
        new Date(Date.now() + server.clockOffsetMs + hour).toISOString(),
      );
      const taken = await takeAcross(
        await open("ndjson", "core.note", key),
        async () => {
          await server.advanceClock(2 * hour);
        },
      );
      expect(taken.failed).toBe(true);
      expect(noteLines(taken.bytes)).toBeLessThan(NOTES);
    },
    TEST_MS,
  );

  it(
    "ends with an error when its key is narrowed to types the export does not carry",
    async () => {
      const { id, key } = await readsNotes();
      const taken = await takeAcross(
        await open("ndjson", "core.note", key),
        async () => {
          const narrowed = await working.updateKey(id, {
            type_permissions: { "core.task": "read" },
          });
          expect(narrowed.status, JSON.stringify(narrowed.error)).toBe(200);
        },
      );
      expect(taken.failed).toBe(true);
      expect(noteLines(taken.bytes)).toBeLessThan(NOTES);
    },
    TEST_MS,
  );

  it(
    "arrives whole when its key is narrowed to what the export still carries",
    async () => {
      const { id, key } = await readsNotes();
      const taken = await takeAcross(
        await open("ndjson", "core.note", key),
        async () => {
          const narrowed = await working.updateKey(id, {
            type_permissions: { "core.note": "read" },
          });
          expect(narrowed.status, JSON.stringify(narrowed.error)).toBe(200);
        },
      );
      expect(taken.failed).toBe(false);
      expect(noteLines(taken.bytes)).toBe(NOTES);
    },
    TEST_MS,
  );
});

describe("an archive export read slowly", () => {
  it(
    "arrives whole when its credential stands, which is the witness for the cases below",
    async () => {
      const { key } = await readsNotes();
      const taken = await takeAcross(
        await open("archive", "core.note", key),
        () => Promise.resolve(),
      );
      expect(taken.failed).toBe(false);
      expect(archivedNotes(taken.bytes)).toBe(NOTES);
    },
    TEST_MS,
  );

  it(
    "ends with an error when its key is revoked",
    async () => {
      const { id, key } = await readsNotes();
      const taken = await takeAcross(
        await open("archive", "core.note", key),
        async () => {
          expect((await working.revokeKey(id)).status).toBe(200);
        },
      );
      expect(taken.failed).toBe(true);
      expect(() => archivedNotes(taken.bytes)).toThrow();
    },
    TEST_MS,
  );

  it(
    "ends with an error when the app that opened it is disconnected",
    async () => {
      const app = await connectedApp();
      const taken = await takeAcross(
        await open("archive", "core.note", app.token),
        app.disconnect,
      );
      expect(taken.failed).toBe(true);
      expect(() => archivedNotes(taken.bytes)).toThrow();
    },
    TEST_MS,
  );

  it(
    "ends with an error when its key passes its expiry",
    async () => {
      const hour = 60 * 60 * 1000;
      const { key } = await mint(
        { "core.note": "read" },
        new Date(Date.now() + server.clockOffsetMs + hour).toISOString(),
      );
      const taken = await takeAcross(
        await open("archive", "core.note", key),
        async () => {
          await server.advanceClock(2 * hour);
        },
      );
      expect(taken.failed).toBe(true);
      expect(() => archivedNotes(taken.bytes)).toThrow();
    },
    TEST_MS,
  );

  it(
    "ends with an error when its key is narrowed to types the export does not carry",
    async () => {
      const { id, key } = await readsNotes();
      const taken = await takeAcross(
        await open("archive", "core.note", key),
        async () => {
          const narrowed = await working.updateKey(id, {
            type_permissions: { "core.task": "read" },
          });
          expect(narrowed.status, JSON.stringify(narrowed.error)).toBe(200);
        },
      );
      expect(taken.failed).toBe(true);
      expect(() => archivedNotes(taken.bytes)).toThrow();
    },
    TEST_MS,
  );

  it(
    "arrives whole when its key is narrowed to what the export still carries",
    async () => {
      const { id, key } = await readsNotes();
      const taken = await takeAcross(
        await open("archive", "core.note", key),
        async () => {
          const narrowed = await working.updateKey(id, {
            type_permissions: { "core.note": "read" },
          });
          expect(narrowed.status, JSON.stringify(narrowed.error)).toBe(200);
        },
      );
      expect(taken.failed).toBe(false);
      expect(archivedNotes(taken.bytes)).toBe(NOTES);
    },
    TEST_MS,
  );

  it(
    "ends with an error when its key is revoked while a blob is being sent",
    async () => {
      const { id, key } = await mint({ "core.file": "read" });
      const witness = await takeAcross(
        await open("archive", "core.file", key),
        () => Promise.resolve(),
      );
      expect(witness.failed).toBe(false);
      expect(witness.bytes.length).toBeGreaterThan(BLOB_BYTES);

      const taken = await takeAcross(
        await open("archive", "core.file", key),
        async () => {
          expect((await working.revokeKey(id)).status).toBe(200);
        },
      );
      expect(taken.failed).toBe(true);
      expect(taken.bytes.length).toBeLessThan(witness.bytes.length);
    },
    TEST_MS,
  );

  it(
    "is refused 401 when its key is revoked while the selection is read",
    async () => {
      const { id, key } = await readsNotes();
      await server.setFault("hold:export-page=1");
      const pending = open("archive", "core.note", key);
      try {
        await server.waitForHold("hold:export-page");
        expect((await working.revokeKey(id)).status).toBe(200);
      } finally {
        await server.clearFault();
      }
      const response = await pending;
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    },
    TEST_MS,
  );
});
