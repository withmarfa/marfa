import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  cleanup,
  getOperatorClient,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import { readTarGzEntry, tarGz } from "../../utils/archive.js";
import { v7 as uuidv7 } from "uuid";

let client: MarfaClient;
let operator: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "blob-reach",
  ));
  operator = getOperatorClient();
});

afterAll(async () => {
  await cleanup(ctx);
});

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

let minted = 0;

/** A key of this run's own, holding exactly the type map named. */
async function keyHolding(
  typePermissions: Record<string, string>,
): Promise<{ client: MarfaClient; id: string }> {
  minted += 1;
  const res = await client.createKey({
    label: `blob-reach-${String(minted)}`,
    source: `${ctx.source}-${String(minted)}`,
    type_permissions: typePermissions,
  });
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
  trackKey(ctx, res.data.id);
  return {
    client: new MarfaClient({ baseUrl: apiUrl, apiKey: res.data.key }),
    id: res.data.id,
  };
}

/** This run's own bytes, so no earlier run's item references them. */
async function upload(words: string): Promise<string> {
  const res = await client.uploadBlob(
    new TextEncoder().encode(`${words} ${ctx.runId}`),
    "text/plain",
  );
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.data.hash;
}

async function fileNaming(hash: string): Promise<string> {
  const res = await client.createItem({
    type: "core.file",
    source: ctx.source,
    properties: { blob_ref: hash, mime_type: "text/plain", title: "reach" },
  });
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
  trackItem(ctx, res.data.item.id);
  return res.data.item.id;
}

