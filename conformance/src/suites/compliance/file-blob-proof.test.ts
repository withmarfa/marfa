import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { BulkActionJob, TestContext } from "../../client/types.js";
import {
  createTestContext,
  cleanup,
  getManagementClient,
  trackItem,
  trackKey,
} from "../../utils/setup.js";

let client: MarfaClient;
let operator: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "file-blob-proof",
  ));
  operator = getManagementClient();
});

afterAll(async () => {
  await cleanup(ctx);
});

let minted = 0;

interface Holder {
  client: MarfaClient;
  id: string;
  source: string;
}

/** A key of this run's own, under a source of its own. */
async function keyHolding(
  typePermissions: Record<string, string>,
): Promise<Holder> {
  minted += 1;
  const source = `${ctx.source}-${String(minted)}`;
  const res = await client.createKey({
    label: `file-blob-proof-${String(minted)}`,
    source,
    type_permissions: typePermissions,
  });
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
  trackKey(ctx, res.data.id);
  return {
    client: new MarfaClient({ baseUrl: apiUrl, apiKey: res.data.key }),
    id: res.data.id,
    source,
  };
}

let sent = 0;

/** Bytes of this run's own, uploaded by `by`. */
async function uploadAs(
  by: MarfaClient,
  words: string,
): Promise<{ hash: string; bytes: Uint8Array }> {
  sent += 1;
  const bytes = new TextEncoder().encode(
    `${words} ${String(sent)} ${ctx.runId}`,
  );
  const res = await by.uploadBlob(bytes, "text/plain");
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return { hash: res.data.hash, bytes };
}

function fileProperties(
  hash: string,
  title = "a file",
): Record<string, string> {
  return { blob_ref: hash, mime_type: "text/plain", title };
}

/** Each reading door's status and error code for one credential. */
async function readingDoors(
  reader: MarfaClient,
  hash: string,
): Promise<Record<string, [number, string | undefined]>> {
  const bytes = await reader.downloadBlob(hash);
  const head = await reader.headBlob(hash);
  const link = await reader.getBlobUrl(hash);
  const locations = await reader.listBlobLocations(hash);
  return {
    bytes: [bytes.status, bytes.error?.error.code],
    head: [head.status, undefined],
    link: [link.status, link.error?.error.code],
    locations: [locations.status, locations.error?.error.code],
  };
}

const UNKNOWN = {
  bytes: [404, "blob_not_found"],
  head: [404, undefined],
  link: [404, "blob_not_found"],
  locations: [404, "blob_not_found"],
};

const SERVED = {
  bytes: [200, undefined],
  head: [200, undefined],
  link: [200, undefined],
  locations: [200, undefined],
};

/** Every row the source holds, in any state, tracked for cleanup. */
async function rowsOf(source: string): Promise<Record<string, unknown>[]> {
  const rows = await client.listItems({ source, state: "any", limit: 200 });
  expect(rows.ok, JSON.stringify(rows.error)).toBe(true);
  for (const row of rows.data.data) trackItem(ctx, row.id);
  return rows.data.data as unknown as Record<string, unknown>[];
}

function naming(rows: Record<string, unknown>[], hash: string): number {
  const hex = hash.slice("sha256:".length);
  return rows.filter((row) => JSON.stringify(row).includes(hex)).length;
}

