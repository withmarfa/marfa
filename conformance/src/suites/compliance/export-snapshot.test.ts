import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { MarfaEdge, MarfaItem, TableRow } from "../../client/types.js";
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
let destination: FreshServer;
let destinationOwner: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("export-snapshot", DISK_ONLY);
  ({ working } = clientsFor(server));
  destination = await bootFreshServer("export-snapshot-destination", DISK_ONLY);
  destinationOwner = new MarfaClient({
    baseUrl: destination.apiUrl,
    controlSocket: destination.controlSocket,
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.clearFault();
  await server.stop();
  await destination.stop();
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

  it("carries the rows as they stood when the read began, counts them in row_count, and restores them whole", async () => {
    const type = "user.export_snapshot_ledger";
    const registered = await working.registerType({
      id: type,
      fields: { title: { type: "string" } },
      tables: { lines: { columns: { amount: { type: "number" } } } },
    } as never);
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const typed = async (title: string) => {
      const made = await working.createItem({
        type,
        properties: { title },
      } as never);
      expect(made.status, JSON.stringify(made.error)).toBe(201);
      return made.data.item;
    };
    const rowsOf = async (itemId: string): Promise<TableRow[]> => {
      const listed = await working.listRows(itemId, "lines", { limit: 1000 });
      expect(listed.status, JSON.stringify(listed.error)).toBe(200);
      return listed.data.data;
    };
    const put = async (itemId: string, amounts: number[]) => {
      const written = await working.writeRows(itemId, "lines", {
        operations: amounts.map((amount) => ({
          op: "put" as const,
          values: { amount },
        })),
      });
      expect(written.status, JSON.stringify(written.error)).toBe(200);
      return written.data.results.map((result) => result.id);
    };

    const kept = await typed("rows kept");
    const doomed = await typed("rows doomed");
    const [patched, removed] = await put(kept.id, [1, 2, 3]);
    await put(doomed.id, [7]);
    const before = {
      kept: await rowsOf(kept.id),
      doomed: await rowsOf(doomed.id),
    };

    await server.setFault("hold:export-page=1");
    const pending = working.exportArchive();
    let added = "";
    try {
      await server.waitForHold("hold:export-page");
      [added] = await put(kept.id, [4]);
      const changed = await working.writeRows(kept.id, "lines", {
        operations: [
          { op: "patch", id: patched!, values: { amount: 10 } },
          { op: "delete", id: removed! },
        ],
      });
      expect(changed.status, JSON.stringify(changed.error)).toBe(200);
      await put(doomed.id, [8]);
      expect((await working.deleteItem(doomed.id)).status).toBe(200);
      expect((await working.purgeItem(doomed.id)).status).toBe(200);
    } finally {
      await server.clearFault();
    }
    const archive = await pending;
    expect(archive.status).toBe(200);

    interface Line {
      item_id: string;
      table: string;
      id: string;
      values: Record<string, unknown>;
    }
    const lines = archiveLines<Line>(archive.data, "rows");
    const held = (itemId: string) =>
      lines
        .filter((line) => line.item_id === itemId)
        .map((line) => ({ id: line.id, values: line.values }))
        .sort((a, b) => a.id.localeCompare(b.id));
    const stood = (rows: TableRow[]) =>
      rows
        .map((row) => ({ id: row.id, values: row.values }))
        .sort((a, b) => a.id.localeCompare(b.id));
    expect(held(kept.id)).toEqual(stood(before.kept));
    expect(held(doomed.id)).toEqual(stood(before.doomed));
    expect(lines.length).toBe(before.kept.length + before.doomed.length);
    expect(archiveManifest<{ row_count: number }>(archive.data).row_count).toBe(
      lines.length,
    );

    // The witness: the writes landed, and the next archive carries them.
    const next = await working.exportArchive();
    expect(next.status).toBe(200);
    const now = archiveLines<Line>(next.data, "rows");
    expect(now.find((line) => line.id === added)?.values).toEqual({
      amount: 4,
    });
    expect(now.find((line) => line.id === patched)?.values).toEqual({
      amount: 10,
    });
    expect(now.some((line) => line.id === removed)).toBe(false);
    expect(now.some((line) => line.item_id === doomed.id)).toBe(false);

    const restored = await destinationOwner.restoreArchive(archive.data);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data).toMatchObject({
      rows_imported: lines.length,
      rows_skipped: 0,
    });
    const restoredRows = async (itemId: string) => {
      const listed = await new MarfaClient({
        baseUrl: destination.apiUrl,
        apiKey: destination.workingKey,
      }).listRows(itemId, "lines", { limit: 1000 });
      expect(listed.status, JSON.stringify(listed.error)).toBe(200);
      return listed.data.data;
    };
    expect(await restoredRows(kept.id)).toEqual(before.kept);
    expect(await restoredRows(doomed.id)).toEqual(before.doomed);
  });
});
