import { describe, it, expect } from "vitest";
import { generateBulkItems, getScaleCount } from "./bulk.js";

describe("generateBulkItems", () => {
  it("generates the requested number of items", () => {
    const result = generateBulkItems(100);
    expect(result.items).toHaveLength(100);
    expect(result.stats.total).toBe(100);
  });

  it("maintains type distribution within tolerance", () => {
    const result = generateBulkItems(1000);
    const { notes, bookmarks, tasks, entities, works, files } = result.stats;

    // 40% notes +-15%
    expect(notes / 1000).toBeGreaterThan(0.25);
    expect(notes / 1000).toBeLessThan(0.55);

    // 20% bookmarks +-15%
    expect(bookmarks / 1000).toBeGreaterThan(0.05);
    expect(bookmarks / 1000).toBeLessThan(0.35);

    // 10% tasks +-10%
    expect(tasks / 1000).toBeGreaterThan(0.0);
    expect(tasks / 1000).toBeLessThan(0.2);

    // 10% entities +-10%
    expect(entities / 1000).toBeGreaterThan(0.0);
    expect(entities / 1000).toBeLessThan(0.2);

    // 10% works +-10%
    expect(works / 1000).toBeGreaterThan(0.0);
    expect(works / 1000).toBeLessThan(0.2);

    // 10% files +-10%
    expect(files / 1000).toBeGreaterThan(0.0);
    expect(files / 1000).toBeLessThan(0.2);
  });

  it("produces tagged items at approximately the configured rate", () => {
    const result = generateBulkItems(1000, { tagRate: 0.3 });
    // 30% +-15%
    expect(result.stats.tagged / 1000).toBeGreaterThan(0.15);
    expect(result.stats.tagged / 1000).toBeLessThan(0.45);
  });

  it("all items have valid type identifiers", () => {
    const result = generateBulkItems(100);
    const validTypes = [
      "core.note",
      "core.bookmark",
      "core.task",
      "core.entity",
      "core.media",
      "core.file",
    ];
    for (const item of result.items) {
      expect(validTypes).toContain(item.type);
    }
  });

  it("all items have object properties", () => {
    const result = generateBulkItems(100);
    for (const item of result.items) {
      expect(typeof item.properties).toBe("object");
      expect(item.properties).not.toBeNull();
    }
  });

  it("applies source when provided", () => {
    const result = generateBulkItems(50, { source: "test-source" });

    for (const item of result.items) {
      expect(item.source).toBe("test-source");
    }
  });

  it("tags are flat string arrays", () => {
    const result = generateBulkItems(100, { tagRate: 1.0 });

    for (const item of result.items) {
      if (item.tags && item.tags.length > 0) {
        for (const tag of item.tags) {
          expect(typeof tag).toBe("string");
        }
      }
    }
  });
});

describe("getScaleCount", () => {
  it("returns 1000 for small", () => {
    expect(getScaleCount("small")).toBe(1000);
  });

  it("returns 10000 for medium", () => {
    expect(getScaleCount("medium")).toBe(10000);
  });

  it("returns 100000 for large", () => {
    expect(getScaleCount("large")).toBe(100000);
  });
});