describe("a file whose bytes its writer never proved", () => {
  it("is refused when another key uploaded the bytes, and taken once its writer uploads them too", async () => {
    const uploader = await keyHolding({ "core.file": "write" });
    const writer = await keyHolding({ "core.file": "write" });
    const { hash, bytes } = await uploadAs(uploader.client, "bytes A sent");

    // The witness: the instance holds the bytes, and no row names them yet.
    expect((await operator.headBlob(hash)).status).toBe(200);

    const refused = await writer.client.createItem({
      type: "core.file",
      properties: fileProperties(hash),
    });
    expect(refused.status, JSON.stringify(refused.data)).toBe(404);
    expect(refused.error?.error.code).toBe("blob_not_found");
    expect(naming(await rowsOf(writer.source), hash)).toBe(0);
    expect(await readingDoors(uploader.client, hash)).toEqual(UNKNOWN);
    expect(await readingDoors(writer.client, hash)).toEqual(UNKNOWN);

    // The way forward the refusal names: the writer sends the bytes itself.
    const again = await writer.client.uploadBlob(bytes, "text/plain");
    expect(again.status, JSON.stringify(again.error)).toBe(201);
    expect(again.data.hash).toBe(hash);
    const taken = await writer.client.createItem({
      type: "core.file",
      properties: fileProperties(hash),
    });
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
    trackItem(ctx, taken.data.item.id);
    expect(await readingDoors(writer.client, hash)).toEqual(SERVED);
    expect(await readingDoors(uploader.client, hash)).toEqual(SERVED);
  });

  it("keeps no answer under the Idempotency-Key, so the write sent again after the upload is taken", async () => {
    const uploader = await keyHolding({ "core.file": "write" });
    const writer = await keyHolding({ "core.file": "write" });
    const { hash, bytes } = await uploadAs(uploader.client, "bytes C sent");
    const headers = { "Idempotency-Key": `file-proof-${ctx.runId}` };
    const create = () =>
      writer.client.rawRequest<{ item: { id: string } }>("/items", {
        method: "POST",
        headers,
        body: { type: "core.file", properties: fileProperties(hash) },
      });

    const refused = await create();
    expect(refused.status, JSON.stringify(refused.data)).toBe(404);
    expect(refused.error?.error.code).toBe("blob_not_found");
    // Sent again before the upload, the request is judged afresh.
    const before = await create();
    expect(before.status).toBe(404);
    expect(before.headers.get("Idempotency-Replayed")).toBeNull();

    const again = await writer.client.uploadBlob(bytes, "text/plain");
    expect(again.status, JSON.stringify(again.error)).toBe(201);
    const taken = await create();
    expect(
      taken.status,
      "the retry the refusal asks for was answered with the kept refusal",
    ).toBe(201);
    expect(taken.headers.get("Idempotency-Replayed")).toBeNull();
    trackItem(ctx, taken.data.item.id);
    // Kept once taken: the next repeat is the replay of the create.
    const replayed = await create();
    expect(replayed.status).toBe(201);
    expect(replayed.headers.get("Idempotency-Replayed")).toBe("true");
    expect(replayed.data.item.id).toBe(taken.data.item.id);
  });

  it("answers bytes another key holds exactly as it answers a hash nothing holds", async () => {
    const owner = await keyHolding({ "core.note": "write" });
    const writer = await keyHolding({ "core.file": "write" });
    const { hash } = await uploadAs(
      owner.client,
      "bytes a private note embeds",
    );
    const note = await owner.client.createItem({
      type: "core.note",
      properties: { body: `![it](${hash})` },
    });
    expect(note.ok, JSON.stringify(note.error)).toBe(true);
    trackItem(ctx, note.data.item.id);
    // The witness: the owner's own note lends the bytes to the owner.
    expect(await readingDoors(owner.client, hash)).toEqual(SERVED);

    const held = await writer.client.createItem({
      type: "core.file",
      properties: fileProperties(hash),
    });
    const nowhere = await writer.client.createItem({
      type: "core.file",
      properties: fileProperties(`sha256:${"0".repeat(63)}7`),
    });
    expect(held.status).toBe(404);
    expect([nowhere.status, nowhere.error]).toEqual([held.status, held.error]);
    expect(await readingDoors(writer.client, hash)).toEqual(UNKNOWN);
    expect(naming(await rowsOf(writer.source), hash)).toBe(0);
  });

  it("takes a hash in any other property, which lends nothing to a key that only knows it", async () => {
    const owner = await keyHolding({ "core.note": "write" });
    const knower = await keyHolding({ "core.file": "write" });
    const { hash } = await uploadAs(owner.client, "bytes a title names");
    const note = await owner.client.createItem({
      type: "core.note",
      properties: { body: `![it](${hash})` },
    });
    expect(note.ok, JSON.stringify(note.error)).toBe(true);
    trackItem(ctx, note.data.item.id);
    const other = await uploadAs(knower.client, "the knower's own bytes");

    // A digest in a title is text, so the write is taken.
    const titled = await knower.client.createItem({
      type: "core.file",
      properties: fileProperties(other.hash, `see ${hash}`),
    });
    expect(titled.status, JSON.stringify(titled.error)).toBe(201);
    trackItem(ctx, titled.data.item.id);
    // The witness: the owner reads the bytes through its own note.
    expect(await readingDoors(owner.client, hash)).toEqual(SERVED);
    expect(await readingDoors(knower.client, hash)).toEqual(UNKNOWN);
    expect(await readingDoors(knower.client, other.hash)).toEqual(SERVED);
  });

  it("is refused once the uploader is revoked, while a row the uploader wrote keeps lending", async () => {
    const uploader = await keyHolding({ "core.note": "write" });
    const writer = await keyHolding({ "core.file": "write" });
    const reader = await keyHolding({ "core.note": "read" });
    const { hash, bytes } = await uploadAs(
      uploader.client,
      "bytes a revoked key sent",
    );
    const first = await uploader.client.createItem({
      type: "core.note",
      properties: { body: `![it](${hash})` },
    });
    expect(first.ok, JSON.stringify(first.error)).toBe(true);
    trackItem(ctx, first.data.item.id);
    const revoked = await client.revokeKey(uploader.id);
    expect(revoked.ok, JSON.stringify(revoked.error)).toBe(true);

    expect(await readingDoors(reader.client, hash)).toEqual(SERVED);
    const refused = await writer.client.createItem({
      type: "core.file",
      properties: fileProperties(hash, "a second file"),
    });
    expect(refused.status).toBe(404);
    expect(refused.error?.error.code).toBe("blob_not_found");

    expect((await writer.client.uploadBlob(bytes, "text/plain")).status).toBe(
      201,
    );
    const taken = await writer.client.createItem({
      type: "core.file",
      properties: fileProperties(hash, "a second file"),
    });
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
    trackItem(ctx, taken.data.item.id);
  });

  it("takes a stale write from another key that carries back the blob_ref its base named", async () => {
    const owner = await keyHolding({ "core.file": "write" });
    const editor = await keyHolding({ "core.file": "write" });
    const first = await uploadAs(owner.client, "the first bytes");
    const second = await uploadAs(owner.client, "the second bytes");
    const file = await owner.client.createItem({
      type: "core.file",
      properties: fileProperties(first.hash),
    });
    expect(file.ok, JSON.stringify(file.error)).toBe(true);
    trackItem(ctx, file.data.item.id);
    const moved = await owner.client.updateItem(file.data.item.id, {
      properties: { blob_ref: second.hash },
      version: file.data.item.version,
    });
    expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
    // The editor never sent either set of bytes, and retitles the file from
    // version 1 with every property it read there, `blob_ref` included. The
    // digest is the base's, not the editor's, so it decides nothing.
    const stale = await editor.client.rawRequest(
      `/items/${file.data.item.id}?conflict=auto`,
      {
        method: "PATCH",
        body: {
          properties: fileProperties(first.hash, "retitled"),
          version: file.data.item.version,
        },
      },
    );
    expect(stale.ok, JSON.stringify(stale.error)).toBe(true);
    const read = await owner.client.getItem(file.data.item.id);
    expect(read.ok, JSON.stringify(read.error)).toBe(true);
    expect(read.data.item.properties).toMatchObject({
      blob_ref: second.hash,
      title: "retitled",
    });
  });
});

