/**
 * An edge lends read on the blobs its properties name, and a metadata
 * extension on the blobs its namespace names, each to a credential that may
 * read it, and each only under the proof rule an item's reference is held to
 * (`blobs.md` 15). Every refusal here has a witness: the bytes are held (the
 * operator key reads them), and the same reader is served once the row that
 * lends them is in place.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import * as tar from "tar-stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeTestContexts,
  createTestContext,
  mintWorkingKey,
  request,
  seedOauthBearer,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
let destination: TestContext;
let seq = 0;

beforeAll(async () => {
  ctx = await createTestContext();
  destination = await createTestContext();
});

afterAll(() => closeTestContexts([ctx, destination]));

/** A reach, by the maps a working key is minted with. */
interface Reach {
  type_permissions: Record<string, "read" | "write">;
  edge_permissions: Record<string, "read" | "write">;
  extension_permissions: Record<string, "read" | "write">;
  label?: string;
}

const NONE = {
  type_permissions: {},
  edge_permissions: {},
  extension_permissions: {},
};

function hashOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function json<T>(res: Response, status: number): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function upload(
  on: TestContext,
  key: string,
  words: string,
): Promise<string> {
  seq += 1;
  const bytes = new TextEncoder().encode(`${words} ${String(seq)}`);
  const res = await on.app.request("/blobs", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "text/plain" },
    body: bytes,
  });
  expect(res.status).toBe(201);
  return hashOf(bytes);
}

async function read(
  on: TestContext,
  key: string,
  hash: string,
): Promise<number> {
  return (await request(on.app, "GET", `/blobs/${hash}`, { key })).status;
}

async function note(on: TestContext, key: string): Promise<string> {
  seq += 1;
  const created = await json<{ item: { id: string } }>(
    await request(on.app, "POST", "/items", {
      key,
      body: { type: "core.note", properties: { body: `note ${String(seq)}` } },
    }),
    201,
  );
  return created.item.id;
}

async function edge(
  on: TestContext,
  key: string,
  sourceId: string,
  targetId: string,
  properties: Record<string, unknown>,
): Promise<{ id: string; version: number }> {
  const created = await json<{ edge: { id: string; version: number } }>(
    await request(on.app, "POST", "/edges", {
      key,
      body: {
        source_id: sourceId,
        target_id: targetId,
        edge_type: "about",
        properties,
      },
    }),
    201,
  );
  return created.edge;
}

async function setExtension(
  on: TestContext,
  key: string,
  itemId: string,
  namespace: string,
  data: Record<string, unknown>,
): Promise<void> {
  await json(
    await request(on.app, "PUT", `/items/${itemId}/extensions/${namespace}`, {
      key,
      body: data,
    }),
    200,
  );
}

function reader(on: TestContext, reach: Reach): Promise<string> {
  return mintWorkingKey(on, reach);
}

