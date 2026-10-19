import { afterAll, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { MarfaItem } from "../../client/types.js";
import { listTarGzEntries } from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { DISK_ONLY } from "../../utils/own-blob-server.js";

let source: FreshServer;
let target: FreshServer;
beforeAll(async () => {
  source = await bootFreshServer("export-write-order", DISK_ONLY);
  target = await bootFreshServer("export-write-order-target", DISK_ONLY);
}, 2 * FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  await Promise.all([source?.stop(), target?.stop()]);
}, FRESH_SERVER_TIMEOUT_MS);

it("restores an archive after writes land between its item pages", async () => {
  const client = new MarfaClient({
    baseUrl: source.apiUrl,
    apiKey: source.workingKey,
  });
  const made = await client.bulkItems(
    Array.from({ length: 60 }, (_, at) => ({
      type: "core.note",
      properties: { body: `note ${String(at)}` },
    })),
  );
  expect(made.status).toBe(200);
  const listed = await client.listItems({ limit: 100 });
  expect(listed.status).toBe(200);
  const newest = listed.data.data[0]!;
  const oldest = listed.data.data.at(-1)!;
  const retained = listed.data.data[1]!;
  const witness = await client.createEdge({
    source_id: newest.id,
    target_id: retained.id,
    edge_type: "references",
  });
  expect(witness.status).toBe(201);
  await source.setFault("hold:export-page=1");
  const pending = client.exportArchive();
  try {
    await source.waitForHold("hold:export-page");
    expect(
      (
        await client.updateItem(newest.id, {
          version: newest.version,
          properties: { body: "after page" },
        })
      ).status,
    ).toBe(200);
    expect((await client.deleteItem(oldest.id)).status).toBe(200);
    const added = await client.createItem({
      type: "core.note",
      properties: { body: "after cursor" },
    });
    expect(added.status).toBe(201);
    expect(
      (
        await client.createEdge({
          source_id: added.data.item.id,
          target_id: newest.id,
          edge_type: "references",
        })
      ).status,
    ).toBe(201);
    await source.clearFault();
    const exported = await pending;
    expect(exported.status).toBe(200);
    const entries = listTarGzEntries(exported.data);
    const items = entries
      .find((entry) => entry.name === "items.ndjson")!
      .body.toString()
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { item: MarfaItem }).item);
    expect(items).toHaveLength(59);
    expect(items.find((item) => item.id === newest.id)?.properties).toEqual(
      newest.properties,
    );
    expect(items.map((item) => item.id)).not.toContain(oldest.id);
    expect(items.map((item) => item.id)).not.toContain(added.data.item.id);
    const owner = new MarfaClient({
      baseUrl: target.apiUrl,
      ownerCookie: target.ownerCookie,
    });
    const restored = await owner.restoreArchive(exported.data);
    expect(restored.status, JSON.stringify(restored.error)).toBe(200);
    expect(restored.data).toMatchObject({
      imported: 59,
      edges_imported: 1,
      edges_skipped: 0,
    });
    const reader = new MarfaClient({
      baseUrl: target.apiUrl,
      apiKey: target.workingKey,
    });
    expect((await reader.getItem(newest.id)).data.item.properties).toEqual(
      newest.properties,
    );
    expect(
      (await reader.getEdge(witness.data.edge.id)).data.edge.target_id,
    ).toBe(retained.id);
  } finally {
    await source.clearFault();
    await pending;
  }
});