/**
 * A door that writes a file's properties, given a writer: it prepares the row
 * that writer needs, and answers the write naming a digest as the refusal's
 * code, or undefined where the door took it.
 */
type Door = (
  writer: MarfaClient,
) => Promise<(hash: string) => Promise<string | undefined>>;

let prepared = 0;

function nextKey(): string {
  prepared += 1;
  return `file-proof-${String(prepared)}-${ctx.runId}`;
}

/** A single request's verdict: undefined when taken, its code when refused. */
function verdictOf(res: {
  ok: boolean;
  status: number;
  error?: { error: { code: string } };
}): string | undefined {
  if (res.ok) return undefined;
  expect(res.status, JSON.stringify(res.error)).toBe(404);
  return res.error?.error.code;
}

async function fileOf(
  writer: MarfaClient,
  properties: Record<string, unknown>,
  extra: { source_id?: string; tags?: string[] } = {},
): Promise<{ id: string; version: number }> {
  const res = await writer.createItem({
    type: "core.file",
    properties,
    ...extra,
  });
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
  return { id: res.data.item.id, version: res.data.item.version };
}

/** A file moved on from version 1, so a write based on 1 is stale. */
async function movedOn(
  writer: MarfaClient,
  first: Record<string, unknown>,
  second: Record<string, unknown>,
): Promise<{ id: string; stale: number }> {
  const made = await fileOf(writer, first);
  const res = await writer.updateItem(made.id, {
    properties: second,
    version: made.version,
  });
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
  return { id: made.id, stale: made.version };
}

const PENDING = { blob_ref: "not yet sent", mime_type: "text/plain" };

/**
 * Holds one door to the refusal: a writer that neither sent the bytes nor can
 * read them names the digest as a file's `blob_ref` through the door and is
 * refused with nothing written, and the writer that sent them names it through
 * the same door and is taken, so the refusal is the proof's and not the door's.
 */
async function expectDoorRefuses(door: Door): Promise<void> {
  const writes = { "core.file": "write", "core.note": "write" };
  const sender = await keyHolding(writes);
  const stranger = await keyHolding(writes);
  const reader = await keyHolding({ "*": "read" });
  const { hash } = await uploadAs(sender.client, "named through a door");

  const nameAsSender = await door(sender.client);
  const nameAsStranger = await door(stranger.client);
  // The witness: held, and nothing names it yet.
  expect(await readingDoors(reader.client, hash)).toEqual(UNKNOWN);
  expect((await operator.headBlob(hash)).status).toBe(200);

  expect(await nameAsStranger(hash)).toBe("blob_not_found");
  expect(naming(await rowsOf(stranger.source), hash)).toBe(0);
  expect(await readingDoors(reader.client, hash)).toEqual(UNKNOWN);

  expect(await nameAsSender(hash)).toBeUndefined();
  expect(naming(await rowsOf(sender.source), hash)).toBeGreaterThan(0);
  expect(await readingDoors(reader.client, hash)).toEqual(SERVED);
}

