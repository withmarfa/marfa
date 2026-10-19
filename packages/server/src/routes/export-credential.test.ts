/**
 * An export in progress answers to its credential as it stands now.
 *
 * Every case reads the export slowly, so the response is still open when the
 * credential changes, and then reads on. A case that ends the export has a
 * witness: the same export, read the same way with the credential left
 * alone, delivers every line or the whole archive, so the cut is the
 * credential's doing and not a stream that was going to stop.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import * as tar from "tar-stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetEventLogForTests, initEventLog } from "../pubsub.js";
import type { TestContext } from "../test-utils.js";
import {
  createTestContext,
  mintWorkingKey,
  request,
  seedOauthBearer,
} from "../test-utils.js";
import { TextSpool } from "./export-spool.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
});
afterEach(async () => {
  vi.restoreAllMocks();
  __resetEventLogForTests();
  await ctx.cleanup();
});

const NOTES = 90;
const FORMATS = ["ndjson", "archive"] as const;
type Format = (typeof FORMATS)[number];

function rawSql(statement: string, params: unknown[] = []) {
  const storage = ctx.storage as typeof ctx.storage & {
    __sqliteRun: (statement: string, params: unknown[]) => Promise<unknown>;
  };
  return storage.__sqliteRun(statement, params);
}

/** `count` notes, each as large as `bodyBytes` hex-encoded, so an export is
 *  larger than the buffers between it and a client that has stopped reading. */
async function seedNotes(count: number, bodyBytes = 2000) {
  await rawSql(
    `WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v + 1 FROM n WHERE v < ?)
     INSERT INTO items (id, type, properties, created_at, updated_at, occurred_at)
     SELECT printf('01912345-0000-7000-8000-%012x', v), 'core.note',
       jsonb(json_object('body', hex(randomblob(?)), 'title', 'item ' || v)),
       strftime('%Y-%m-%dT%H:%M:%fZ', '2024-01-01', '+' || v || ' seconds'),
       strftime('%Y-%m-%dT%H:%M:%fZ', '2024-01-01', '+' || v || ' seconds'),
       strftime('%Y-%m-%dT%H:%M:%fZ', '2024-01-01', '+' || v || ' seconds') FROM n`,
    [count, bodyBytes],
  );
}

async function seedEdges(count: number) {
  await rawSql(
    `WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v + 1 FROM n WHERE v < ?)
     INSERT INTO edges (id, source_id, target_id, edge_type, properties, created_at, updated_at)
     SELECT printf('01912347-0000-7000-8000-%012x', v),
       printf('01912345-0000-7000-8000-%012x', v),
       printf('01912345-0000-7000-8000-%012x', v + 1),
       'references', json_object('note', hex(randomblob(100))),
       '2024-01-02T03:04:05.678Z', '2024-01-02T03:04:05.678Z' FROM n`,
    [count - 1],
  );
}

async function keyId(raw: string): Promise<string> {
  const res = await request(ctx.app, "GET", "/keys/current", { key: raw });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

/** A key that reads notes and tasks, with every other map the working key's. */
function readsNotesAndTasks() {
  return mintWorkingKey(ctx, {
    type_permissions: { "core.note": "read", "core.task": "read" },
    permissions: [],
  });
}

async function revoke(id: string) {
  const res = await request(ctx.app, "DELETE", `/keys/${id}`, {
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
}

async function patchKey(id: string, body: Record<string, unknown>) {
  const res = await request(ctx.app, "PATCH", `/keys/${id}`, {
    key: ctx.workingKey,
    body,
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

const narrow = (id: string, typePermissions: Record<string, string>) =>
  patchKey(id, { type_permissions: typePermissions });

function open(format: Format, bearer: string, query = "") {
  return request(
    ctx.app,
    "GET",
    `/export?format=${format}&type=core.note${query}`,
    { key: bearer },
  );
}

interface Drained {
  bytes: Buffer;
  /** Set when the response ended with an error rather than cleanly. */
  failure: unknown;
  changed: boolean;
}

/**
 * Reads the body a chunk at a time, runs `change` once after `afterBytes`
 * have arrived, and reads on to the end. The reader takes nothing else
 * while `change` runs, which is what a client that stops reading does.
 */
async function drain(
  res: Response,
  change: (() => Promise<void>) | undefined,
  afterBytes: number,
): Promise<Drained> {
  if (res.status !== 200)
    throw new Error(
      `Export answered ${String(res.status)}: ${await res.text()}`,
    );
  const reader = res.body!.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  let changed = false;
  let failure: unknown;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value as Uint8Array);
      chunks.push(chunk);
      received += chunk.length;
      if (change && !changed && received >= afterBytes) {
        changed = true;
        await change();
      }
    }
  } catch (error) {
    failure = error;
  }
  return { bytes: Buffer.concat(chunks), failure, changed };
}

const lines = (bytes: Buffer) =>
  bytes.toString("utf8").split("\n").filter(Boolean);

async function unpack(bytes: Buffer) {
  const entries: { name: string; data: Buffer }[] = [];
  const extract = tar.extract();
  const gunzip = createGunzip();
  await new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk) => {
        if (!Buffer.isBuffer(chunk)) throw new Error("Expected archive bytes");
        chunks.push(chunk);
      });
      stream.on("end", () => {
        entries.push({ name: header.name, data: Buffer.concat(chunks) });
        next();
      });
      stream.on("error", reject);
    });
    extract.on("finish", resolve);
    extract.on("error", reject);
    gunzip.on("error", reject);
    Readable.from(bytes).pipe(gunzip).pipe(extract);
  });
  return entries;
}