describe("an edge lends read on the blobs its properties name", () => {
  it("serves a credential that reads the edge and its source's type, and no other", async () => {
    const owner = ctx.workingKey;
    const hash = await upload(ctx, owner, "named only by an edge");
    const source = await note(ctx, owner);
    const target = await note(ctx, owner);

    const aboutReader = await reader(ctx, {
      ...NONE,
      type_permissions: { "core.note": "read" },
      edge_permissions: { about: "read" },
    });
    const noEdgeReader = await reader(ctx, {
      ...NONE,
      type_permissions: { "core.note": "read" },
    });
    const otherEdgeReader = await reader(ctx, {
      ...NONE,
      type_permissions: { "core.note": "read" },
      edge_permissions: { references: "read" },
    });
    const wrongTypeReader = await reader(ctx, {
      ...NONE,
      type_permissions: { "core.file": "read" },
      edge_permissions: { about: "read" },
    });

    // The witness: the bytes are held and the readers are not turned away by
    // anything but the missing reference.
    expect(await read(ctx, ctx.operatorKey, hash)).toBe(200);
    for (const key of [owner, aboutReader]) {
      expect(await read(ctx, key, hash)).toBe(404);
    }

    const written = await edge(ctx, owner, source, target, { cover: hash });

    expect(await read(ctx, owner, hash)).toBe(200);
    expect(await read(ctx, aboutReader, hash)).toBe(200);
    expect(await read(ctx, noEdgeReader, hash)).toBe(404);
    expect(await read(ctx, otherEdgeReader, hash)).toBe(404);
    expect(await read(ctx, wrongTypeReader, hash)).toBe(404);

    await json(
      await request(ctx.app, "DELETE", `/edges/${written.id}`, { key: owner }),
      200,
    );
    expect(await read(ctx, aboutReader, hash)).toBe(404);
    expect(await read(ctx, ctx.operatorKey, hash)).toBe(200);
  });

  it("serves a credential through a trashed source, and stops when the source is purged", async () => {
    const owner = ctx.workingKey;
    const hash = await upload(ctx, owner, "named by an edge of a purged note");
    const source = await note(ctx, owner);
    const target = await note(ctx, owner);
    await edge(ctx, owner, source, target, { cover: hash });
    const aboutReader = await reader(ctx, {
      ...NONE,
      type_permissions: { "core.note": "read" },
      edge_permissions: { about: "read" },
    });
    expect(await read(ctx, aboutReader, hash)).toBe(200);

    await json(
      await request(ctx.app, "DELETE", `/items/${source}`, { key: owner }),
      200,
    );
    expect(await read(ctx, aboutReader, hash)).toBe(200);
    await json(
      await request(ctx.app, "POST", `/items/${source}/purge`, {
        key: owner,
      }),
      200,
    );
    expect(await read(ctx, aboutReader, hash)).toBe(404);
    expect(await read(ctx, ctx.operatorKey, hash)).toBe(200);
  });

  it("lends only the digests a writer proved, and never upgrades one it did not", async () => {
    const owner = ctx.workingKey;
    const bare = await mintWorkingKey(ctx, {
      ...NONE,
      type_permissions: { "core.note": "write" },
      edge_permissions: { about: "write" },
    });
    const aboutReader = await reader(ctx, {
      ...NONE,
      type_permissions: { "core.note": "read" },
      edge_permissions: { about: "read" },
    });
    const planted = await upload(ctx, owner, "an edge plants this digest");
    const proved = await upload(ctx, owner, "an edge writer proves this one");
    const source = await note(ctx, owner);
    const target = await note(ctx, owner);

    // The bare key neither sent the bytes nor reads them.
    const written = await edge(ctx, bare, source, target, { cover: planted });
    expect(await read(ctx, owner, planted)).toBe(404);

    // The owner patches the edge with the same digest and a second one: the
    // first stays dead while the edge names it, the second is new and lends.
    const patched = await json<{ edge: { version: number } }>(
      await request(ctx.app, "PATCH", `/edges/${written.id}`, {
        key: owner,
        body: {
          properties: { cover: planted, extra: proved },
          version: written.version,
        },
      }),
      200,
    );
    expect(await read(ctx, aboutReader, planted)).toBe(404);
    expect(await read(ctx, aboutReader, proved)).toBe(200);

    // A write by the bare key that keeps the lending digest does not
    // withdraw it.
    await json(
      await request(ctx.app, "PATCH", `/edges/${written.id}`, {
        key: bare,
        body: { properties: { note: "kept" }, version: patched.edge.version },
      }),
      200,
    );
    expect(await read(ctx, aboutReader, proved)).toBe(200);
  });

  it("lends through an edge written by the bulk door and replaced by an upsert", async () => {
    const owner = ctx.workingKey;
    const created = await upload(ctx, owner, "named by a bulk-created edge");
    const upserted = await upload(ctx, owner, "named by a bulk-upserted edge");
    const source = await note(ctx, owner);
    const target = await note(ctx, owner);
    const aboutReader = await reader(ctx, {
      ...NONE,
      type_permissions: { "core.note": "read" },
      edge_permissions: { about: "read" },
    });
    const entry = (properties: Record<string, unknown>) => ({
      source_id: source,
      target_id: target,
      edge_type: "about",
      properties,
    });

    await json(
      await request(ctx.app, "POST", "/edges/bulk", {
        key: owner,
        body: { edges: [entry({ cover: created })], mode: "upsert" },
      }),
      200,
    );
    expect(await read(ctx, aboutReader, created)).toBe(200);
    expect(await read(ctx, aboutReader, upserted)).toBe(404);

    await json(
      await request(ctx.app, "POST", "/edges/bulk", {
        key: owner,
        body: { edges: [entry({ cover: upserted })], mode: "upsert" },
      }),
      200,
    );
    expect(await read(ctx, aboutReader, upserted)).toBe(200);
    // The upsert merges over the edge's properties, so the new cover replaces
    // the first, which the edge no longer names.
    expect(await read(ctx, aboutReader, created)).toBe(404);
  });
});

