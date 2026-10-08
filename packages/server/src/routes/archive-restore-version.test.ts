/** A restored row retains its version so an old client precondition cannot
 *  match unrelated content as the row advances after restoration. */

import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import * as tar from "tar-stream";
import { afterAll, describe, expect, it } from "vitest";
import { itemWrites } from "../storage/item-writes.js";
import type { TestContext } from "../test-utils.js";
import {
  closeTestContexts,
  createTestContext,
  request,
} from "../test-utils.js";

async function extractArchive(data: Buffer): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  const extract = tar.extract();
  const gunzip = createGunzip();
  await new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c) => {
        if (!Buffer.isBuffer(c)) throw new Error("Expected archive bytes");
        chunks.push(c);
      });
      stream.on("end", () => {
        entries.set(header.name, Buffer.concat(chunks));
        next();
      });
      stream.resume();
    });
    extract.on("finish", resolve);
    extract.on("error", reject);
    Readable.from(data).pipe(gunzip).pipe(extract);
  });
  return entries;
}

const contexts: TestContext[] = [];
async function newContext(): Promise<TestContext> {
  const ctx = await createTestContext();
  contexts.push(ctx);
  return ctx;
}

afterAll(async () => {
  await closeTestContexts(contexts);
});

describe("a restore does not rewind a row's version", () => {
  it("brings items and edges back at the version they were archived at", async () => {
    const source = await newContext();
    const destination = await newContext();

    const note = await itemWrites(source.storage).create({
      type: "core.note",
      properties: { body: "v1" },
      source: "av-seed",
    });
    const other = await itemWrites(source.storage).create({
      type: "core.note",
      properties: { body: "target" },
      source: "av-seed",
    });
    // Climb well past 1, so a restore that re-mints at 1 is unmistakable
    // rather than coincidentally right.
    for (const body of ["v2", "v3", "v4"]) {
      const bumped = await itemWrites(source.storage).update(note.id, {
        properties: { body },
      });
      expect("error" in bumped).toBe(false);
    }
    const edge = await source.storage.edges.createRaw({
      source_id: note.id,
      target_id: other.id,
      edge_type: "references",
    });
    const bumpedEdge = await source.storage.edges.updateProperties(
      edge.id,
      {
        weight: 2,
      },
      undefined,
      undefined,
      null,
    );
    expect(bumpedEdge.ok).toBe(true);

    const archivedItem = await source.storage.items.get(note.id);
    const archivedEdge = await source.storage.edges.get(edge.id);
    expect(archivedItem?.version).toBeGreaterThan(1);
    expect(archivedEdge?.version).toBeGreaterThan(1);

    const exportRes = await request(
      source.app,
      "GET",
      `/export?format=archive`,
      { key: source.workingKey },
    );
    expect(exportRes.status).toBe(200);
    const archive = Buffer.from(await exportRes.arrayBuffer());

    // The version is in the archive already; only the restore ignored it.
    const entries = await extractArchive(archive);
    const itemLine = entries
      .get("items.ndjson")!
      .toString()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) => JSON.parse(line) as { item: { id: string; version: number } },
      )
      .find((line) => line.item.id === note.id);
    expect(itemLine?.item.version).toBe(archivedItem?.version);

    // `/restore` is an operator route, and the operator key is
    // the only credential that reaches it.
    const restoreRes = await destination.app.request(`/restore`, {
      method: "POST",
      headers: {
        cookie: destination.owner.cookie,
        origin: new URL(destination.config.authBaseUrl).origin,
        "Content-Type": "application/gzip",
      },
      body: archive,
    });
    expect(restoreRes.status).toBe(200);

    const restoredItem = await destination.storage.items.get(note.id);
    const restoredEdge = await destination.storage.edges.get(edge.id);
    expect(restoredItem).not.toBeNull();
    expect(restoredEdge).not.toBeNull();

    // Both halves move together. Fixing one and not the other leaves the
    // same hole reachable through the other door.
    expect(
      restoredItem?.version,
      "a restored item came back at a version a client could already have read from different content",
    ).toBe(archivedItem?.version);
    expect(
      restoredEdge?.version,
      "a restored edge came back at a version a client could already have read from different content",
    ).toBe(archivedEdge?.version);
  });
});