/** How many notes the response carried: its lines, or its archive's rows. */
async function notesIn(format: Format, bytes: Buffer): Promise<number> {
  if (format === "ndjson")
    return lines(bytes).filter((line) => line.startsWith('{"item"')).length;
  const items = (await unpack(bytes)).find(
    (entry) => entry.name === "items.ndjson",
  );
  return lines(items!.data).length;
}

const spool = () => readdirSync(ctx.blobs.disk.spoolDir);

async function untilSpoolEmpty() {
  let seen = spool().join();
  let still = 0;
  while (seen !== "") {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const now = spool().join();
    still = now === seen ? still + 10 : 0;
    if (still >= 10_000) throw new Error(`the spool stopped at ${now}`);
    seen = now;
  }
}

/** The bytes an export is cut at: past its first chunk, well short of its end. */
const AFTER = 1;

describe.each(FORMATS)("an %s export answers to its credential", (format) => {
  const complete = async (drained: Drained) => {
    expect(drained.failure).toBeUndefined();
    expect(await notesIn(format, drained.bytes)).toBe(NOTES);
  };
  const cutShort = async (drained: Drained) => {
    expect(drained.changed).toBe(true);
    expect(
      drained.failure,
      "the response ended cleanly after its credential ended",
    ).toBeDefined();
    if (format === "ndjson")
      expect(lines(drained.bytes).length).toBeLessThan(NOTES);
    else await expect(unpack(drained.bytes)).rejects.toBeDefined();
  };

  beforeEach(async () => {
    await seedNotes(NOTES);
  });

  it("delivers everything while the credential stands", async () => {
    const raw = await readsNotesAndTasks();
    const id = await keyId(raw);
    const drained = await drain(
      await open(format, raw),
      // The witness: a change that leaves the reach alone is not a cut.
      () => narrow(id, { "core.note": "read", "core.task": "read" }),
      AFTER,
    );
    expect(drained.changed).toBe(true);
    await complete(drained);
  });

  it("ends when the key is revoked", async () => {
    const raw = await readsNotesAndTasks();
    const id = await keyId(raw);
    await cutShort(
      await drain(await open(format, raw), () => revoke(id), AFTER),
    );
  });

  it("ends when the key passes its expiry", async () => {
    const raw = await readsNotesAndTasks();
    const id = await keyId(raw);
    await cutShort(
      await drain(
        await open(format, raw),
        async () => {
          await rawSql(
            "UPDATE api_keys SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
            [id],
          );
        },
        AFTER,
      ),
    );
  });

  it("ends when the key is narrowed to reach no type", async () => {
    const raw = await readsNotesAndTasks();
    const id = await keyId(raw);
    await cutShort(
      await drain(await open(format, raw), () => narrow(id, {}), AFTER),
    );
  });

  it("ends when the key is narrowed to types the export does not reach", async () => {
    const raw = await readsNotesAndTasks();
    const id = await keyId(raw);
    await cutShort(
      await drain(
        await open(format, raw),
        () => narrow(id, { "core.task": "read" }),
        AFTER,
      ),
    );
  });

  it("goes on when the key is narrowed to what the export still reaches", async () => {
    const raw = await readsNotesAndTasks();
    const id = await keyId(raw);
    const drained = await drain(
      await open(format, raw),
      () => narrow(id, { "core.note": "read" }),
      AFTER,
    );
    expect(drained.changed).toBe(true);
    await complete(drained);
  });

  it("ends when the key is narrowed away from an extension the export carries", async () => {
    await rawSql(
      `INSERT INTO metadata (item_id, tags, extensions)
       SELECT id, '[]', '{"mine":{"visible":"yes"}}' FROM items
       WHERE true
       ON CONFLICT (item_id) DO UPDATE SET extensions = excluded.extensions`,
    );
    const raw = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "read" },
      extension_permissions: { mine: "read" },
      permissions: [],
    });
    const id = await keyId(raw);
    const control = await drain(await open(format, raw), undefined, AFTER);
    await complete(control);
    await cutShort(
      await drain(
        await open(format, raw),
        () => patchKey(id, { extension_permissions: { other: "read" } }),
        AFTER,
      ),
    );
  });

  it("ends when a signed-in app is disconnected", async () => {
    const { token, grantId } = await seedOauthBearer(ctx, ["core.note:read"]);
    const control = await drain(await open(format, token), undefined, AFTER);
    await complete(control);
    await cutShort(
      await drain(
        await open(format, token),
        async () => {
          const res = await request(
            ctx.app,
            "DELETE",
            `/auth/grants/${grantId}`,
            { key: ctx.workingKey },
          );
          expect(res.status).toBe(204);
        },
        AFTER,
      ),
    );
  });

  it("ends when a signed-in app's token passes its expiry", async () => {
    const { token, clientId } = await seedOauthBearer(ctx, ["core.note:read"]);
    await cutShort(
      await drain(
        await open(format, token),
        async () => {
          await rawSql(
            "UPDATE auth_oauth_access_token SET expires_at = 1 WHERE client_id = ?",
            [clientId],
          );
        },
        AFTER,
      ),
    );
  });

  it("ends when the owner's session ends", async () => {
    const origin = new URL(ctx.config.authBaseUrl).origin;
    const start = () =>
      ctx.app.request(`/export?format=${format}&type=core.note`, {
        headers: { cookie: ctx.owner.cookie },
      });
    await complete(await drain(await start(), undefined, AFTER));
    await cutShort(
      await drain(
        await start(),
        async () => {
          const res = await request(ctx.app, "POST", "/auth/sign-out", {
            headers: { cookie: ctx.owner.cookie, origin },
            body: {},
          });
          expect(res.status).toBe(200);
        },
        AFTER,
      ),
    );
  });

  it("leaves nothing behind when the client goes", async () => {
    const raw = await readsNotesAndTasks();
    const res = await open(format, raw);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await untilSpoolEmpty();
  });
});