describe("a signed-in app", () => {
  it("is served a blob an edge names by its granted edge scope, and an extension by none", async () => {
    const owner = ctx.workingKey;
    const edgeDigest = await upload(ctx, owner, "an app reads this by an edge");
    const extensionDigest = await upload(
      ctx,
      owner,
      "an app is not served this by an extension",
    );
    const source = await note(ctx, owner);
    const target = await note(ctx, owner);
    await edge(ctx, owner, source, target, { cover: edgeDigest });
    await setExtension(ctx, owner, source, "app.cover", {
      cover: extensionDigest,
    });
    const { token: withEdgeScope } = await seedOauthBearer(ctx.storage, [
      "core.note:read",
      "edge.about:read",
    ]);
    const { token: withoutEdgeScope } = await seedOauthBearer(ctx.storage, [
      "core.note:read",
    ]);

    expect(await read(ctx, withEdgeScope, edgeDigest)).toBe(200);
    expect(await read(ctx, withoutEdgeScope, edgeDigest)).toBe(404);
    // A signed-in app holds no extension map, so no namespace reaches it.
    expect(await read(ctx, withEdgeScope, extensionDigest)).toBe(404);
    expect(await read(ctx, owner, extensionDigest)).toBe(200);
  });
});

describe("a keep-both copy", () => {
  it("carries each edge digest as it stood on the edge it copied", async () => {
    const owner = ctx.workingKey;
    const bare = await mintWorkingKey(ctx, {
      ...NONE,
      type_permissions: { "core.note": "write" },
      edge_permissions: { about: "write" },
    });
    const lent = await upload(ctx, owner, "an edge copy keeps this lending");
    const dead = await upload(ctx, owner, "an edge copy keeps this dead");
    const source = await note(ctx, owner);
    const lentTarget = await note(ctx, owner);
    const deadTarget = await note(ctx, owner);
    const lending = await edge(ctx, owner, source, lentTarget, { cover: lent });
    const planted = await edge(ctx, bare, source, deadTarget, { cover: dead });
    const aboutReader = await reader(ctx, {
      ...NONE,
      type_permissions: { "core.note": "read" },
      edge_permissions: { about: "read" },
    });
    expect(await read(ctx, aboutReader, lent)).toBe(200);
    expect(await read(ctx, aboutReader, dead)).toBe(404);

    // A stale write that collides keeps both; the sibling copies the edges.
    const held = await json<{ item: { version: number } }>(
      await request(ctx.app, "GET", `/items/${source}`, { key: owner }),
      200,
    );
    await json(
      await request(ctx.app, "PATCH", `/items/${source}`, {
        key: owner,
        body: {
          properties: { body: "the winner" },
          version: held.item.version,
        },
      }),
      200,
    );
    await json(
      await request(ctx.app, "PATCH", `/items/${source}?conflict=auto`, {
        key: owner,
        body: {
          properties: { body: "the loser" },
          version: held.item.version,
        },
      }),
      200,
    );
    const siblings = await json<{
      data: { source_id: string; target_id: string; id: string }[];
    }>(await request(ctx.app, "GET", "/edges?limit=500", { key: owner }), 200);
    const copies = siblings.data.filter(
      (row) =>
        row.source_id !== source &&
        [lentTarget, deadTarget].includes(row.target_id),
    );
    expect(copies).toHaveLength(2);

    // Withdrawing the originals leaves only the copies to lend.
    for (const original of [lending, planted]) {
      await json(
        await request(ctx.app, "DELETE", `/edges/${original.id}`, {
          key: owner,
        }),
        200,
      );
    }
    expect(await read(ctx, aboutReader, lent)).toBe(200);
    expect(await read(ctx, owner, dead)).toBe(404);
  });
});

