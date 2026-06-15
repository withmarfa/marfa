import { describe, it, expect } from "vitest";
import { createInMemoryStorage } from "./in-memory-storage.js";

describe("createInMemoryStorage", () => {
  it("round-trips a value", async () => {
    const s = createInMemoryStorage();
    await s.put("k", { x: 1 });
    expect(await s.get("k")).toEqual({ x: 1 });
  });

  it("delete returns true when the key existed", async () => {
    const s = createInMemoryStorage();
    await s.put("k", "v");
    expect(await s.delete("k")).toBe(true);
    expect(await s.delete("k")).toBe(false);
  });

  it("list filters by prefix", async () => {
    const s = createInMemoryStorage();
    await s.put("cursor:a", 1);
    await s.put("cursor:b", 2);
    await s.put("error:0", 3);
    const found = await s.list({ prefix: "cursor:" });
    expect(found.size).toBe(2);
    expect(found.get("cursor:a")).toBe(1);
  });

  it("list honors limit", async () => {
    const s = createInMemoryStorage();
    for (let i = 0; i < 5; i++) await s.put(`k${String(i)}`, i);
    const found = await s.list({ limit: 2 });
    expect(found.size).toBe(2);
  });

  it("snapshot returns a copy that is decoupled from subsequent writes", async () => {
    const s = createInMemoryStorage();
    await s.put("k", 1);
    const snap = s.snapshot();
    await s.put("k", 2);
    expect(snap.get("k")).toBe(1);
  });

  it("reset clears every entry", async () => {
    const s = createInMemoryStorage();
    await s.put("k", 1);
    s.reset();
    expect(await s.get("k")).toBeUndefined();
  });

  // ─── by-value semantics on put + get (DO parity) ──────────────────────
  // Without these guarantees, handlers that mutate a cursor object in
  // place leak the mutation back into the stored map. That works in
  // tests (where the storage is a Map of object refs) but breaks in
  // production (where DO storage serializes every value).

  it("put captures by value — caller mutations after put don't leak into storage", async () => {
    const s = createInMemoryStorage();
    const stored = { count: 1 };
    await s.put("k", stored);
    stored.count = 999;
    const read = (await s.get("k")) as { count: number };
    expect(read.count).toBe(1);
  });

  it("get returns by value — mutating the returned object doesn't leak back", async () => {
    const s = createInMemoryStorage();
    await s.put("k", { count: 1 });
    const first = (await s.get("k")) as { count: number };
    first.count = 999;
    const second = (await s.get("k")) as { count: number };
    expect(second.count).toBe(1);
  });

  it("two successive gets return distinct object references", async () => {
    const s = createInMemoryStorage();
    await s.put("k", { count: 1 });
    const a = await s.get("k");
    const b = await s.get("k");
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("list-returned values are also decoupled from stored values", async () => {
    const s = createInMemoryStorage();
    await s.put("cursor:a", { x: 1 });
    const listed = await s.list({ prefix: "cursor:" });
    const got = listed.get("cursor:a") as { x: number };
    got.x = 999;
    const read = (await s.get("cursor:a")) as { x: number };
    expect(read.x).toBe(1);
  });
});
