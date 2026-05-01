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

  it("list honours limit", async () => {
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
});
