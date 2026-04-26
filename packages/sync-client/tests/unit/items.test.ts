import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MymeSyncClient } from "../../src/client.js";

let client: MymeSyncClient;

beforeEach(async () => {
  client = new MymeSyncClient({
    apiUrl: "http://localhost:0",
    apiKey: "myme_k1_test",
    storage: "memory",
    autoStartSync: false,
  });
  await client.start();
});

afterEach(async () => {
  await client.stop();
});

describe("ItemsApi — optimistic local writes", () => {
  it("create inserts into local PGlite immediately", async () => {
    const item = await client.items.create({
      type: "core.note",
      properties: { title: "Hello", body: "world" },
    });
    expect(item.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(item.type).toBe("core.note");
    expect(item.state).toBe("active");
    expect(item.version).toBe(1);

    const fetched = await client.items.get(item.id);
    expect(fetched).toEqual(item);
    expect(await client.pendingMutationCount()).toBe(1);
  });

  it("list returns active items only by default", async () => {
    const a = await client.items.create({
      type: "core.note",
      properties: { title: "a" },
    });
    const b = await client.items.create({
      type: "core.note",
      properties: { title: "b" },
    });
    await client.items.delete(b.id);

    const list = await client.items.list({ type: "core.note" });
    expect(list.map((i) => i.id)).toEqual([a.id]);
  });

  it("update bumps version and merges properties", async () => {
    const item = await client.items.create({
      type: "core.note",
      properties: { title: "old", body: "x" },
    });
    const updated = await client.items.update(item.id, { title: "new" });
    expect(updated.version).toBe(2);
    expect(updated.properties).toEqual({ title: "new", body: "x" });
  });

  it("delete tombstones the item — local reads return null until rejected", async () => {
    // Post-Bug-2 semantics: delete stages a tombstone in the
    // optimistic store. Reads return null. The canonical row, when
    // it arrives via Electric in the trashed state, is filtered out
    // by `list({state != trashed})` and the reconciler clears the
    // tombstone. Pre-fix behaviour was to write `state = 'trashed'`
    // directly to PGlite — see the items_pkey collision test in
    // tests/integration/writes.integration.test.ts for why that was
    // changed.
    const item = await client.items.create({
      type: "core.note",
      properties: { title: "x" },
    });
    await client.items.delete(item.id);
    expect(await client.items.get(item.id)).toBeNull();
  });

  it("transition changes the state", async () => {
    const item = await client.items.create({
      type: "core.note",
      properties: { title: "x" },
    });
    const archived = await client.items.transition(item.id, "archived");
    expect(archived.state).toBe("archived");
  });

  it("each mutation enqueues exactly one queue row", async () => {
    const item = await client.items.create({
      type: "core.note",
      properties: { title: "x" },
    });
    expect(await client.pendingMutationCount()).toBe(1);
    await client.items.update(item.id, { title: "y" });
    expect(await client.pendingMutationCount()).toBe(2);
    await client.items.delete(item.id);
    expect(await client.pendingMutationCount()).toBe(3);
  });
});