describe("an extension lends read on the blobs its namespace names", () => {
  const namespace = "blobreach";

  it("serves a credential that reads the namespace and the item's type, and no other", async () => {
    const owner = ctx.workingKey;
    const hash = await upload(ctx, owner, "named only by an extension");
    const item = await note(ctx, owner);

    const namespaceReader = await reader(ctx, {
      ...NONE,
      type_permissions: { "core.note": "read" },
      extension_permissions: { [namespace]: "read" },
    });
    const wildcardReader = await reader(ctx, {
      ...NONE,
      type_permissions: { "core.note": "read" },
      extension_permissions: { "*": "read" },
    });
    const ownLabelReader = await reader(ctx, {
      ...NONE,
      type_permissions: { "core.note": "read" },
      label: namespace,
    });
    const otherNamespaceReader = await reader(ctx, {
      ...NONE,
      type_permissions: { "core.note": "read" },
      extension_permissions: { elsewhere: "read" },
    });
    const noExtensionReader = await reader(ctx, {
      ...NONE,
      type_permissions: { "core.note": "read" },
    });
    const wrongTypeReader = await reader(ctx, {
      ...NONE,
      type_permissions: { "core.file": "read" },
      extension_permissions: { [namespace]: "read" },
    });

    expect(await read(ctx, ctx.operatorKey, hash)).toBe(200);
    expect(await read(ctx, namespaceReader, hash)).toBe(404);

    await setExtension(ctx, owner, item, namespace, { cover: hash });

    expect(await read(ctx, owner, hash)).toBe(200);
    expect(await read(ctx, namespaceReader, hash)).toBe(200);
    expect(await read(ctx, wildcardReader, hash)).toBe(200);
    expect(await read(ctx, ownLabelReader, hash)).toBe(200);
    expect(await read(ctx, otherNamespaceReader, hash)).toBe(404);
    expect(await read(ctx, noExtensionReader, hash)).toBe(404);
    expect(await read(ctx, wrongTypeReader, hash)).toBe(404);

    // Replacing the namespace without the digest withdraws it.
    await setExtension(ctx, owner, item, namespace, { cover: "none" });
    expect(await read(ctx, namespaceReader, hash)).toBe(404);
    await setExtension(ctx, owner, item, namespace, { cover: hash });
    expect(await read(ctx, namespaceReader, hash)).toBe(200);
    await json(
      await request(
        ctx.app,
        "DELETE",
        `/items/${item}/extensions/${namespace}`,
        { key: owner },
      ),
      200,
    );
    expect(await read(ctx, namespaceReader, hash)).toBe(404);
    expect(await read(ctx, ctx.operatorKey, hash)).toBe(200);
  });

  it("lends through a namespace beside a namespace that lends nothing, and stops at the purge", async () => {
    const owner = ctx.workingKey;
    const hash = await upload(
      ctx,
      owner,
      "named by two namespaces of one item",
    );
    const item = await note(ctx, owner);
    const first = await reader(ctx, {
      ...NONE,
      type_permissions: { "core.note": "read" },
      extension_permissions: { first: "read" },
    });
    const second = await reader(ctx, {
      ...NONE,
      type_permissions: { "core.note": "read" },
      extension_permissions: { second: "read" },
    });
    await setExtension(ctx, owner, item, "first", { cover: hash });
    await setExtension(ctx, owner, item, "second", { cover: hash });
    expect(await read(ctx, first, hash)).toBe(200);
    expect(await read(ctx, second, hash)).toBe(200);

    await json(
      await request(ctx.app, "DELETE", `/items/${item}/extensions/first`, {
        key: owner,
      }),
      200,
    );
    expect(await read(ctx, first, hash)).toBe(404);
    expect(await read(ctx, second, hash)).toBe(200);

    await json(
      await request(ctx.app, "DELETE", `/items/${item}`, { key: owner }),
      200,
    );
    expect(await read(ctx, second, hash)).toBe(200);
    await json(
      await request(ctx.app, "POST", `/items/${item}/purge`, { key: owner }),
      200,
    );
    expect(await read(ctx, second, hash)).toBe(404);
    expect(await read(ctx, ctx.operatorKey, hash)).toBe(200);
  });

  it("lends only a digest its writer proved", async () => {
    const owner = ctx.workingKey;
    const bare = await mintWorkingKey(ctx, {
      ...NONE,
      type_permissions: { "core.note": "write" },
      extension_permissions: { [namespace]: "write" },
    });
    const namespaceReader = await reader(ctx, {
      ...NONE,
      type_permissions: { "core.note": "read" },
      extension_permissions: { [namespace]: "read" },
    });
    const planted = await upload(ctx, owner, "an extension plants this");
    const item = await note(ctx, owner);

    await setExtension(ctx, bare, item, namespace, { cover: planted });
    expect(await read(ctx, owner, planted)).toBe(404);
    // Written again by a key holding every blob, the digest is the same
    // reference as before and stays dead.
    await setExtension(ctx, owner, item, namespace, {
      cover: planted,
      title: "retitled",
    });
    expect(await read(ctx, namespaceReader, planted)).toBe(404);
    // Dropped and written anew with the proof, it lends.
    await setExtension(ctx, owner, item, namespace, { cover: "none" });
    await setExtension(ctx, owner, item, namespace, { cover: planted });
    expect(await read(ctx, namespaceReader, planted)).toBe(200);
  });
});