describe("which write that names a file's bytes is refused", () => {
  it("refuses a create", async () => {
    await expectDoorRefuses(
      async (writer) => async (hash) =>
        verdictOf(
          await writer.createItem({
            type: "core.file",
            properties: fileProperties(hash),
          }),
        ),
    );
  });

  it("refuses an upsert onto a natural key", async () => {
    await expectDoorRefuses(async (writer) => {
      const sourceId = nextKey();
      await fileOf(writer, PENDING, { source_id: sourceId });
      return async (hash) =>
        verdictOf(
          await writer.createItem({
            type: "core.file",
            properties: fileProperties(hash),
            source_id: sourceId,
          }),
        );
    });
  });

  it("refuses a patch at the current version", async () => {
    await expectDoorRefuses(async (writer) => {
      const file = await fileOf(writer, PENDING);
      return async (hash) =>
        verdictOf(
          await writer.updateItem(file.id, {
            properties: { blob_ref: hash },
            version: file.version,
          }),
        );
    });
  });

  it("refuses a stale merge naming bytes its base lacked", async () => {
    await expectDoorRefuses(async (writer) => {
      const file = await movedOn(
        writer,
        { ...PENDING, title: "t" },
        { title: "moved on" },
      );
      return async (hash) =>
        verdictOf(
          await writer.rawRequest(`/items/${file.id}?conflict=auto`, {
            method: "PATCH",
            body: { properties: { blob_ref: hash }, version: file.stale },
          }),
        );
    });
  });

  it("refuses a keep-both write", async () => {
    await expectDoorRefuses(async (writer) => {
      const file = await movedOn(
        writer,
        { ...PENDING, title: "original" },
        { title: "the winner" },
      );
      return async (hash) => {
        const res = await writer.rawRequest<{
          conflict_resolution?: { strategy?: string };
        }>(`/items/${file.id}?conflict=auto`, {
          method: "PATCH",
          body: {
            properties: { title: "the loser", blob_ref: hash },
            version: file.stale,
          },
        });
        return verdictOf(res);
      };
    });
  });

  it("refuses a retype into a file type", async () => {
    await expectDoorRefuses(async (writer) => {
      const note = await writer.createItem({
        type: "core.note",
        properties: { body: "a note" },
      });
      expect(note.ok, JSON.stringify(note.error)).toBe(true);
      return async (hash) =>
        verdictOf(
          await writer.rawRequest(`/items/${note.data.item.id}`, {
            method: "PATCH",
            body: {
              type: "core.file",
              retype: true,
              properties: fileProperties(hash),
              properties_mode: "replace",
              version: note.data.item.version,
            },
          }),
        );
    });
  });

  it("refuses a bulk create's entry", async () => {
    await expectDoorRefuses(async (writer) => async (hash) => {
      const res = await writer.bulkItems({
        items: [
          {
            type: "core.file",
            properties: fileProperties(hash),
            source_id: nextKey(),
          },
        ],
        atomic: false,
      });
      expect(res.ok, JSON.stringify(res.error)).toBe(true);
      const [entry] = res.data.results;
      return entry?.outcome === "errored" ? entry.error?.code : undefined;
    });
  });

  it("refuses a bulk update's entry", async () => {
    await expectDoorRefuses(async (writer) => {
      const sourceId = nextKey();
      await fileOf(writer, PENDING, { source_id: sourceId });
      return async (hash) => {
        const res = await writer.bulkItems({
          items: [
            {
              type: "core.file",
              properties: fileProperties(hash),
              source_id: sourceId,
            },
          ],
          atomic: false,
        });
        expect(res.ok, JSON.stringify(res.error)).toBe(true);
        const [entry] = res.data.results;
        return entry?.outcome === "errored" ? entry.error?.code : undefined;
      };
    });
  });

  it("refuses a bulk action's row", async () => {
    await expectDoorRefuses(async (writer) => {
      const tag = nextKey();
      await fileOf(writer, PENDING, { tags: [tag] });
      return async (hash) => {
        const queued = await writer.bulkAction({
          action: "update_properties",
          patch: { blob_ref: hash },
          filter: { tags: [tag] },
        });
        expect(queued.status, JSON.stringify(queued.error)).toBe(202);
        const job = await writer.pollBulkActionToTerminal(
          (queued.data as BulkActionJob).id,
        );
        expect(job.status).toBe("completed");
        return job.errored === 0 ? undefined : job.result?.errors?.[0]?.code;
      };
    });
  });
});