/**
 * Reads like `drain`, but runs `change` once what has arrived, unpacked, holds
 * the first edge, so the change lands while the edges are being sent.
 */
async function drainAtFirstEdge(
  format: Format,
  res: Response,
  change: () => Promise<void>,
): Promise<Drained & { seenEdge: boolean }> {
  if (res.status !== 200)
    throw new Error(
      `Export answered ${String(res.status)}: ${await res.text()}`,
    );
  const reader = res.body!.getReader();
  const chunks: Buffer[] = [];
  const gunzip = createGunzip();
  let text = "";
  gunzip.on("data", (chunk: Buffer) => {
    text += chunk.toString("latin1");
  });
  gunzip.on("error", () => undefined);
  let seenEdge = false;
  let failure: unknown;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      chunks.push(chunk);
      if (format === "ndjson") text += chunk.toString("latin1");
      else
        await new Promise<void>((resolve) => {
          gunzip.write(chunk, () => {
            resolve();
          });
        });
      if (!seenEdge && text.includes('{"edge":')) {
        seenEdge = true;
        await change();
      }
    }
  } catch (error) {
    failure = error;
  }
  return { bytes: Buffer.concat(chunks), failure, changed: seenEdge, seenEdge };
}

const EDGE_NOTES = 3000;

describe.each(FORMATS)("an %s export's edges", (format) => {
  const edgesIn = async (bytes: Buffer) =>
    format === "ndjson"
      ? lines(bytes).filter((line) => line.startsWith('{"edge"')).length
      : lines(
          (await unpack(bytes)).find((entry) => entry.name === "edges.ndjson")!
            .data,
        ).length;

  beforeEach(async () => {
    // Small notes and many edges: the edges are what must outlast the buffers.
    await seedNotes(EDGE_NOTES, 8);
    await seedEdges(EDGE_NOTES);
  });

  it.each([
    ["the key is revoked", (id: string) => revoke(id)],
    [
      "the key is narrowed away from the edge type",
      (id: string) => patchKey(id, { edge_permissions: { other: "read" } }),
    ],
  ])("end when %s while they stream", async (_name, change) => {
    const raw = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "read" },
      edge_permissions: { "*": "read" },
      permissions: [],
    });
    const id = await keyId(raw);
    const control = await drain(await open(format, raw), undefined, Infinity);
    expect(control.failure).toBeUndefined();
    expect(await edgesIn(control.bytes)).toBe(EDGE_NOTES - 1);

    const drained = await drainAtFirstEdge(
      format,
      await open(format, raw),
      () => change(id),
    );
    expect(drained.seenEdge).toBe(true);
    expect(drained.failure).toBeDefined();
    if (format === "ndjson")
      expect(await edgesIn(drained.bytes)).toBeLessThan(EDGE_NOTES - 1);
    else await expect(unpack(drained.bytes)).rejects.toBeDefined();
  });
});