describe("an earlier version still lends nothing", () => {
  it("answers a blob only a version snapshot names as an unknown one", async () => {
    const owner = ctx.workingKey;
    const hash = await upload(ctx, owner, "named by an earlier version");
    const created = await json<{ item: { id: string; version: number } }>(
      await request(ctx.app, "POST", "/items", {
        key: owner,
        body: {
          type: "core.note",
          properties: { body: `was ![it](${hash})` },
        },
      }),
      201,
    );
    expect(await read(ctx, owner, hash)).toBe(200);
    await json(
      await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
        key: owner,
        body: {
          properties: { body: "no longer" },
          version: created.item.version,
        },
      }),
      200,
    );
    expect(await read(ctx, owner, hash)).toBe(404);
    expect(await read(ctx, ctx.operatorKey, hash)).toBe(200);
  });
});

async function unpack(bytes: Buffer): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  const extract = tar.extract();
  await new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk) => {
        if (!Buffer.isBuffer(chunk)) throw new Error("Expected archive bytes");
        chunks.push(chunk);
      });
      stream.on("end", () => {
        entries.set(header.name, Buffer.concat(chunks));
        next();
      });
      stream.on("error", reject);
    });
    extract.on("finish", resolve);
    extract.on("error", reject);
    Readable.from(bytes).pipe(createGunzip()).pipe(extract);
  });
  return entries;
}

async function pack(entries: Map<string, Buffer>): Promise<Buffer> {
  const archive = tar.pack();
  const gzip = createGzip();
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
    gzip.on("end", resolve);
    gzip.on("error", reject);
  });
  archive.pipe(gzip);
  for (const [name, data] of entries) archive.entry({ name }, data);
  archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

