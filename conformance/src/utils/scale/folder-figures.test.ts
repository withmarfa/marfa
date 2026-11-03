import { describe, expect, it } from "vitest";
import {
  EDIT_POLL_LIMIT,
  editPollPath,
  FIRST_SYNC_COVERS,
  firstSyncMs,
} from "./folder-figures.js";

describe("editPollPath", () => {
  const url = new URL(editPollPath("scale-folder"), "http://server");

  it("reads the folder's notes by the time they last changed, newest first", () => {
    expect(url.pathname).toBe("/items");
    expect(url.searchParams.get("source")).toBe("scale-folder");
    expect(url.searchParams.get("sort")).toBe("updated_at");
    expect(url.searchParams.get("direction")).toBe("desc");
  });

  it("reads a small page and no `updated_after`, which the server refuses with a sort", () => {
    expect(url.searchParams.get("limit")).toBe(String(EDIT_POLL_LIMIT));
    expect(EDIT_POLL_LIMIT).toBeLessThanOrEqual(50);
    expect(url.searchParams.has("updated_after")).toBe(false);
  });

  it("escapes a source", () => {
    const odd = new URL(editPollPath("a&b c"), "http://server");
    expect(odd.searchParams.get("source")).toBe("a&b c");
  });
});

describe("firstSyncMs", () => {
  it("runs from before the add to the end of the push, gaps included", () => {
    expect(firstSyncMs(1_000, 31_000)).toBe(30_000);
  });

  it("says which commands it covers", () => {
    expect(FIRST_SYNC_COVERS).toMatch(/folders add/);
    expect(FIRST_SYNC_COVERS).toMatch(/hydrate/);
    expect(FIRST_SYNC_COVERS).toMatch(/scan/);
    expect(FIRST_SYNC_COVERS).toMatch(/push/);
  });
});