describe("an ndjson export narrowed after rows have gone out", () => {
  const TASKS = 16;

  /** Sixty notes, then tasks created later so they list first, each with an
   *  edge to a note. */
  async function seedTasksWithEdges() {
    await seedNotes(60);
    await rawSql(
      `WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v + 1 FROM n WHERE v < ?)
       INSERT INTO items (id, type, properties, created_at, updated_at, occurred_at)
       SELECT printf('01912346-0000-7000-8000-%012x', v), 'core.task',
         jsonb(json_object('title', 'task ' || v)),
         '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z' FROM n`,
      [TASKS],
    );
    await rawSql(
      `WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v + 1 FROM n WHERE v < ?)
       INSERT INTO edges (id, source_id, target_id, edge_type, properties, created_at, updated_at)
       SELECT printf('01912347-0000-7000-8000-%012x', v),
         printf('01912346-0000-7000-8000-%012x', v),
         printf('01912345-0000-7000-8000-%012x', v),
         'references', '{}', '2025-01-02T00:00:00.000Z', '2025-01-02T00:00:00.000Z' FROM n`,
      [TASKS],
    );
  }

  const edgeLines = (bytes: Buffer) =>
    lines(bytes).filter((line) => line.startsWith('{"edge"')).length;

  it("ends with an error instead of leaving out the edges of rows already sent", async () => {
    await seedTasksWithEdges();
    const raw = await readsNotesAndTasks();
    const id = await keyId(raw);
    const open = () =>
      request(ctx.app, "GET", "/export?format=ndjson", { key: raw });

    // The witness: unnarrowed, the same export carries every task's edge.
    const control = await drain(await open(), undefined, Infinity);
    expect(control.failure).toBeUndefined();
    expect(edgeLines(control.bytes)).toBe(TASKS);

    // Past the twentieth line: all the tasks and a few notes have gone out.
    const offset = lines(control.bytes)
      .slice(0, 20)
      .reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);
    const drained = await drain(
      await open(),
      () => narrow(id, { "core.note": "read" }),
      offset,
    );
    expect(drained.changed).toBe(true);
    expect(
      drained.failure,
      "the export ended cleanly after its key was narrowed below what it carries",
    ).toBeDefined();
  });
});

