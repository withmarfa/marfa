import { describe, it, expect } from "vitest";
import { createCursorStore } from "./cursor-store.js";
import { createInMemoryStorage } from "./in-memory-storage.js";

describe("cursor store", () => {
  it("returns null for an unwritten cursor", async () => {
    const store = createCursorStore(createInMemoryStorage());
    expect(await store.read("github_issues")).toBeNull();
  });

  it("round-trips arbitrary JSON", async () => {
    const store = createCursorStore(createInMemoryStorage());
    await store.write("github_issues", { since: "2026-01-01", page: 3 });
    expect(await store.read("github_issues")).toEqual({
      since: "2026-01-01",
      page: 3,
    });
  });

  it("isolates cursors by trigger key", async () => {
    const store = createCursorStore(createInMemoryStorage());
    await store.write("a", "alpha");
    await store.write("b", "bravo");
    expect(await store.read("a")).toBe("alpha");
    expect(await store.read("b")).toBe("bravo");
  });

  it("clear() returns null on subsequent read", async () => {
    const store = createCursorStore(createInMemoryStorage());
    await store.write("k", "v");
    await store.clear("k");
    expect(await store.read("k")).toBeNull();
  });
});