describe("an export archive and its restore carry the lending", () => {
  it("carries the bytes a working key may read through an edge or an extension, and restores the same answers", async () => {
    const owner = ctx.workingKey;
    const viaEdge = await upload(ctx, owner, "an archive carries, by an edge");
    const viaExtension = await upload(
      ctx,
      owner,
      "an archive carries, by an extension",
    );
    const viaDeadEdge = await upload(
      ctx,
      owner,
      "an archive carries nothing of, a dead edge digest",
    );
    const viaDeadExtension = await upload(
      ctx,
      owner,
      "an archive carries nothing of, a dead extension digest",
    );
    const bare = await mintWorkingKey(ctx, {
      ...NONE,
      type_permissions: { "core.note": "write" },
      edge_permissions: { about: "write" },
      extension_permissions: { carried: "write", other: "write" },
    });
    const source = await note(ctx, owner);
    const target = await note(ctx, owner);
    const otherTarget = await note(ctx, owner);
    await edge(ctx, owner, source, target, { cover: viaEdge });
    await edge(ctx, bare, source, otherTarget, { cover: viaDeadEdge });
    await setExtension(ctx, owner, source, "carried", { cover: viaExtension });
    await setExtension(ctx, bare, source, "other", { cover: viaDeadExtension });

    const exporter = await reader(ctx, {
      type_permissions: { "core.note": "read" },
      edge_permissions: { about: "read" },
      extension_permissions: { carried: "read", other: "read" },
    });
    expect(await read(ctx, exporter, viaEdge)).toBe(200);
    expect(await read(ctx, exporter, viaExtension)).toBe(200);
    expect(await read(ctx, exporter, viaDeadEdge)).toBe(404);
    expect(await read(ctx, exporter, viaDeadExtension)).toBe(404);

    const exported = await request(
      ctx.app,
      "GET",
      `/export?format=archive&type=core.note`,
      { key: exporter },
    );
    expect(exported.status).toBe(200);
    const archive = Buffer.from(await exported.arrayBuffer());
    const entries = await unpack(archive);
    const manifest = JSON.parse(entries.get("manifest.json")!.toString()) as {
      blobs: Record<string, unknown>;
    };
    expect(Object.keys(manifest.blobs)).toContain(viaEdge);
    expect(Object.keys(manifest.blobs)).toContain(viaExtension);
    expect(Object.keys(manifest.blobs)).not.toContain(viaDeadEdge);
    expect(Object.keys(manifest.blobs)).not.toContain(viaDeadExtension);
    expect(entries.has(`blobs/${viaEdge}`)).toBe(true);
    expect(entries.has(`blobs/${viaExtension}`)).toBe(true);

    const edgeLines = entries
      .get("edges.ndjson")!
      .toString()
      .split("\n")
      .filter((line) => line !== "")
      .map(
        (line) =>
          JSON.parse(line) as {
            edge: { source_id: string; properties: { cover?: string } };
            lending_blobs: string[];
          },
      )
      .filter((line) => line.edge.source_id === source);
    expect(
      edgeLines.map((line) => [line.edge.properties.cover, line.lending_blobs]),
    ).toEqual(
      expect.arrayContaining([
        [viaEdge, [viaEdge]],
        [viaDeadEdge, []],
      ]),
    );
    const itemLine = entries
      .get("items.ndjson")!
      .toString()
      .split("\n")
      .filter((line) => line !== "")
      .map(
        (line) =>
          JSON.parse(line) as {
            item: { id: string };
            lending_extensions: Record<string, string[]>;
          },
      )
      .find((line) => line.item.id === source);
    expect(itemLine?.lending_extensions).toEqual({
      carried: [viaExtension],
    });

    const restored = await destination.app.request("/restore", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${destination.operatorKey}`,
        "Content-Type": "application/gzip",
      },
      body: archive,
    });
    expect(restored.status, await restored.clone().text()).toBe(200);

    const sameReader = await reader(destination, {
      type_permissions: { "core.note": "read" },
      edge_permissions: { about: "read" },
      extension_permissions: { carried: "read", other: "read" },
    });
    const noEdgeReader = await reader(destination, {
      ...NONE,
      type_permissions: { "core.note": "read" },
      extension_permissions: { carried: "read", other: "read" },
    });
    const noExtensionReader = await reader(destination, {
      ...NONE,
      type_permissions: { "core.note": "read" },
      edge_permissions: { about: "read" },
    });
    const full = await mintWorkingKey(destination);
    expect(await read(destination, sameReader, viaEdge)).toBe(200);
    expect(await read(destination, sameReader, viaExtension)).toBe(200);
    expect(await read(destination, sameReader, viaDeadEdge)).toBe(404);
    expect(await read(destination, sameReader, viaDeadExtension)).toBe(404);
    expect(await read(destination, noEdgeReader, viaEdge)).toBe(404);
    expect(await read(destination, noExtensionReader, viaExtension)).toBe(404);
    expect(await read(destination, full, viaEdge)).toBe(200);
    expect(await read(destination, full, viaExtension)).toBe(200);
    expect(await read(destination, full, viaDeadEdge)).toBe(404);
    expect(await read(destination, full, viaDeadExtension)).toBe(404);
    // The archive carried neither dead digest's bytes at all.
    for (const hash of [viaDeadEdge, viaDeadExtension]) {
      expect(await read(destination, destination.operatorKey, hash)).toBe(404);
    }
  });
  it("lends nothing through lending lists that are malformed or name digests the row does not hold", async () => {
    const owner = ctx.workingKey;
    const edgeDigest = await upload(
      ctx,
      owner,
      "a hand-edited archive, an edge",
    );
    const extensionDigest = await upload(
      ctx,
      owner,
      "a hand-edited archive, an extension",
    );
    const elsewhere = await upload(
      ctx,
      owner,
      "a digest no row of the archive names",
    );
    const source = await note(ctx, owner);
    const target = await note(ctx, owner);
    await edge(ctx, owner, source, target, { cover: edgeDigest });
    await setExtension(ctx, owner, source, "edited", {
      cover: extensionDigest,
    });

    const exported = await request(
      ctx.app,
      "GET",
      "/export?format=archive&type=core.note",
      { key: owner },
    );
    expect(exported.status).toBe(200);
    const entries = await unpack(Buffer.from(await exported.arrayBuffer()));
    const rewrite = (
      file: string,
      edit: (line: Record<string, unknown>) => void,
    ) =>
      entries.set(
        file,
        Buffer.from(
          entries
            .get(file)!
            .toString()
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              edit(parsed);
              return JSON.stringify(parsed) + "\n";
            })
            .join(""),
        ),
      );
    rewrite("edges.ndjson", (line) => {
      line.lending_blobs = "everything";
    });
    rewrite("items.ndjson", (line) => {
      line.lending_blobs = [elsewhere, 7, null];
      line.lending_extensions = { edited: elsewhere, "": [extensionDigest] };
    });
    const hand = await createTestContext();
    try {
      const restored = await hand.app.request("/restore", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${hand.operatorKey}`,
          "Content-Type": "application/gzip",
        },
        body: await pack(entries),
      });
      expect(restored.status, await restored.clone().text()).toBe(200);
      const full = await mintWorkingKey(hand);
      // The witness: the bytes came across, and the well formed lists in the
      // test above lend these same digests to the same kind of key.
      expect(await read(hand, hand.operatorKey, edgeDigest)).toBe(200);
      expect(await read(hand, full, edgeDigest)).toBe(404);
      expect(await read(hand, full, extensionDigest)).toBe(404);
      expect(await read(hand, hand.operatorKey, elsewhere)).toBe(404);
    } finally {
      await hand.cleanup();
    }
  });
  it("writes the reference rows in the restore's transaction, so a restore that fails leaves none", async () => {
    const owner = ctx.workingKey;
    const viaEdge = await upload(ctx, owner, "a failed restore, an edge");
    const viaExtension = await upload(
      ctx,
      owner,
      "a failed restore, an extension",
    );
    const source = await note(ctx, owner);
    const target = await note(ctx, owner);
    await edge(ctx, owner, source, target, { cover: viaEdge });
    await setExtension(ctx, owner, source, "rolledback", {
      cover: viaExtension,
    });
    const exported = await request(
      ctx.app,
      "GET",
      "/export?format=archive&type=core.note",
      { key: owner },
    );
    const archive = Buffer.from(await exported.arrayBuffer());

    const failing = await createTestContext();
    try {
      const audit = failing.storage.audit;
      const log = audit.log.bind(audit);
      audit.log = (entry, id) => {
        if (entry.action === "restore_archive") {
          throw new Error("the audit write fails");
        }
        return log(entry, id);
      };
      const run = () =>
        failing.app.request("/restore", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${failing.operatorKey}`,
            "Content-Type": "application/gzip",
          },
          body: archive,
        });
      const refused = await run();
      expect(refused.status).toBeGreaterThanOrEqual(500);
      const raw = failing.storage as unknown as {
        __sqliteAll: (query: string) => Promise<Record<string, unknown>[]>;
      };
      for (const table of [
        "items",
        "edges",
        "edge_blob_references",
        "extension_blob_references",
      ]) {
        const [row] = await raw.__sqliteAll(
          `SELECT COUNT(*) AS n FROM ${table}`,
        );
        expect(row?.n, table).toBe(0);
      }

      // The witness: the same archive restores once the audit write works,
      // and writes the rows the failed one rolled back.
      audit.log = log;
      expect((await run()).status).toBe(200);
      const [rows] = await raw.__sqliteAll(
        `SELECT COUNT(*) AS n FROM edge_blob_references WHERE hash = '${viaEdge}'`,
      );
      expect(rows?.n).toBe(1);
      const full = await mintWorkingKey(failing);
      expect(await read(failing, full, viaEdge)).toBe(200);
      expect(await read(failing, full, viaExtension)).toBe(200);
    } finally {
      await failing.cleanup();
    }
  });
});
