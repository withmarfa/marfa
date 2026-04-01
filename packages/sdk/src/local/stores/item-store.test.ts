import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Item } from "@myme/shared";
import { createLocalConnection } from "../connection.js";
import { LocalItemStore } from "./item-store.js";

let store: LocalItemStore;
let close: () => void;

const testItem: Item = {
  id: "01900000-0000-7000-8000-000000000001",
  type: "core.note",
  state: "active",
  properties: { body: "Test note", title: "Hello" },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  timestamp: "2026-01-01T00:00:00Z",
  version: 1,
};

beforeAll(() => {
  const conn = createLocalConnection(":memory:");
  store = new LocalItemStore(conn.db);
  close = conn.close;
});

afterAll(() => {
  close();
});

describe("LocalItemStore", () => {
  it("upserts and retrieves an item", () => {
    store.upsert(testItem);
    const result = store.get(testItem.id);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(testItem.id);
    expect(result?.type).toBe("core.note");
    expect(result?.properties).toEqual({ body: "Test note", title: "Hello" });
  });

  it("returns null for missing item", () => {
    expect(store.get("nonexistent")).toBeNull();
  });

  it("lists items with filters", () => {
    const item2: Item = {
      ...testItem,
      id: "01900000-0000-7000-8000-000000000002",
      type: "core.bookmark",
      properties: { url: "https://example.com" },
    };
    store.upsert(item2);

    const all = store.list();
    expect(all.data.length).toBe(2);

    const notes = store.list({ type: "core.note" });
    expect(notes.data.length).toBe(1);
    expect(notes.data[0]?.type).toBe("core.note");
  });

  it("updates an existing item on upsert", () => {
    const updated: Item = {
      ...testItem,
      properties: { body: "Updated note" },
      version: 2,
      updated_at: "2026-01-02T00:00:00Z",
    };
    store.upsert(updated);

    const result = store.get(testItem.id);
    expect(result?.version).toBe(2);
    expect(result?.properties).toEqual({ body: "Updated note" });
  });

  it("removes an item", () => {
    store.remove(testItem.id);
    expect(store.get(testItem.id)).toBeNull();
  });
});
