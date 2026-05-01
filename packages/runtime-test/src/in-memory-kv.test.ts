import { describe, it, expect } from "vitest";
import { createInMemoryKV } from "./in-memory-kv.js";

describe("createInMemoryKV", () => {
  it("round-trips a value", async () => {
    const kv = createInMemoryKV();
    await kv.put("k", "v");
    expect(await kv.get("k")).toBe("v");
  });

  it("get returns null for missing keys", async () => {
    const kv = createInMemoryKV();
    expect(await kv.get("missing")).toBeNull();
  });

  it("delete removes the key", async () => {
    const kv = createInMemoryKV();
    await kv.put("k", "v");
    await kv.delete("k");
    expect(await kv.get("k")).toBeNull();
  });

  it("expirationTtl evicts the key on the next get past expiry", async () => {
    let now = 1_000_000;
    const kv = createInMemoryKV(() => now);
    await kv.put("k", "v", { expirationTtl: 60 });
    expect(await kv.get("k")).toBe("v");
    now += 30_000;
    expect(await kv.get("k")).toBe("v");
    now += 31_000; // total 61s
    expect(await kv.get("k")).toBeNull();
  });

  it("snapshot returns the backing entries", async () => {
    const kv = createInMemoryKV();
    await kv.put("a", "1");
    await kv.put("b", "2", { expirationTtl: 60 });
    const snap = kv.snapshot();
    expect(snap.size).toBe(2);
    expect(snap.get("a")?.expires_at).toBeNull();
    expect(snap.get("b")?.expires_at).not.toBeNull();
  });
});
