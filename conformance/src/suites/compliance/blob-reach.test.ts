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
