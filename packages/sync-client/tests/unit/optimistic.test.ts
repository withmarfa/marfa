import { describe, expect, it } from "vitest";
import { OptimisticItemStore } from "../../src/optimistic/store.js";
import type { Item } from "@mymehq/shared";

function makeItem(id: string, version = 1, props: Record<string, unknown> = {}): Item {
  const now = new Date().toISOString();
  return {
    id,
    type: "core.note",
    state: "active",
    library: false,
    properties: props,
    created_at: now,
    updated_at: now,
    timestamp: now,
    source: "test",
    source_id: id,
    origin: "user",
    version,
    schema_version: 1,
  };
}

describe("OptimisticItemStore", () => {
  it("apply + get returns the staged item", () => {
    const store = new OptimisticItemStore();
    const item = makeItem("a");
    store.applyItem(item);
    expect(store.get("a")).toEqual(item);
  });

  it("tombstone causes get to return null", () => {
    const store = new OptimisticItemStore();
    store.applyTombstone("a");
    expect(store.get("a")).toBeNull();
  });

  it("clear drops the entry — get falls through to undefined", () => {
    const store = new OptimisticItemStore();
    store.applyItem(makeItem("a"));
    store.clear("a");
    expect(store.get("a")).toBeUndefined();
  });

  it("overlay replaces matching canonical rows", () => {
    const store = new OptimisticItemStore();
    const canonical = [makeItem("a", 1, { v: "old" })];
    store.applyItem(makeItem("a", 2, { v: "new" }));
    const merged = store.overlay(canonical);
    expect(merged).toHaveLength(1);
    expect((merged[0] as Item).properties).toEqual({ v: "new" });
    expect((merged[0] as Item).version).toBe(2);
  });

  it("overlay drops tombstoned canonical rows", () => {
    const store = new OptimisticItemStore();
    const canonical = [makeItem("a"), makeItem("b")];
    store.applyTombstone("a");
    const merged = store.overlay(canonical);
    expect(merged.map((i) => i.id)).toEqual(["b"]);
  });

  it("overlay appends optimistic-only ids", () => {
    const store = new OptimisticItemStore();
    const canonical = [makeItem("a")];
    store.applyItem(makeItem("b"));
    const merged = store.overlay(canonical);
    expect(merged.map((i) => i.id).sort()).toEqual(["a", "b"]);
  });

  it("subscribers fire per-id on apply, tombstone, and clear", () => {
    const store = new OptimisticItemStore();
    const seen: string[] = [];
    store.subscribe((id) => seen.push(id));
    store.applyItem(makeItem("a"));
    store.applyTombstone("b");
    store.clear("a");
    expect(seen).toEqual(["a", "b", "a"]);
  });

  it("clear on a non-existent id is a no-op (no listener fire)", () => {
    const store = new OptimisticItemStore();
    const seen: string[] = [];
    store.subscribe((id) => seen.push(id));
    store.clear("nope");
    expect(seen).toEqual([]);
  });
});