async function noteSaying(
  body: string,
): Promise<{ id: string; version: number }> {
  const res = await client.createItem({
    type: "core.note",
    source: ctx.source,
    properties: { body },
  });
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
  trackItem(ctx, res.data.item.id);
  return { id: res.data.item.id, version: res.data.item.version };
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
    // A HEAD answer has no body to carry a code.
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

describe("who may read and upload a blob", () => {
  it("refuses every blob door to a key whose type map reaches no type, and stores nothing it sends", async () => {
    const hash = await upload("a file the empty key must not reach");
    await fileNaming(hash);
    const empty = await keyHolding({});

    // The witness: the suite's own key reads these bytes through every door.
    expect(await readingDoors(client, hash)).toEqual(SERVED);

    expect(await readingDoors(empty.client, hash)).toEqual({
      bytes: [403, "type_not_permitted"],
      head: [403, undefined],
      link: [403, "type_not_permitted"],
      locations: [403, "type_not_permitted"],
    });
    // The same refusal for a hash nothing holds, so the refusal is not an
    // answer about the blob.
    const nowhere = `sha256:${"a".repeat(64)}`;
    expect((await empty.client.downloadBlob(nowhere)).status).toBe(403);

    const bytes = new TextEncoder().encode(`sent by an empty key ${ctx.runId}`);
    const refused = await empty.client.uploadBlob(bytes, "text/plain");
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("type_not_permitted");
    // The operator reads every blob, so its 404 says the bytes were not kept.
    expect((await operator.headBlob(sha256(bytes))).status).toBe(404);
  });

  it("answers a blob only an item of a type the key may not read references as an unknown one", async () => {
    const hash = await upload("a file a note reader must not reach");
    await fileNaming(hash);
    const noteReader = await keyHolding({ "core.note": "read" });
    const fileReader = await keyHolding({ "core.file": "read" });

    expect(await readingDoors(fileReader.client, hash)).toEqual(SERVED);
    expect(await readingDoors(noteReader.client, hash)).toEqual(UNKNOWN);

    const unknown = await noteReader.client.downloadBlob(
      `sha256:${"b".repeat(64)}`,
    );
    const hidden = await noteReader.client.downloadBlob(hash);
    expect(hidden.error?.error.message).toBe(unknown.error?.error.message);
  });

  it("serves a blob to a key that may read an item referencing it, in any lifecycle state", async () => {
    const linked = await upload("an image a note body links");
    const note = await noteSaying(`An image: ![chart](/blobs/${linked})`);
    const reader = await keyHolding({ "core.note": "read" });

    const bytes = await reader.client.downloadBlob(linked);
    expect(bytes.status).toBe(200);
    expect(new TextDecoder().decode(bytes.data)).toBe(
      `an image a note body links ${ctx.runId}`,
    );
    expect(await readingDoors(reader.client, linked)).toEqual(SERVED);

    expect((await client.transitionItem(note.id, "archived")).ok).toBe(true);
    expect(await readingDoors(reader.client, linked)).toEqual(SERVED);
    expect((await client.deleteItem(note.id)).ok).toBe(true);
    expect(await readingDoors(reader.client, linked)).toEqual(SERVED);
  });

  it("answers a blob nothing references as an unknown one, to the key that uploaded it too", async () => {
    const hash = await upload("bytes nothing names yet");
    expect(await readingDoors(client, hash)).toEqual(UNKNOWN);

    await fileNaming(hash);
    expect(await readingDoors(client, hash)).toEqual(SERVED);
  });

  it("does not serve a blob through an extension, an edge or an earlier version", async () => {
    const inExtension = await upload("named by an extension");
    const inEdge = await upload("named by an edge");
    const inVersion = await upload("named by an earlier version");

    const one = await noteSaying("one end");
    const other = await noteSaying("the other end");
    const ext = await client.setItemExtension(one.id, "blobreach", {
      cover: inExtension,
    });
    expect(ext.ok, JSON.stringify(ext.error)).toBe(true);
    const edge = await client.createEdge({
      source_id: one.id,
      target_id: other.id,
      edge_type: "about",
      properties: { cover: inEdge },
    });
    expect(edge.ok, JSON.stringify(edge.error)).toBe(true);

    const versioned = await noteSaying(`was ![it](${inVersion})`);
    expect(await readingDoors(client, inVersion)).toEqual(SERVED);
    const moved = await client.updateItem(versioned.id, {
      properties: { body: "no longer links anything" },
      version: versioned.version,
    });
    expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
    const versions = await client.getVersions(versioned.id);
    expect(JSON.stringify(versions.data)).toContain(inVersion);

    for (const hash of [inExtension, inEdge, inVersion]) {
      expect(await readingDoors(client, hash)).toEqual(UNKNOWN);
      // Held all the same, and kept by the sweep: only the read is refused.
      expect((await operator.downloadBlob(hash)).status).toBe(200);
    }

    // The witness: the same key is served each one once a property names it.
    for (const hash of [inExtension, inEdge, inVersion]) {
      await noteSaying(`now a property names ![it](${hash})`);
      expect(await readingDoors(client, hash)).toEqual(SERVED);
    }
  });

  it("lends no reach through a digest written by a key that never sent the bytes", async () => {
    const bytes = new TextEncoder().encode(`a file a note names ${ctx.runId}`);
    const hash = sha256(bytes);
    expect((await client.uploadBlob(bytes, "text/plain")).status).toBe(201);
    await fileNaming(hash);
    const noteWriter = await keyHolding({ "core.note": "write" });

    const note = await noteWriter.client.createItem({
      type: "core.note",
      properties: { body: `![it](${hash})` },
    });
    expect(note.ok, JSON.stringify(note.error)).toBe(true);
    trackItem(ctx, note.data.item.id);
    expect(await readingDoors(noteWriter.client, hash)).toEqual(UNKNOWN);

    // Sending the bytes proves holding them, which knowing the hash does
    // not, and the next write sending the digest is what lends it.
    expect(
      (await noteWriter.client.uploadBlob(bytes, "text/plain")).status,
    ).toBe(201);
    expect(await readingDoors(noteWriter.client, hash)).toEqual(UNKNOWN);
    const rewritten = await noteWriter.client.updateItem(note.data.item.id, {
      properties: { body: `![it](${hash}) again` },
      version: note.data.item.version,
    });
    expect(rewritten.ok, JSON.stringify(rewritten.error)).toBe(true);
    expect(await readingDoors(noteWriter.client, hash)).toEqual(SERVED);
  });

  it("lends through a digest written by a key that could read the blob", async () => {
    const hash = await upload("an image a second device embeds");
    await noteSaying(`![it](${hash})`);
    const device = await keyHolding({
      "core.note": "write",
      "core.bookmark": "write",
    });
    const bookmarksOnly = await keyHolding({ "core.bookmark": "read" });
    expect(await readingDoors(device.client, hash)).toEqual(SERVED);
    expect(await readingDoors(bookmarksOnly.client, hash)).toEqual(UNKNOWN);

    const bookmark = await device.client.createItem({
      type: "core.bookmark",
      properties: { url: "https://example.com/embed", title: hash },
    });
    expect(bookmark.ok, JSON.stringify(bookmark.error)).toBe(true);
    trackItem(ctx, bookmark.data.item.id);
    expect(await readingDoors(bookmarksOnly.client, hash)).toEqual(SERVED);
  });

  it("carries in an export archive only the bytes the blob doors would serve", async () => {
    const inProperty = await upload("an archive carries this");
    const inExtension = await upload("an archive leaves this, an extension");
    const inEdge = await upload("an archive leaves this, an edge");
    const named = await noteSaying(`![kept](${inProperty})`);
    const other = await noteSaying("the edge's far end");
    const ext = await client.setItemExtension(named.id, "blobreach", {
      cover: inExtension,
    });
    expect(ext.ok, JSON.stringify(ext.error)).toBe(true);
    const edge = await client.createEdge({
      source_id: named.id,
      target_id: other.id,
      edge_type: "about",
      properties: { cover: inEdge },
    });
    expect(edge.ok, JSON.stringify(edge.error)).toBe(true);

    const archive = await client.exportArchive({
      type: "core.note",
      source: ctx.source,
    });
    expect(archive.status).toBe(200);
    const manifest = JSON.parse(
      readTarGzEntry(archive.data, "manifest.json") ?? "{}",
    ) as { blobs: Record<string, unknown> };
    expect(Object.keys(manifest.blobs)).toContain(inProperty);
    expect(Object.keys(manifest.blobs)).not.toContain(inExtension);
    expect(Object.keys(manifest.blobs)).not.toContain(inEdge);
    expect(readTarGzEntry(archive.data, `blobs/${inProperty}`)).not.toBeNull();
    expect(readTarGzEntry(archive.data, `blobs/${inEdge}`)).toBeNull();
  });

  it("restores a row's reach only for the digests its archive line says lent", async () => {
    const lent = new TextEncoder().encode(`restored and lent ${ctx.runId}`);
    const unlent = new TextEncoder().encode(
      `restored, lent nothing ${ctx.runId}`,
    );
    const lines = [
      { id: uuidv7(), lends: true, data: lent },
      { id: uuidv7(), lends: false, data: unlent },
    ];
    const archive = tarGz([
      {
        name: "manifest.json",
        body: JSON.stringify({
          version: 0,
          format: "marfa-archive-v0",
          created_at: new Date().toISOString(),
          item_count: 2,
          edge_count: 0,
          blob_count: 2,
          type_count: 0,
          edge_type_count: 0,
          blobs: Object.fromEntries(
            lines.map((line) => [
              sha256(line.data),
              { mime_type: "text/plain", size_bytes: line.data.length },
            ]),
          ),
        }),
      },
      {
        name: "items.ndjson",
        body: lines
          .map((line) =>
            JSON.stringify({
              item: {
                id: line.id,
                type: "core.note",
                source: ctx.source,
                properties: { body: `![it](${sha256(line.data)})` },
              },
              metadata: { tags: [], extensions: {} },
              ...(line.lends && { lending_blobs: [sha256(line.data)] }),
            }),
          )
          .join("\n")
          .concat("\n"),
      },
      ...lines.map((line) => ({
        name: `blobs/${sha256(line.data)}`,
        body: line.data,
      })),
      { name: "edges.ndjson", body: "" },
      { name: "types.ndjson", body: "" },
    ]);
    const restored = await operator.restoreArchive(archive);
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    for (const line of lines) trackItem(ctx, line.id);

    expect(await readingDoors(client, sha256(lent))).toEqual(SERVED);
    expect(await readingDoors(client, sha256(unlent))).toEqual(UNKNOWN);
    expect((await operator.downloadBlob(sha256(unlent))).status).toBe(200);
  });

  it("refuses an upload to a key that may write no registered type, and takes one from a key that writes one", async () => {
    const reader = await keyHolding({ "*": "read" });
    const unregistered = await keyHolding({
      "user.nothing-registered": "write",
    });
    const writer = await keyHolding({ "core.note": "write" });
    const bytes = new TextEncoder().encode(`an upload ${ctx.runId}`);

    for (const narrow of [reader, unregistered]) {
      const refused = await narrow.client.uploadBlob(bytes, "text/plain");
      expect(refused.status).toBe(403);
      expect(refused.error?.error.code).toBe("type_not_permitted");
    }

    const taken = await writer.client.uploadBlob(bytes, "text/plain");
    expect(taken.status, JSON.stringify(taken.error)).toBe(201);
  });

  it("serves the operator key every blob and takes its uploads", async () => {
    const hash = await upload("bytes the operator reads unreferenced");
    expect(await readingDoors(operator, hash)).toEqual(SERVED);

    const res = await operator.uploadBlob(
      new TextEncoder().encode(`uploaded by the operator ${ctx.runId}`),
      "text/plain",
    );
    expect(res.status, JSON.stringify(res.error)).toBe(201);
  });

  it("keeps a minted link working after the key that minted it is revoked", async () => {
    const hash = await upload("bytes behind a link outliving its key");
    await fileNaming(hash);
    const reader = await keyHolding({ "core.file": "read" });
    const link = await reader.client.getBlobUrl(hash, 120);
    expect(link.status).toBe(200);

    expect((await client.revokeKey(reader.id)).ok).toBe(true);
    expect((await reader.client.getBlobUrl(hash)).status).toBe(401);

    const fetched = await fetch(link.data.url);
    expect(fetched.status).toBe(200);
    expect(await fetched.text()).toBe(
      `bytes behind a link outliving its key ${ctx.runId}`,
    );
  });
});
