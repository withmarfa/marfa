import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { MarfaEdge, MarfaItem } from "../../client/types.js";
import { archiveLines, archiveManifest } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { clientsFor, DISK_ONLY } from "../../utils/own-blob-server.js";

/**
 * An archive reads its whole selection in one snapshot. Writes land while the
 * export holds its selection read open, and the archive carries none of them,
 * with counts that match its line files.
 */

let server: FreshServer;
let working: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("export-snapshot", DISK_ONLY);
  ({ working } = clientsFor(server));
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.clearFault();
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

async function note(title: string): Promise<MarfaItem> {
  const made = await working.createItem({
    type: "core.note",
    properties: { title },
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return made.data.item;
}

async function edge(source: string, target: string): Promise<string> {
  const made = await working.createEdge({
    source_id: source,
    target_id: target,
    edge_type: "about",
  });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return made.data.edge.id;
}

const titles = (archive: Uint8Array) =>
  new Map(
    archiveLines<{ item: MarfaItem }>(archive, "items").map((line) => [
      line.item.id,
      line.item.properties.title,
    ]),
  );

describe("an archive whose selection is read while writes land", () => {
  it("carries the selection as it stood when the read began, and counts what its line files hold", async () => {
    const a = await note("a as read");
    const b = await note("b");
    const c = await note("c");
    const early = await edge(a.id, b.id);

    await server.setFault("hold:export-page=1");
    const pending = working.exportArchive();
    let later = "";
    let lateEdge = "";
    try {
      await server.waitForHold("hold:export-page");
      const updated = await working.updateItem(a.id, {
        version: a.version,
        properties: { title: "a written during the read" },
      });
      expect(updated.status, JSON.stringify(updated.error)).toBe(200);
      later = (await note("written during the read")).id;
      lateEdge = await edge(b.id, c.id);
    } finally {
      await server.clearFault();
    }
    const archive = await pending;
    expect(archive.status).toBe(200);

    const carried = titles(archive.data);
    expect([...carried.keys()].sort()).toEqual([a.id, b.id, c.id].sort());
    expect(carried.get(a.id)).toBe("a as read");
    const edges = archiveLines<{ edge: MarfaEdge }>(archive.data, "edges").map(
      (line) => line.edge.id,
    );
    expect(edges).toEqual([early]);
    const manifest = archiveManifest<{
      item_count: number;
      edge_count: number;
    }>(archive.data);
    expect(manifest.item_count).toBe(carried.size);
    expect(manifest.edge_count).toBe(edges.length);

    // The witness: every write landed, and the next archive carries it.
    const next = await working.exportArchive();
    expect(next.status).toBe(200);
    const now = titles(next.data);
    expect(now.has(later)).toBe(true);
    expect(now.get(a.id)).toBe("a written during the read");
    expect(
      archiveLines<{ edge: MarfaEdge }>(next.data, "edges").map(
        (line) => line.edge.id,
      ),
    ).toContain(lateEdge);
  });
});
