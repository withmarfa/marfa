import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { MarfaClient } from "../../client/api.js";
import type { BulkActionJob, TestContext } from "../../client/types.js";
import {
  createTestContext,
  cleanup,
  getOperatorClient,
  trackFolder,
  trackItem,
  trackKey,
  trackType,
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

/** A key of this run's own, holding exactly the maps named. */
async function keyHolding(
  typePermissions: Record<string, string>,
  more: {
    edge_permissions?: Record<string, string>;
    extension_permissions?: Record<string, string>;
  } = {},
): Promise<{ client: MarfaClient; id: string }> {
  minted += 1;
  const res = await client.createKey({
    label: `blob-reach-${String(minted)}`,
    source: `${ctx.source}-${String(minted)}`,
    type_permissions: typePermissions,
    ...more,
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

  it("does not serve a blob through an earlier version", async () => {
    const inVersion = await upload("named by an earlier version");
    const versioned = await noteSaying(`was ![it](${inVersion})`);
    expect(await readingDoors(client, inVersion)).toEqual(SERVED);
    const moved = await client.updateItem(versioned.id, {
      properties: { body: "no longer links anything" },
      version: versioned.version,
    });
    expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
    const versions = await client.getVersions(versioned.id);
    expect(JSON.stringify(versions.data)).toContain(inVersion);

    expect(await readingDoors(client, inVersion)).toEqual(UNKNOWN);
    // Held all the same, and kept by the sweep: only the read is refused.
    expect((await operator.downloadBlob(inVersion)).status).toBe(200);

    // The witness: the same key is served it once a property names it.
    await noteSaying(`now a property names ![it](${inVersion})`);
    expect(await readingDoors(client, inVersion)).toEqual(SERVED);
  });

  it("serves a blob named only in an edge's properties to a key that reads the edge, and to no other", async () => {
    const hash = await upload("named only by an edge");
    const source = await noteSaying("an edge's source");
    const target = await noteSaying("an edge's target");
    const edgeReader = await keyHolding(
      { "core.note": "read" },
      { edge_permissions: { about: "read" } },
    );
    const noEdges = await keyHolding({ "core.note": "read" });
    const otherEdges = await keyHolding(
      { "core.note": "read" },
      { edge_permissions: { references: "read" } },
    );
    const wrongSourceType = await keyHolding(
      { "core.file": "read" },
      { edge_permissions: { about: "read" } },
    );

    // The witness: the bytes are held, and nothing yet names them.
    expect((await operator.downloadBlob(hash)).status).toBe(200);
    expect(await readingDoors(client, hash)).toEqual(UNKNOWN);
    expect(await readingDoors(edgeReader.client, hash)).toEqual(UNKNOWN);

    const edge = await client.createEdge({
      source_id: source.id,
      target_id: target.id,
      edge_type: "about",
      properties: { cover: hash },
    });
    expect(edge.ok, JSON.stringify(edge.error)).toBe(true);

    expect(await readingDoors(client, hash)).toEqual(SERVED);
    expect(await readingDoors(edgeReader.client, hash)).toEqual(SERVED);
    expect(await readingDoors(noEdges.client, hash)).toEqual(UNKNOWN);
    expect(await readingDoors(otherEdges.client, hash)).toEqual(UNKNOWN);
    expect(await readingDoors(wrongSourceType.client, hash)).toEqual(UNKNOWN);

    expect((await client.deleteEdge(edge.data.edge.id)).ok).toBe(true);
    expect(await readingDoors(edgeReader.client, hash)).toEqual(UNKNOWN);
    expect((await operator.downloadBlob(hash)).status).toBe(200);
  });

  it("serves a blob named only in an extension to a key that reads the namespace, and to no other", async () => {
    const hash = await upload("named only by an extension");
    const item = await noteSaying("an extension's item");
    const namespace = `blobreach.${ctx.runId}`;
    const namespaceReader = await keyHolding(
      { "core.note": "read" },
      { extension_permissions: { [namespace]: "read" } },
    );
    const otherNamespace = await keyHolding(
      { "core.note": "read" },
      { extension_permissions: { elsewhere: "read" } },
    );
    const noExtensions = await keyHolding({ "core.note": "read" });
    const wrongItemType = await keyHolding(
      { "core.file": "read" },
      { extension_permissions: { [namespace]: "read" } },
    );

    expect((await operator.downloadBlob(hash)).status).toBe(200);
    expect(await readingDoors(namespaceReader.client, hash)).toEqual(UNKNOWN);

    const written = await client.setItemExtension(item.id, namespace, {
      cover: hash,
    });
    expect(written.ok, JSON.stringify(written.error)).toBe(true);

    expect(await readingDoors(client, hash)).toEqual(SERVED);
    expect(await readingDoors(namespaceReader.client, hash)).toEqual(SERVED);
    expect(await readingDoors(otherNamespace.client, hash)).toEqual(UNKNOWN);
    expect(await readingDoors(noExtensions.client, hash)).toEqual(UNKNOWN);
    expect(await readingDoors(wrongItemType.client, hash)).toEqual(UNKNOWN);

    // Replacing the namespace without the digest withdraws the reach.
    const replaced = await client.setItemExtension(item.id, namespace, {
      cover: "none",
    });
    expect(replaced.ok, JSON.stringify(replaced.error)).toBe(true);
    expect(await readingDoors(namespaceReader.client, hash)).toEqual(UNKNOWN);
    const again = await client.setItemExtension(item.id, namespace, {
      cover: hash,
    });
    expect(again.ok, JSON.stringify(again.error)).toBe(true);
    expect(await readingDoors(namespaceReader.client, hash)).toEqual(SERVED);
    expect((await client.deleteItemExtension(item.id, namespace)).ok).toBe(
      true,
    );
    expect(await readingDoors(namespaceReader.client, hash)).toEqual(UNKNOWN);
    expect((await operator.downloadBlob(hash)).status).toBe(200);
  });

  it("lends through an edge or an extension only a digest its writer proved", async () => {
    const edgeDigest = await upload("an edge writer without the bytes plants");
    const extensionDigest = await upload("an extension writer plants");
    const source = await noteSaying("a planted edge's source");
    const target = await noteSaying("a planted edge's target");
    const bare = await keyHolding(
      { "core.note": "write" },
      {
        edge_permissions: { about: "write" },
        extension_permissions: { "*": "write" },
      },
    );
    const namespace = `planted.${ctx.runId}`;

    const edge = await bare.client.createEdge({
      source_id: source.id,
      target_id: target.id,
      edge_type: "about",
      properties: { cover: edgeDigest },
    });
    expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
    const planted = await bare.client.setItemExtension(source.id, namespace, {
      cover: extensionDigest,
    });
    expect(planted.ok, JSON.stringify(planted.error)).toBe(true);
    // The suite's key reads every blob an item names, and these were written
    // by a key that neither sent the bytes nor could read them.
    expect(await readingDoors(client, edgeDigest)).toEqual(UNKNOWN);
    expect(await readingDoors(client, extensionDigest)).toEqual(UNKNOWN);

    // Written again by the suite's key, the same digest is the same
    // reference as before and stays dead.
    const patched = await client.updateEdge(edge.data.edge.id, {
      properties: { cover: edgeDigest, title: "retitled" },
      version: edge.data.edge.version,
    });
    expect(patched.ok, JSON.stringify(patched.error)).toBe(true);
    const rewritten = await client.setItemExtension(source.id, namespace, {
      cover: extensionDigest,
      title: "retitled",
    });
    expect(rewritten.ok, JSON.stringify(rewritten.error)).toBe(true);
    expect(await readingDoors(client, edgeDigest)).toEqual(UNKNOWN);
    expect(await readingDoors(client, extensionDigest)).toEqual(UNKNOWN);

    // Dropped and written anew with the proof, each lends.
    const droppedEdge = await client.updateEdge(edge.data.edge.id, {
      properties: { cover: "none" },
      version: patched.data.edge.version,
    });
    expect(droppedEdge.ok, JSON.stringify(droppedEdge.error)).toBe(true);
    const droppedExtension = await client.setItemExtension(
      source.id,
      namespace,
      {
        cover: "none",
      },
    );
    expect(droppedExtension.ok, JSON.stringify(droppedExtension.error)).toBe(
      true,
    );
    const fresh = await client.updateEdge(edge.data.edge.id, {
      properties: { cover: edgeDigest },
      version: droppedEdge.data.edge.version,
    });
    expect(fresh.ok, JSON.stringify(fresh.error)).toBe(true);
    const freshExtension = await client.setItemExtension(source.id, namespace, {
      cover: extensionDigest,
    });
    expect(freshExtension.ok, JSON.stringify(freshExtension.error)).toBe(true);
    expect(await readingDoors(client, edgeDigest)).toEqual(SERVED);
    expect(await readingDoors(client, extensionDigest)).toEqual(SERVED);
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

    // Written without proof, the digest stays dead while the note names it,
    // even once the key sends the bytes and writes it again. Dropping it and
    // writing it anew with the proof is what lends it.
    expect(
      (await noteWriter.client.uploadBlob(bytes, "text/plain")).status,
    ).toBe(201);
    const again = await noteWriter.client.updateItem(note.data.item.id, {
      properties: { body: `![it](${hash}) again` },
      version: note.data.item.version,
    });
    expect(again.ok, JSON.stringify(again.error)).toBe(true);
    expect(await readingDoors(noteWriter.client, hash)).toEqual(UNKNOWN);
    const dropped = await noteWriter.client.updateItem(note.data.item.id, {
      properties: { body: "nothing linked" },
      version: again.data.item.version,
    });
    expect(dropped.ok, JSON.stringify(dropped.error)).toBe(true);
    const rewritten = await noteWriter.client.updateItem(note.data.item.id, {
      properties: { body: `![it](${hash})` },
      version: dropped.data.item.version,
    });
    expect(rewritten.ok, JSON.stringify(rewritten.error)).toBe(true);
    expect(await readingDoors(noteWriter.client, hash)).toEqual(SERVED);
  });

  it("keeps a planted digest dead when a key holding every blob edits the note", async () => {
    const hash = await upload("a private file a note will plant");
    await fileNaming(hash);
    const planter = await keyHolding({ "core.note": "write" });
    const planted = await planter.client.createItem({
      type: "core.note",
      properties: { body: `a typo ![it](${hash})` },
    });
    expect(planted.ok, JSON.stringify(planted.error)).toBe(true);
    trackItem(ctx, planted.data.item.id);
    expect(await readingDoors(planter.client, hash)).toEqual(UNKNOWN);

    // The suite's key, which reads every blob, fixes the typo and sends the
    // body with the hash still in it.
    const fixed = await client.updateItem(planted.data.item.id, {
      properties: { body: `a fixed typo ![it](${hash})` },
      version: planted.data.item.version,
    });
    expect(fixed.ok, JSON.stringify(fixed.error)).toBe(true);
    expect(await readingDoors(client, hash)).toEqual(SERVED);
    expect(await readingDoors(planter.client, hash)).toEqual(UNKNOWN);
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
    const inExtension = await upload("an archive carries this, an extension");
    const inEdge = await upload("an archive carries this, an edge");
    const inPlantedExtension = await upload(
      "an archive leaves this, a planted extension",
    );
    const inPlantedEdge = await upload(
      "an archive leaves this, a planted edge",
    );
    const named = await noteSaying(`![kept](${inProperty})`);
    const other = await noteSaying("the edge's far end");
    const another = await noteSaying("the planted edge's far end");
    const namespace = `blobreach.${ctx.runId}`;
    const planter = await keyHolding(
      { "core.note": "write" },
      {
        edge_permissions: { about: "write" },
        extension_permissions: { [namespace]: "write" },
      },
    );
    const written = [
      await client.setItemExtension(named.id, namespace, {
        cover: inExtension,
      }),
      await client.createEdge({
        source_id: named.id,
        target_id: other.id,
        edge_type: "about",
        properties: { cover: inEdge },
      }),
      await planter.client.createEdge({
        source_id: named.id,
        target_id: another.id,
        edge_type: "about",
        properties: { cover: inPlantedEdge },
      }),
      await planter.client.setItemExtension(other.id, namespace, {
        cover: inPlantedExtension,
      }),
    ];
    for (const res of written)
      expect(res.ok, JSON.stringify(res.error)).toBe(true);

    const archive = await client.exportArchive({
      type: "core.note",
      source: ctx.source,
    });
    expect(archive.status).toBe(200);
    const manifest = JSON.parse(
      readTarGzEntry(archive.data, "manifest.json") ?? "{}",
    ) as { blobs: Record<string, unknown> };
    for (const hash of [inProperty, inExtension, inEdge]) {
      expect(Object.keys(manifest.blobs)).toContain(hash);
      expect(readTarGzEntry(archive.data, `blobs/${hash}`)).not.toBeNull();
    }
    for (const hash of [inPlantedExtension, inPlantedEdge]) {
      // The witness: the instance holds the bytes, and the archive leaves
      // them out because the key was never served them.
      expect((await operator.downloadBlob(hash)).status).toBe(200);
      expect(Object.keys(manifest.blobs)).not.toContain(hash);
      expect(readTarGzEntry(archive.data, `blobs/${hash}`)).toBeNull();
    }
  });

  it("carries the bytes an edge and an extension lend, and restores the same answers", async () => {
    const viaEdge = await upload("an archive restores this, an edge");
    const viaExtension = await upload("an archive restores this, an extension");
    const source = await noteSaying("the archived edge's source");
    const target = await noteSaying("the archived edge's target");
    const namespace = `blobreach.${ctx.runId}`;
    const edgeReader = await keyHolding(
      { "core.note": "read" },
      { edge_permissions: { about: "read" } },
    );
    const namespaceReader = await keyHolding(
      { "core.note": "read" },
      { extension_permissions: { [namespace]: "read" } },
    );
    const neither = await keyHolding({ "core.note": "read" });
    const edge = await client.createEdge({
      source_id: source.id,
      target_id: target.id,
      edge_type: "about",
      properties: { cover: viaEdge },
    });
    expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
    const extension = await client.setItemExtension(source.id, namespace, {
      cover: viaExtension,
    });
    expect(extension.ok, JSON.stringify(extension.error)).toBe(true);

    // A working key's archive: it reads the notes, the edge and the
    // namespace, so it is served both blobs.
    const exporter = await keyHolding(
      { "core.note": "read" },
      {
        edge_permissions: { about: "read" },
        extension_permissions: { [namespace]: "read" },
      },
    );
    expect(await readingDoors(exporter.client, viaEdge)).toEqual(SERVED);
    expect(await readingDoors(exporter.client, viaExtension)).toEqual(SERVED);
    const archive = await exporter.client.exportArchive({
      type: "core.note",
      source: ctx.source,
    });
    expect(archive.status).toBe(200);
    for (const hash of [viaEdge, viaExtension]) {
      expect(readTarGzEntry(archive.data, `blobs/${hash}`)).not.toBeNull();
    }

    // Take the rows away, which withdraws both reaches, and restore them.
    expect((await client.deleteEdge(edge.data.edge.id)).ok).toBe(true);
    expect((await client.deleteItemExtension(source.id, namespace)).ok).toBe(
      true,
    );
    expect(await readingDoors(edgeReader.client, viaEdge)).toEqual(UNKNOWN);
    expect(await readingDoors(namespaceReader.client, viaExtension)).toEqual(
      UNKNOWN,
    );
    for (const id of [source.id, target.id]) {
      expect((await client.deleteItem(id)).ok).toBe(true);
      expect((await client.purgeItem(id)).ok).toBe(true);
    }
    const restored = await operator.restoreArchive(archive.data);
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    trackItem(ctx, source.id);
    trackItem(ctx, target.id);

    expect(await readingDoors(edgeReader.client, viaEdge)).toEqual(SERVED);
    expect(await readingDoors(namespaceReader.client, viaExtension)).toEqual(
      SERVED,
    );
    expect(await readingDoors(neither.client, viaEdge)).toEqual(UNKNOWN);
    expect(await readingDoors(neither.client, viaExtension)).toEqual(UNKNOWN);
    expect(await readingDoors(edgeReader.client, viaExtension)).toEqual(
      UNKNOWN,
    );
    expect(await readingDoors(namespaceReader.client, viaEdge)).toEqual(
      UNKNOWN,
    );
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

    // The one repair: the owner sends the bytes, drops the digest from the
    // row, and writes it again. Rewriting it in place changes nothing.
    expect((await client.uploadBlob(unlent, "text/plain")).status).toBe(201);
    const row = await client.getItem(lines[1]!.id);
    expect(row.ok, JSON.stringify(row.error)).toBe(true);
    const inPlace = await client.updateItem(lines[1]!.id, {
      properties: { body: `![it](${sha256(unlent)}) in place` },
      version: row.data.item.version,
    });
    expect(inPlace.ok, JSON.stringify(inPlace.error)).toBe(true);
    expect(await readingDoors(client, sha256(unlent))).toEqual(UNKNOWN);
    const dropped = await client.updateItem(lines[1]!.id, {
      properties: { body: "nothing linked" },
      version: inPlace.data.item.version,
    });
    expect(dropped.ok, JSON.stringify(dropped.error)).toBe(true);
    const repaired = await client.updateItem(lines[1]!.id, {
      properties: { body: `![it](${sha256(unlent)})` },
      version: dropped.data.item.version,
    });
    expect(repaired.ok, JSON.stringify(repaired.error)).toBe(true);
    expect(await readingDoors(client, sha256(unlent))).toEqual(SERVED);
  });

  it("credits a stale write only for digests its base version lacked", async () => {
    const hash = await upload("a secret a stale edit echoes");
    await fileNaming(hash);
    const planter = await keyHolding({ "core.note": "write" });
    const planted = await planter.client.createItem({
      type: "core.note",
      properties: { body: `a typo ![it](${hash})` },
    });
    expect(planted.ok, JSON.stringify(planted.error)).toBe(true);
    trackItem(ctx, planted.data.item.id);
    // The suite's key holds this version; the planter then removes the hash.
    const removed = await planter.client.updateItem(planted.data.item.id, {
      properties: { body: "nothing here" },
      version: planted.data.item.version,
    });
    expect(removed.ok, JSON.stringify(removed.error)).toBe(true);

    // The suite's edit, made on the old version, still carries the hash.
    const stale = await client.rawRequest<{ item: { id: string } }>(
      `/items/${planted.data.item.id}?conflict=auto`,
      {
        method: "PATCH",
        body: {
          properties: { body: `a fixed typo ![it](${hash})` },
          version: planted.data.item.version,
        },
      },
    );
    expect(stale.ok, JSON.stringify(stale.error)).toBe(true);
    const own = await planter.client.getCurrentKey();
    expect(own.ok, JSON.stringify(own.error)).toBe(true);
    const notes = await client.listItems({
      type: "core.note",
      source: own.data.source,
      limit: 200,
    });
    expect(
      notes.data.data.some((row) =>
        JSON.stringify(row.properties).includes(hash.slice("sha256:".length)),
      ),
    ).toBe(true);
    expect(await readingDoors(planter.client, hash)).toEqual(UNKNOWN);
  });

  it("keeps a planted digest dead through an export, a purge and a restore", async () => {
    const hash = await upload("a private file an archive carries planted");
    await fileNaming(hash);
    const planter = await keyHolding({ "core.note": "write" });
    const planted = await planter.client.createItem({
      type: "core.note",
      properties: { body: `![it](${hash})` },
    });
    expect(planted.ok, JSON.stringify(planted.error)).toBe(true);
    const id = planted.data.item.id;
    trackItem(ctx, id);
    const own = await planter.client.getCurrentKey();
    expect(own.ok, JSON.stringify(own.error)).toBe(true);

    const archive = await client.exportArchive({
      type: "core.note",
      state: "any",
      source: own.data.source,
    });
    expect(archive.status).toBe(200);
    expect((await client.deleteItem(id)).ok).toBe(true);
    expect((await client.purgeItem(id)).ok).toBe(true);
    const restored = await operator.restoreArchive(archive.data);
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    expect(await readingDoors(planter.client, hash)).toEqual(UNKNOWN);

    // The suite's key, which reads every blob, edits the restored note.
    const back = await client.getItem(id);
    expect(back.ok, JSON.stringify(back.error)).toBe(true);
    const edited = await client.updateItem(id, {
      properties: { body: `![it](${hash}) edited` },
      version: back.data.item.version,
    });
    expect(edited.ok, JSON.stringify(edited.error)).toBe(true);
    expect(await readingDoors(planter.client, hash)).toEqual(UNKNOWN);
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

  it("refuses an upload under a grant that names no registered type, and takes one once a type is registered under it", async () => {
    const namespace = `fixture.${ctx.runId}.later`;
    const pattern = await keyHolding({ [`${namespace}.*`]: "write" });
    const system = await keyHolding({
      "system.folder": "write",
      "core.note": "read",
    });
    const systemWildcard = await keyHolding({ "system.*": "write" });
    const writer = await keyHolding({ "core.note": "write" });

    const attempt = async (as: MarfaClient, words: string) => {
      const bytes = new TextEncoder().encode(`${words} ${ctx.runId}`);
      return { bytes, res: await as.uploadBlob(bytes, "text/plain") };
    };
    // The witness: a key that writes a registered type is taken.
    expect((await attempt(writer.client, "taken")).res.status).toBe(201);

    for (const [name, refused] of [
      ["a pattern naming no type", pattern],
      ["a system type", system],
      ["every system type", systemWildcard],
    ] as const) {
      const { bytes, res } = await attempt(refused.client, `refused ${name}`);
      expect(res.status, name).toBe(403);
      expect(res.error?.error.code, name).toBe("type_not_permitted");
      expect((await operator.headBlob(sha256(bytes))).status, name).toBe(404);
    }

    const registered = await client.registerType({
      id: `${namespace}.kind`,
      fields: {},
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    trackType(ctx, `${namespace}.kind`);
    const later = await attempt(pattern.client, "taken once registered");
    expect(later.res.status, JSON.stringify(later.res.error)).toBe(201);
    // A grant on a system type still writes nothing registered.
    expect((await attempt(system.client, "still refused")).res.status).toBe(
      403,
    );
  });

  it("refuses a key that may not upload before it reads the body it sent", async () => {
    const reader = await keyHolding({ "core.note": "read" });
    const writer = await keyHolding({ "core.note": "write" });
    const bodies = [
      ["multipart/form-data", new TextEncoder().encode(`a form ${ctx.runId}`)],
      ["text/plain", new Uint8Array(0)],
    ] as const;
    for (const [type, body] of bodies) {
      // The witness: a key that may upload is told what is wrong with it.
      const told = await writer.client.uploadBlob(body, type);
      expect(told.status, type).toBe(400);
      expect(told.error?.error.code, type).toBe("validation_error");

      const refused = await reader.client.uploadBlob(body, type);
      expect(refused.status, type).toBe(403);
      expect(refused.error?.error.code, type).toBe("type_not_permitted");
    }
  });

  it("refuses the operator key an export and takes a working key's", async () => {
    await noteSaying("an export the operator may not make");
    const reader = await keyHolding({ "core.note": "read" });
    for (const format of ["ndjson", "archive"]) {
      const res = await operator.rawRequest(`/export?format=${format}`);
      expect(res.status, format).toBe(403);
      expect(res.error?.error.code, format).toBe("type_not_permitted");
    }
    const archive = await reader.client.exportArchive({
      type: "core.note",
      source: ctx.source,
    });
    expect(archive.status).toBe(200);
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

  it("answers a key whose type map names only an unregistered type as it answers an unknown blob, and refuses it the upload", async () => {
    const hash = await upload("a file an unregistered-type key must not reach");
    await fileNaming(hash);
    const reads = await keyHolding({ "user.nothing-registered": "read" });
    const writes = await keyHolding({ "user.nothing-registered": "write" });
    const empty = await keyHolding({});

    // The witnesses: the suite's key is served, and a key with no pattern at
    // all is refused, so the answers below are the map's and not the blob's.
    expect(await readingDoors(client, hash)).toEqual(SERVED);
    expect((await readingDoors(empty.client, hash)).bytes).toEqual([
      403,
      "type_not_permitted",
    ]);

    // A pattern is a pattern whether or not a type matches it: the key
    // reaches a type, and is told what any key that may not read the blob is.
    expect(await readingDoors(reads.client, hash)).toEqual(UNKNOWN);
    expect(await readingDoors(writes.client, hash)).toEqual(UNKNOWN);

    // An upload is stricter: it takes write on a type that is registered.
    const bytes = new TextEncoder().encode(
      `an unregistered write ${ctx.runId}`,
    );
    const refused = await writes.client.uploadBlob(bytes, "text/plain");
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("type_not_permitted");
  });

  it("serves the operator key the blob doors although it holds no type map", async () => {
    const own = await operator.getCurrentKey();
    expect(own.status, JSON.stringify(own.error)).toBe(200);
    // The witness: a working key with the same empty map is refused.
    expect(own.data.type_permissions ?? {}).toEqual({});
    const empty = await keyHolding({});
    const unknown = `sha256:${"c".repeat(64)}`;
    expect((await empty.client.downloadBlob(unknown)).status).toBe(403);

    // Refused nothing for its map, the operator key reaches the lookup, and
    // a hash nothing holds is an unknown one.
    expect(await readingDoors(operator, unknown)).toEqual(UNKNOWN);
    const malformed = await operator.downloadBlob("not-a-hash");
    expect(malformed.status).toBe(400);
    expect(malformed.error?.error.code).toBe("validation_error");
  });

  it("refuses a key reaching no type the code on every blob door and the status on HEAD, for an unknown and a malformed hash alike", async () => {
    const held = await upload("bytes the empty key asks about");
    await fileNaming(held);
    const empty = await keyHolding({});
    const refused = ["type_not_permitted", 403] as const;
    const unknown = `sha256:${"d".repeat(64)}`;

    // The witness: the suite's key is served the held blob and told 400 for
    // the malformed hash, so each 403 below is the key's and not the hash's.
    expect(await readingDoors(client, held)).toEqual(SERVED);
    expect((await client.downloadBlob("not-a-hash")).status).toBe(400);

    for (const hash of [held, unknown, "not-a-hash"]) {
      const bytes = await empty.client.downloadBlob(hash);
      expect(bytes.status, `GET ${hash}`).toBe(refused[1]);
      expect(bytes.error?.error.code, `GET ${hash}`).toBe(refused[0]);
      expect((await empty.client.headBlob(hash)).status, `HEAD ${hash}`).toBe(
        refused[1],
      );
      const link = await empty.client.getBlobUrl(hash);
      expect(link.status, `url ${hash}`).toBe(refused[1]);
      expect(link.error?.error.code, `url ${hash}`).toBe(refused[0]);
      const locations = await empty.client.listBlobLocations(hash);
      expect(locations.status, `locations ${hash}`).toBe(refused[1]);
      expect(locations.error?.error.code, `locations ${hash}`).toBe(refused[0]);
    }
  });
});

/**
 * A door that writes properties, named by what it does once it is handed a
 * writer: it prepares whatever row that writer needs, and answers the write
 * that names a digest through the door.
 */
type Door = (writer: MarfaClient) => Promise<(hash: string) => Promise<void>>;

let doors = 0;
let prepared = 0;

function succeeded(res: { ok: boolean; error?: unknown }): void {
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
}

/**
 * Holds one door to the rule that a reference lends when the writer sent the
 * bytes: a writer that neither sent them nor can read them names the digest
 * through the door and lends nothing, and the writer that sent them names it
 * through the same door and lends, so the credit is the proof's and not the
 * door's.
 */
async function expectDoorCredits(door: Door): Promise<void> {
  doors += 1;
  const writes = { "core.note": "write", "core.bookmark": "write" };
  const sender = await keyHolding(writes);
  const stranger = await keyHolding(writes);
  const reader = await keyHolding({ "*": "read" });
  const sent = await sender.client.uploadBlob(
    new TextEncoder().encode(
      `named through a door ${String(doors)} ${ctx.runId}`,
    ),
    "text/plain",
  );
  expect(sent.status, JSON.stringify(sent.error)).toBe(201);
  const hash = sent.data.hash;

  const nameAsSender = await door(sender.client);
  const nameAsStranger = await door(stranger.client);
  // The witness: held, and nothing names it yet.
  expect(await readingDoors(reader.client, hash)).toEqual(UNKNOWN);
  expect((await operator.headBlob(hash)).status).toBe(200);

  await nameAsStranger(hash);
  expect(await readingDoors(reader.client, hash)).toEqual(UNKNOWN);
  await nameAsSender(hash);
  expect(await readingDoors(reader.client, hash)).toEqual(SERVED);

  // Rows these keys wrote, a keep-both sibling and a bulk create among them,
  // are cleaned up with the file's.
  for (const writer of [sender, stranger]) {
    const own = await writer.client.getCurrentKey();
    succeeded(own);
    const rows = await client.listItems({
      source: own.data.source,
      limit: 200,
    });
    for (const row of rows.data.data) trackItem(ctx, row.id);
  }
}

const bodyNaming = (hash: string) => `![x](${hash})`;

async function noteOf(
  writer: MarfaClient,
  properties: Record<string, unknown>,
  extra: { source_id?: string; tags?: string[] } = {},
): Promise<{ id: string; version: number }> {
  const res = await writer.createItem({
    type: "core.note",
    properties,
    ...extra,
  });
  succeeded(res);
  return { id: res.data.item.id, version: res.data.item.version };
}

/** A note moved on from version 1, so a write based on 1 is stale. */
async function movedOn(
  writer: MarfaClient,
  first: Record<string, unknown>,
  second: Record<string, unknown>,
): Promise<{ id: string; stale: number }> {
  const note = await noteOf(writer, first);
  succeeded(
    await writer.updateItem(note.id, {
      properties: second,
      version: note.version,
    }),
  );
  return { id: note.id, stale: note.version };
}

describe("which write that names a digest lends it", () => {
  it("lends a digest named by a new item only when its writer sent the bytes", async () => {
    await expectDoorCredits(async (writer) => async (hash) => {
      await noteOf(writer, { body: bodyNaming(hash) });
    });
  });

  it("lends a digest named by an upsert onto a natural key only when its writer sent the bytes", async () => {
    await expectDoorCredits(async (writer) => {
      const sourceId = `upsert-${String(doors)}-${ctx.runId}`;
      await noteOf(writer, { body: "first" }, { source_id: sourceId });
      return async (hash) => {
        succeeded(
          await writer.createItem({
            type: "core.note",
            properties: { body: bodyNaming(hash) },
            source_id: sourceId,
          }),
        );
      };
    });
  });

  it("lends a digest named by a patch at the current version only when its writer sent the bytes", async () => {
    await expectDoorCredits(async (writer) => {
      const note = await noteOf(writer, { body: "plain" });
      return async (hash) => {
        succeeded(
          await writer.updateItem(note.id, {
            properties: { body: bodyNaming(hash) },
            version: note.version,
          }),
        );
      };
    });
  });

  it("lends a digest new to the base of a stale merge only when its writer sent the bytes", async () => {
    await expectDoorCredits(async (writer) => {
      const note = await movedOn(
        writer,
        { title: "t", body: "b" },
        { title: "t", body: "moved on" },
      );
      return async (hash) => {
        succeeded(
          await writer.rawRequest(`/items/${note.id}?conflict=auto`, {
            method: "PATCH",
            body: {
              properties: { title: bodyNaming(hash) },
              version: note.stale,
            },
          }),
        );
      };
    });
  });

  it("lends a digest named by a keep-both write only when its writer sent the bytes", async () => {
    await expectDoorCredits(async (writer) => {
      const note = await movedOn(
        writer,
        { body: "original" },
        { body: "the winner" },
      );
      return async (hash) => {
        succeeded(
          await writer.rawRequest(`/items/${note.id}?conflict=auto`, {
            method: "PATCH",
            body: {
              properties: { body: `the loser ${bodyNaming(hash)}` },
              version: note.stale,
            },
          }),
        );
        // The write the winner left stands, and the digest is on the
        // sibling the loser's copy went to.
        const row = await writer.getItem(note.id);
        succeeded(row);
        expect(JSON.stringify(row.data.item.properties)).not.toContain(
          hash.slice("sha256:".length),
        );
      };
    });
  });

  it("lends a digest named by a retype only when its writer sent the bytes", async () => {
    await expectDoorCredits(async (writer) => {
      const note = await noteOf(writer, { body: "a note" });
      return async (hash) => {
        succeeded(
          await writer.rawRequest(`/items/${note.id}`, {
            method: "PATCH",
            body: {
              type: "core.bookmark",
              retype: true,
              properties: {
                url: "https://example.com/retyped",
                title: bodyNaming(hash),
              },
              properties_mode: "replace",
              version: note.version,
            },
          }),
        );
      };
    });
  });

  it("keeps each digest on a keep-both copy as it stood on the item", async () => {
    const lending = await upload("a keep-both copy keeps this lending");
    const planted = await upload("a keep-both copy keeps this dead");
    const bare = await keyHolding({ "core.note": "write" });
    const reader = await keyHolding({ "core.note": "read" });
    const note = await noteSaying("the note a stale write forks");
    const titled = await client.updateItem(note.id, {
      properties: { title: lending },
      version: note.version,
    });
    succeeded(titled);
    const named = await bare.client.updateItem(note.id, {
      properties: { body: bodyNaming(planted) },
      version: titled.data.item.version,
    });
    succeeded(named);
    const base = named.data.item.version;
    expect(await readingDoors(reader.client, lending)).toEqual(SERVED);
    expect(await readingDoors(reader.client, planted)).toEqual(UNKNOWN);

    // The winner drops the planted digest; the stale write that collides
    // with it echoes the planted digest, and both land on the copy.
    succeeded(
      await client.updateItem(note.id, {
        properties: { body: "the winner" },
        version: base,
      }),
    );
    const forked = await client.rawRequest<{
      conflict_resolution?: { conflicted_copy_id?: string };
    }>(`/items/${note.id}?conflict=auto`, {
      method: "PATCH",
      body: {
        properties: { body: `the loser ${bodyNaming(planted)}` },
        version: base,
      },
    });
    succeeded(forked);
    const copyId = forked.data.conflict_resolution?.conflicted_copy_id;
    expect(copyId, "no copy was written").toBeTruthy();
    trackItem(ctx, String(copyId));
    const copy = await client.getItem(String(copyId));
    succeeded(copy);
    const held = JSON.stringify(copy.data.item.properties);
    expect(held).toContain(lending.slice("sha256:".length));
    expect(held).toContain(planted.slice("sha256:".length));

    // With the item rewritten without either digest, only the copy names them.
    const current = await client.getItem(note.id);
    succeeded(current);
    succeeded(
      await client.updateItem(note.id, {
        properties: { title: "plain" },
        version: current.data.item.version,
      }),
    );
    expect(await readingDoors(reader.client, lending)).toEqual(SERVED);
    expect(await readingDoors(client, planted)).toEqual(UNKNOWN);
    expect((await operator.downloadBlob(planted)).status).toBe(200);
  });

  it("keeps each digest on a retyped item as it stood before the retype", async () => {
    const lending = await upload("a retype keeps this lending");
    const planted = await upload("a retype keeps this dead");
    const bare = await keyHolding({ "core.note": "write" });
    const reader = await keyHolding({
      "core.note": "read",
      "core.bookmark": "read",
    });
    const note = await noteSaying("a note about to be retyped");
    const titled = await client.updateItem(note.id, {
      properties: { title: lending },
      version: note.version,
    });
    succeeded(titled);
    const named = await bare.client.updateItem(note.id, {
      properties: { body: bodyNaming(planted) },
      version: titled.data.item.version,
    });
    succeeded(named);
    expect(await readingDoors(reader.client, lending)).toEqual(SERVED);
    expect(await readingDoors(reader.client, planted)).toEqual(UNKNOWN);

    // The key that sent both sets of bytes retypes the item, naming both.
    succeeded(
      await client.rawRequest(`/items/${note.id}`, {
        method: "PATCH",
        body: {
          type: "core.bookmark",
          retype: true,
          properties: {
            url: "https://example.com/retyped-as-it-stood",
            title: lending,
            notes: bodyNaming(planted),
          },
          properties_mode: "replace",
          version: named.data.item.version,
        },
      }),
    );
    const retyped = await client.getItem(note.id);
    succeeded(retyped);
    expect(retyped.data.item.type).toBe("core.bookmark");
    expect(await readingDoors(reader.client, lending)).toEqual(SERVED);
    expect(await readingDoors(client, planted)).toEqual(UNKNOWN);
    expect((await operator.downloadBlob(planted)).status).toBe(200);
  });

  it("keeps a lending digest lending through later writes by a key that never sent the bytes", async () => {
    const hash = await upload("lends whatever later writes keep it");
    const bare = await keyHolding({ "core.note": "write" });
    const reader = await keyHolding({ "core.note": "read" });
    const note = await noteSaying(bodyNaming(hash));
    expect(await readingDoors(reader.client, hash)).toEqual(SERVED);

    const edited = await bare.client.updateItem(note.id, {
      properties: { title: "edited beside it" },
      version: note.version,
    });
    succeeded(edited);
    expect(await readingDoors(reader.client, hash)).toEqual(SERVED);

    // A whole rewrite that moves the digest to another property keeps it.
    succeeded(
      await bare.client.rawRequest(`/items/${note.id}`, {
        method: "PATCH",
        body: {
          properties: { title: hash, body: "rewritten" },
          properties_mode: "replace",
          version: edited.data.item.version,
        },
      }),
    );
    expect(await readingDoors(reader.client, hash)).toEqual(SERVED);
  });

  it("keeps a lending digest on an edge lending through later writes by a key that never sent the bytes", async () => {
    const hash = await upload("an edge lends whatever later writes keep it");
    const source = await noteSaying("a lending edge's source");
    const target = await noteSaying("a lending edge's target");
    const bare = await keyHolding(
      { "core.note": "write" },
      { edge_permissions: { about: "write" } },
    );
    const reader = await keyHolding(
      { "core.note": "read" },
      { edge_permissions: { about: "read" } },
    );
    const edge = await client.createEdge({
      source_id: source.id,
      target_id: target.id,
      edge_type: "about",
      properties: { cover: hash },
    });
    succeeded(edge);
    expect(await readingDoors(reader.client, hash)).toEqual(SERVED);

    const edited = await bare.client.updateEdge(edge.data.edge.id, {
      properties: { title: "edited beside it" },
      version: edge.data.edge.version,
    });
    succeeded(edited);
    expect(await readingDoors(reader.client, hash)).toEqual(SERVED);

    // A write that names the digest under a second property keeps it too.
    const named = await bare.client.updateEdge(edge.data.edge.id, {
      properties: { alt: hash, title: "named twice" },
      version: edited.data.edge.version,
    });
    succeeded(named);
    expect(await readingDoors(reader.client, hash)).toEqual(SERVED);
  });

  it("keeps a lending digest in an extension lending through later writes by a key that never sent the bytes", async () => {
    const hash = await upload(
      "an extension lends whatever later writes keep it",
    );
    const item = await noteSaying("a lending namespace's item");
    const namespace = `lending.${ctx.runId}`;
    const bare = await keyHolding(
      { "core.note": "write" },
      { extension_permissions: { [namespace]: "write" } },
    );
    const reader = await keyHolding(
      { "core.note": "read" },
      { extension_permissions: { [namespace]: "read" } },
    );
    succeeded(
      await client.setItemExtension(item.id, namespace, { cover: hash }),
    );
    expect(await readingDoors(reader.client, hash)).toEqual(SERVED);

    // An extension is replaced whole, so a write beside the digest names it
    // again, and one that moves it to another property keeps it.
    succeeded(
      await bare.client.setItemExtension(item.id, namespace, {
        cover: hash,
        title: "edited beside it",
      }),
    );
    expect(await readingDoors(reader.client, hash)).toEqual(SERVED);
    succeeded(
      await bare.client.setItemExtension(item.id, namespace, {
        title: hash,
        note: "rewritten",
      }),
    );
    expect(await readingDoors(reader.client, hash)).toEqual(SERVED);
  });

  it("lends a digest named by a bulk create only when its writer sent the bytes", async () => {
    await expectDoorCredits(async (writer) => async (hash) => {
      const res = await writer.bulkItems([
        {
          type: "core.note",
          properties: { body: bodyNaming(hash) },
          source_id: `bulk-new-${String(doors)}-${ctx.runId}`,
        },
      ]);
      succeeded(res);
      expect(res.data.counts.created).toBe(1);
    });
  });

  it("lends a digest named by a bulk update only when its writer sent the bytes", async () => {
    await expectDoorCredits(async (writer) => {
      const sourceId = `bulk-old-${String(doors)}-${ctx.runId}`;
      await noteOf(writer, { body: "before" }, { source_id: sourceId });
      return async (hash) => {
        const res = await writer.bulkItems([
          {
            type: "core.note",
            properties: { body: bodyNaming(hash) },
            source_id: sourceId,
          },
        ]);
        succeeded(res);
        expect(res.data.counts.updated).toBe(1);
      };
    });
  });

  it("lends a digest named by a bulk action only when its writer sent the bytes", async () => {
    await expectDoorCredits(async (writer) => {
      // Each writer's own tag, so a job names only that writer's note.
      prepared += 1;
      const tag = `blob-action-${String(prepared)}-${ctx.runId}`;
      await noteOf(writer, { body: "tagged" }, { tags: [tag] });
      return async (hash) => {
        const queued = await writer.bulkAction({
          action: "update_properties",
          patch: { title: bodyNaming(hash) },
          filter: { tags: [tag] },
        });
        expect(queued.status, JSON.stringify(queued.error)).toBe(202);
        const job = await writer.pollBulkActionToTerminal(
          (queued.data as BulkActionJob).id,
        );
        expect(job.status).toBe("completed");
        expect(job.succeeded).toBe(1);
      };
    });
  });

  it("lends a digest named in a folder's settings only when its writer could read the blob", async () => {
    const hashes = [];
    for (const words of [
      "a folder names this at creation",
      "a folder names this later",
    ]) {
      const hash = await upload(words);
      await noteSaying(bodyNaming(hash));
      hashes.push(hash);
    }
    // A key whose only write is the folder cannot upload, so what a folder
    // lends is what its writer could read as it wrote.
    const seeing = await keyHolding({
      "system.folder": "write",
      "core.note": "read",
    });
    const blind = await keyHolding({ "system.folder": "write" });
    const reader = await keyHolding({ "system.folder": "read" });
    for (const hash of hashes) {
      expect(await readingDoors(seeing.client, hash)).toEqual(SERVED);
      expect(await readingDoors(blind.client, hash)).toEqual(UNKNOWN);
      expect(await readingDoors(reader.client, hash)).toEqual(UNKNOWN);
    }
    const [atCreation, later] = hashes as [string, string];

    // Written through the folder door by the key that cannot read the blob,
    // a digest lends nothing, on a create and on a patch.
    const blindCreated = await blind.client.createFolder({
      title: bodyNaming(atCreation),
    });
    succeeded(blindCreated);
    trackFolder(ctx, blindCreated.data.item.id);
    const blindPlain = await blind.client.createFolder({ title: "plain" });
    succeeded(blindPlain);
    trackFolder(ctx, blindPlain.data.item.id);
    succeeded(
      await blind.client.updateFolder(blindPlain.data.item.id, {
        title: bodyNaming(later),
        version: blindPlain.data.item.version,
      }),
    );
    for (const hash of hashes) {
      expect(await readingDoors(reader.client, hash)).toEqual(UNKNOWN);
    }

    const created = await seeing.client.createFolder({
      title: bodyNaming(atCreation),
    });
    succeeded(created);
    trackFolder(ctx, created.data.item.id);
    expect(await readingDoors(reader.client, atCreation)).toEqual(SERVED);

    const plain = await seeing.client.createFolder({ title: "plain" });
    succeeded(plain);
    trackFolder(ctx, plain.data.item.id);
    succeeded(
      await seeing.client.updateFolder(plain.data.item.id, {
        title: bodyNaming(later),
        version: plain.data.item.version,
      }),
    );
    expect(await readingDoors(reader.client, later)).toEqual(SERVED);
  });

  it("keeps a minted link working after its key is narrowed and after the rows that referenced the bytes are gone", async () => {
    const hash = await upload("bytes behind a link outliving its reach");
    const id = await fileNaming(hash);
    const reader = await keyHolding({ "core.file": "read" });
    expect(await readingDoors(reader.client, hash)).toEqual(SERVED);
    const link = await reader.client.getBlobUrl(hash, 600);
    expect(link.status).toBe(200);
    const expected = `bytes behind a link outliving its reach ${ctx.runId}`;

    const narrowed = await client.updateKey(reader.id, {
      type_permissions: { "core.note": "read" },
    });
    expect(narrowed.ok, JSON.stringify(narrowed.error)).toBe(true);
    // The witness: the narrowed key no longer reaches the bytes by any door.
    expect(await readingDoors(reader.client, hash)).toEqual(UNKNOWN);
    expect(await (await fetch(link.data.url)).text()).toBe(expected);

    expect((await client.deleteItem(id)).ok).toBe(true);
    expect((await client.purgeItem(id)).ok).toBe(true);
    expect((await operator.downloadBlob(hash)).status).toBe(200);
    expect(await (await fetch(link.data.url)).text()).toBe(expected);
  });

  it("serves a blob an edge names through a source in the bin, and stops once the source is purged", async () => {
    const hash = await upload("named by an edge from a binned source");
    const source = await noteSaying("a source that goes to the bin");
    const target = await noteSaying("a target that stays");
    const reader = await keyHolding(
      { "core.note": "read" },
      { edge_permissions: { about: "read" } },
    );
    const edge = await client.createEdge({
      source_id: source.id,
      target_id: target.id,
      edge_type: "about",
      properties: { cover: hash },
    });
    expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
    expect(await readingDoors(reader.client, hash)).toEqual(SERVED);

    expect((await client.deleteItem(source.id)).ok).toBe(true);
    expect(await readingDoors(reader.client, hash)).toEqual(SERVED);

    expect((await client.purgeItem(source.id)).ok).toBe(true);
    expect(await readingDoors(reader.client, hash)).toEqual(UNKNOWN);
    expect((await operator.downloadBlob(hash)).status).toBe(200);
  });

  it("serves a blob an extension names through an item in the bin, and stops once the item is purged", async () => {
    const hash = await upload("named by an extension on a binned item");
    const item = await noteSaying("an item that goes to the bin");
    const namespace = `blobreach.${ctx.runId}`;
    const reader = await keyHolding(
      { "core.note": "read" },
      { extension_permissions: { [namespace]: "read" } },
    );
    const written = await client.setItemExtension(item.id, namespace, {
      cover: hash,
    });
    expect(written.ok, JSON.stringify(written.error)).toBe(true);
    expect(await readingDoors(reader.client, hash)).toEqual(SERVED);

    expect((await client.transitionItem(item.id, "archived")).ok).toBe(true);
    expect(await readingDoors(reader.client, hash)).toEqual(SERVED);
    expect((await client.deleteItem(item.id)).ok).toBe(true);
    expect(await readingDoors(reader.client, hash)).toEqual(SERVED);

    expect((await client.purgeItem(item.id)).ok).toBe(true);
    expect(await readingDoors(reader.client, hash)).toEqual(UNKNOWN);
    expect((await operator.downloadBlob(hash)).status).toBe(200);
  });

  it("serves a blob an extension names to a key whose label is the namespace, and to no key labeled another", async () => {
    const hash = await upload("named by an extension a label reads");
    const item = await noteSaying("an item whose namespace is a label");
    const namespace = `labeled.${ctx.runId}`;
    const labeled = await client.createKey({
      label: namespace,
      source: `${ctx.source}-labeled`,
      type_permissions: { "core.note": "read" },
    });
    expect(labeled.ok, JSON.stringify(labeled.error)).toBe(true);
    trackKey(ctx, labeled.data.id);
    const owner = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: labeled.data.key,
    });
    const other = await keyHolding({ "core.note": "read" });

    const written = await client.setItemExtension(item.id, namespace, {
      cover: hash,
    });
    expect(written.ok, JSON.stringify(written.error)).toBe(true);
    expect(await readingDoors(owner, hash)).toEqual(SERVED);
    expect(await readingDoors(other.client, hash)).toEqual(UNKNOWN);
  });

  it("leaves out of an export archive a digest a property names without lending it, and one only an earlier version names", async () => {
    const planter = await keyHolding({ "core.note": "write" });
    const own = await planter.client.getCurrentKey();
    expect(own.ok, JSON.stringify(own.error)).toBe(true);
    const sent = async (words: string) => {
      const res = await planter.client.uploadBlob(
        new TextEncoder().encode(`${words} ${ctx.runId}`),
        "text/plain",
      );
      expect(res.status, JSON.stringify(res.error)).toBe(201);
      return res.data.hash;
    };
    const proved = await sent("an archive carries what its writer sent");
    const earlier = await sent("an archive leaves what only a version names");
    const planted = await upload(
      "an archive leaves what its writer never sent",
    );

    const created = await planter.client.createItem({
      type: "core.note",
      properties: { body: `![a](${proved}) ![b](${planted}) ![c](${earlier})` },
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    trackItem(ctx, created.data.item.id);
    const edited = await planter.client.updateItem(created.data.item.id, {
      properties: { body: `![a](${proved}) ![b](${planted})` },
      version: created.data.item.version,
    });
    expect(edited.ok, JSON.stringify(edited.error)).toBe(true);
    // The witness: the writer is served what it sent, and neither of the
    // others, though the instance holds all three.
    expect(await readingDoors(planter.client, proved)).toEqual(SERVED);
    for (const hash of [planted, earlier]) {
      expect(await readingDoors(planter.client, hash)).toEqual(UNKNOWN);
      expect((await operator.downloadBlob(hash)).status).toBe(200);
    }

    const archive = await planter.client.exportArchive({
      type: "core.note",
      source: own.data.source,
    });
    expect(archive.status).toBe(200);
    const manifest = JSON.parse(
      readTarGzEntry(archive.data, "manifest.json") ?? "{}",
    ) as { blobs: Record<string, unknown> };
    expect(Object.keys(manifest.blobs)).toEqual([proved]);
    expect(readTarGzEntry(archive.data, `blobs/${proved}`)).not.toBeNull();
    for (const hash of [planted, earlier]) {
      expect(readTarGzEntry(archive.data, `blobs/${hash}`)).toBeNull();
    }
  });

  it("leaves out of an export archive the bytes an edge or an extension lends to a key that may not read them", async () => {
    const inProperty = await upload("an archive carries this property digest");
    const inEdge = await upload("an archive carries this only with the edge");
    const inExtension = await upload(
      "an archive carries this only with the namespace",
    );
    const source = await noteSaying(`![it](${inProperty})`);
    const target = await noteSaying("the far end of an edge that lends");
    const namespace = `blobreach.${ctx.runId}`;
    expect(
      (
        await client.createEdge({
          source_id: source.id,
          target_id: target.id,
          edge_type: "about",
          properties: { cover: inEdge },
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await client.setItemExtension(source.id, namespace, {
          cover: inExtension,
        })
      ).ok,
    ).toBe(true);

    const exporters = [
      { name: "neither", edge: false, extension: false },
      { name: "the edge", edge: true, extension: false },
      { name: "the namespace", edge: false, extension: true },
    ];
    for (const { name, edge, extension } of exporters) {
      const exporter = await keyHolding(
        { "core.note": "read" },
        {
          ...(edge && { edge_permissions: { about: "read" } }),
          ...(extension && { extension_permissions: { [namespace]: "read" } }),
        },
      );
      const archive = await exporter.client.exportArchive({
        type: "core.note",
        source: ctx.source,
      });
      expect(archive.status, name).toBe(200);
      const carried = (hash: string) =>
        readTarGzEntry(archive.data, `blobs/${hash}`) !== null;
      expect(carried(inProperty), name).toBe(true);
      expect(carried(inEdge), name).toBe(edge);
      expect(carried(inExtension), name).toBe(extension);
    }
  });

  it("writes on each export line the digests that lend, and no namespace that lends none", async () => {
    const planter = await keyHolding(
      { "core.note": "write" },
      {
        edge_permissions: { about: "write" },
        extension_permissions: { "*": "write" },
      },
    );
    const own = await planter.client.getCurrentKey();
    expect(own.ok, JSON.stringify(own.error)).toBe(true);
    const sent = async (words: string) => {
      const res = await planter.client.uploadBlob(
        new TextEncoder().encode(`${words} ${ctx.runId}`),
        "text/plain",
      );
      expect(res.status, JSON.stringify(res.error)).toBe(201);
      return res.data.hash;
    };
    const lendingProperty = await sent("a line lists this property digest");
    const lendingEdge = await sent("a line lists this edge digest");
    const lendingExtension = await sent("a line lists this extension digest");
    const plantedProperty = await upload("a line omits this property digest");
    const plantedEdge = await upload("a line omits this edge digest");
    const plantedExtension = await upload("a line omits this extension digest");

    const note = await planter.client.createItem({
      type: "core.note",
      properties: { body: `![a](${lendingProperty}) ![b](${plantedProperty})` },
    });
    expect(note.ok, JSON.stringify(note.error)).toBe(true);
    trackItem(ctx, note.data.item.id);
    const far = await planter.client.createItem({
      type: "core.note",
      properties: { body: "the far end" },
    });
    expect(far.ok, JSON.stringify(far.error)).toBe(true);
    trackItem(ctx, far.data.item.id);
    const edge = await planter.client.createEdge({
      source_id: note.data.item.id,
      target_id: far.data.item.id,
      edge_type: "about",
      properties: { cover: lendingEdge, alt: plantedEdge },
    });
    expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
    const lendsNamespace = `lends.${ctx.runId}`;
    const plantsNamespace = `plants.${ctx.runId}`;
    for (const [namespace, hash] of [
      [lendsNamespace, lendingExtension],
      [plantsNamespace, plantedExtension],
    ] as const) {
      const written = await planter.client.setItemExtension(
        note.data.item.id,
        namespace,
        { cover: hash },
      );
      expect(written.ok, JSON.stringify(written.error)).toBe(true);
    }

    const archive = await client.exportArchive({
      type: "core.note",
      source: own.data.source,
    });
    expect(archive.status).toBe(200);
    const lines = (name: string) =>
      (readTarGzEntry(archive.data, name) ?? "")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, any>);
    const itemLine = lines("items.ndjson").find(
      (line) => line.item.id === note.data.item.id,
    );
    expect(itemLine?.lending_blobs).toEqual([lendingProperty]);
    expect(itemLine?.lending_extensions).toEqual({
      [lendsNamespace]: [lendingExtension],
    });
    // The witness: the namespace left out is on the line, holding its digest.
    expect(itemLine?.metadata.extensions[plantsNamespace]).toEqual({
      cover: plantedExtension,
    });
    const edgeLine = lines("edges.ndjson").find(
      (line) => line.edge.id === edge.data.edge.id,
    );
    expect(edgeLine?.lending_blobs).toEqual([lendingEdge]);
  });

  it("gives each digest on a keep-both copy's edges the standing it had on the edge copied", async () => {
    const lending = await upload("a copied edge keeps this lending");
    const planted = await upload("a copied edge keeps this dead");
    const source = await noteSaying("the note a stale write forks");
    const lendingTarget = await noteSaying("the target of the lending edge");
    const plantedTarget = await noteSaying("the target of the planted edge");
    const bare = await keyHolding(
      { "core.note": "write" },
      { edge_permissions: { about: "write" } },
    );
    const reader = await keyHolding(
      { "core.note": "read" },
      { edge_permissions: { about: "read" } },
    );
    const lendingEdge = await client.createEdge({
      source_id: source.id,
      target_id: lendingTarget.id,
      edge_type: "about",
      properties: { cover: lending },
    });
    const plantedEdge = await bare.client.createEdge({
      source_id: source.id,
      target_id: plantedTarget.id,
      edge_type: "about",
      properties: { cover: planted },
    });
    expect(lendingEdge.ok, JSON.stringify(lendingEdge.error)).toBe(true);
    expect(plantedEdge.ok, JSON.stringify(plantedEdge.error)).toBe(true);
    expect(await readingDoors(reader.client, lending)).toEqual(SERVED);
    expect(await readingDoors(reader.client, planted)).toEqual(UNKNOWN);

    // A stale write that collides forks the note, and the fork copies the
    // note's edges.
    const winner = await client.updateItem(source.id, {
      properties: { body: "the winner" },
      version: source.version,
    });
    expect(winner.ok, JSON.stringify(winner.error)).toBe(true);
    const forked = await client.rawRequest<{
      conflict_resolution?: { conflicted_copy_id?: string };
    }>(`/items/${source.id}?conflict=auto`, {
      method: "PATCH",
      body: {
        properties: { body: "the loser" },
        version: source.version,
      },
    });
    expect(forked.ok, JSON.stringify(forked.error)).toBe(true);
    const copyId = forked.data.conflict_resolution?.conflicted_copy_id;
    expect(copyId, "no copy was written").toBeTruthy();
    trackItem(ctx, String(copyId));
    const copied = await client.listItemEdges(String(copyId), {
      edge_type: "about",
    });
    expect(copied.ok, JSON.stringify(copied.error)).toBe(true);
    expect(copied.data.data).toHaveLength(2);

    // With the edges that were copied from gone, only the copies lend.
    for (const original of [lendingEdge, plantedEdge]) {
      expect((await client.deleteEdge(original.data.edge.id)).ok).toBe(true);
    }
    expect(await readingDoors(reader.client, lending)).toEqual(SERVED);
    expect(await readingDoors(client, planted)).toEqual(UNKNOWN);
    expect((await operator.downloadBlob(planted)).status).toBe(200);
  });

  it("restores an edge's and an extension's reach only for the digests their archive lines say lent", async () => {
    const blobs = Object.fromEntries(
      [
        "lent by a namespace",
        "held by a namespace that lent nothing",
        "lent by an edge",
        "held by an edge that lent nothing",
        "held by an edge whose line lists no digests",
      ].map((words) => [
        words,
        new TextEncoder().encode(`restored, ${words} ${ctx.runId}`),
      ]),
    ) as Record<string, Uint8Array>;
    const [namespaceLent, namespaceDead, edgeLent, edgeDead, edgeUnlisted] =
      Object.values(blobs).map(sha256) as [
        string,
        string,
        string,
        string,
        string,
      ];
    const ids = { source: uuidv7(), target: uuidv7() };
    const lendsNamespace = `restored.lends.${ctx.runId}`;
    const plantsNamespace = `restored.plants.${ctx.runId}`;
    const noteLine = (id: string, extensions: Record<string, unknown>) =>
      JSON.stringify({
        item: {
          id,
          type: "core.note",
          source: ctx.source,
          properties: { body: `a restored note ${id}` },
        },
        metadata: { tags: [], extensions },
        ...(id === ids.source && {
          lending_extensions: { [lendsNamespace]: [namespaceLent] },
        }),
      });
    const edgeLine = (
      properties: Record<string, string>,
      lending: unknown,
      [from, to] = [ids.source, ids.target],
    ) =>
      JSON.stringify({
        edge: {
          id: uuidv7(),
          source_id: from,
          target_id: to,
          edge_type: "about",
          properties,
        },
        lending_blobs: lending,
      });
    const archive = tarGz([
      {
        name: "manifest.json",
        body: JSON.stringify({
          version: 0,
          format: "marfa-archive-v0",
          created_at: new Date().toISOString(),
          item_count: 2,
          edge_count: 2,
          blob_count: Object.keys(blobs).length,
          type_count: 0,
          edge_type_count: 0,
          blobs: Object.fromEntries(
            Object.values(blobs).map((data) => [
              sha256(data),
              { mime_type: "text/plain", size_bytes: data.length },
            ]),
          ),
        }),
      },
      {
        name: "items.ndjson",
        body: `${noteLine(ids.source, {
          [lendsNamespace]: { cover: namespaceLent },
          [plantsNamespace]: { cover: namespaceDead },
        })}\n${noteLine(ids.target, {})}\n`,
      },
      {
        name: "edges.ndjson",
        body: `${edgeLine({ cover: edgeLent, alt: edgeDead }, [edgeLent])}\n${edgeLine({ cover: edgeUnlisted }, "not a list", [ids.target, ids.source])}\n`,
      },
      ...Object.values(blobs).map((data) => ({
        name: `blobs/${sha256(data)}`,
        body: data,
      })),
      { name: "types.ndjson", body: "" },
    ]);
    const restored = await operator.restoreArchive(archive);
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    expect(restored.data.edges_imported).toBe(2);
    trackItem(ctx, ids.source);
    trackItem(ctx, ids.target);

    // The suite's key reads every namespace and edge, so what it is not
    // served is a digest the archive did not say lent.
    for (const hash of [namespaceLent, edgeLent]) {
      expect(await readingDoors(client, hash)).toEqual(SERVED);
    }
    for (const hash of [namespaceDead, edgeDead, edgeUnlisted]) {
      expect(await readingDoors(client, hash)).toEqual(UNKNOWN);
      expect((await operator.downloadBlob(hash)).status).toBe(200);
    }
  });
});