describe("an archive export answers to its credential before and after its bytes", () => {
  beforeEach(async () => {
    await seedNotes(NOTES);
  });

  /** Runs `change` outside the export, once the spool's first matching `method` has run. */
  function atFirstCall(method: "append" | "seal", change: () => Promise<void>) {
    const outside = AsyncLocalStorage.snapshot();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with its receiver below.
    const original = TextSpool.prototype[method] as (
      this: TextSpool,
      ...args: unknown[]
    ) => Promise<unknown>;
    let changed = false;
    vi.spyOn(TextSpool.prototype, method).mockImplementation(async function (
      this: TextSpool,
      ...args: unknown[]
    ) {
      const result = await original.call(this, ...args);
      if (
        changed ||
        (method === "append" && !String(args[0]).includes('"item":'))
      )
        return result as never;
      changed = true;
      await outside(change);
      return result as never;
    });
  }

  it("refuses 401 when the key is revoked while the selection is read", async () => {
    const raw = await readsNotesAndTasks();
    const id = await keyId(raw);
    atFirstCall("append", () => revoke(id));
    const res = await open("archive", raw);
    expect(res.status).toBe(401);
    await untilSpoolEmpty();
  });

  it("refuses 401 when the key is revoked after the last page is read", async () => {
    const raw = await readsNotesAndTasks();
    const id = await keyId(raw);
    atFirstCall("seal", () => revoke(id));
    const res = await open("archive", raw);
    expect(res.status).toBe(401);
    await untilSpoolEmpty();
  });

  it("leaves the spool empty once a revoked archive ends", async () => {
    const raw = await readsNotesAndTasks();
    const id = await keyId(raw);
    const drained = await drain(
      await open("archive", raw),
      () => revoke(id),
      AFTER,
    );
    expect(drained.failure).toBeDefined();
    await untilSpoolEmpty();
  });
});

describe("an archive's blobs", () => {
  async function attachBlob(bytes: Buffer): Promise<string> {
    const up = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: bytes,
    });
    expect(up.status).toBe(201);
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const made = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.file",
        properties: { blob_ref: hash, mime_type: "text/plain" },
      },
    });
    expect(made.status, await made.clone().text()).toBe(201);
    return hash;
  }

  const readsFiles = () =>
    mintWorkingKey(ctx, {
      type_permissions: { "core.file": "read" },
      permissions: [],
    });
  const openFiles = (raw: string) =>
    request(ctx.app, "GET", "/export?format=archive&type=core.file", {
      key: raw,
    });
  /** Past the manifest and the rows, which are a few kilobytes. */
  const INSIDE_THE_BLOB = 256 * 1024;

  it("ends part way through a blob when the key is revoked", async () => {
    const bytes = randomBytes(6 * 1024 * 1024);
    await attachBlob(bytes);
    const raw = await readsFiles();
    const id = await keyId(raw);
    const control = await drain(await openFiles(raw), undefined, Infinity);
    expect(control.failure).toBeUndefined();
    expect(control.bytes.length).toBeGreaterThan(bytes.length);

    const drained = await drain(
      await openFiles(raw),
      () => revoke(id),
      INSIDE_THE_BLOB,
    );
    expect(drained.changed).toBe(true);
    expect(drained.failure).toBeDefined();
    expect(drained.bytes.length).toBeLessThan(control.bytes.length / 2);
    await untilSpoolEmpty();
  });

  it("goes on when a write takes the lending away between the checks of one blob", async () => {
    const bytes = randomBytes(100 * 1024);
    await attachBlob(bytes);
    const raw = await readsFiles();
    const outside = AsyncLocalStorage.snapshot();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Called with its receiver below.
    const readableThrough = ctx.storage.blobs.readableThrough;
    let calls = 0;
    vi.spyOn(ctx.storage.blobs, "readableThrough").mockImplementation(
      async (...args) => {
        const answer = await readableThrough.apply(ctx.storage.blobs, args);
        // The first call is the selection's. The second and third are the
        // send's check of the one blob, under the credential it was admitted
        // on and under the credential as it stands.
        if (++calls === 2)
          await outside(() => rawSql("DELETE FROM item_blob_references"));
        return answer;
      },
    );
    const drained = await drain(await openFiles(raw), undefined, Infinity);
    expect(calls).toBe(3);
    expect(drained.failure).toBeUndefined();
    expect(drained.bytes.length).toBeGreaterThan(bytes.length);
  });

  it("reads no further blob once the key is revoked", async () => {
    await attachBlob(randomBytes(1024 * 1024));
    await attachBlob(randomBytes(1024 * 1024));
    const raw = await readsFiles();
    const id = await keyId(raw);
    const reads = vi.spyOn(ctx.blobs.disk, "get");
    const control = await drain(await openFiles(raw), undefined, Infinity);
    expect(control.failure).toBeUndefined();
    // The witness: with the key standing, both blobs are read.
    expect(reads.mock.calls).toHaveLength(2);
    reads.mockClear();

    const drained = await drain(
      await openFiles(raw),
      () => revoke(id),
      INSIDE_THE_BLOB,
    );
    expect(drained.failure).toBeDefined();
    expect(reads.mock.calls).toHaveLength(1);
  });
});
