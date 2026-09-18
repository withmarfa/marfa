import { describe, it, expect } from "vitest";
import {
  generateId,
  isoNow,
  isoOffset,
  createItem,
  createNote,
  createBookmark,
  createTask,
  createEntity,
  createPerson,
  createPlace,
  createBook,
} from "./items.js";

const UUID_V7_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("generateId", () => {
  it("returns a valid UUIDv7 string", () => {
    const id = generateId();
    expect(id).toMatch(UUID_V7_REGEX);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });

  it("generates lexicographically sortable IDs across milliseconds", async () => {
    const first = generateId();
    await new Promise((r) => setTimeout(r, 2));
    const second = generateId();
    expect(second > first).toBe(true);
  });
});

describe("isoNow", () => {
  it("returns a valid ISO 8601 timestamp", () => {
    const ts = isoNow();
    expect(() => new Date(ts)).not.toThrow();
    expect(new Date(ts).toISOString()).toBeTruthy();
  });
});

describe("isoOffset", () => {
  it("returns a timestamp offset from now", () => {
    const now = Date.now();
    const offset = isoOffset(1000);
    const parsed = new Date(offset).getTime();
    expect(parsed).toBeGreaterThanOrEqual(now + 900);
    expect(parsed).toBeLessThanOrEqual(now + 1100);
  });
});

describe("createItem", () => {
  it("creates an item with defaults", () => {
    const item = createItem();
    expect(item.type).toBe("core.note");
    expect(typeof item.properties).toBe("object");
    expect(item.properties).toBeDefined();
  });

  it("allows overriding all fields", () => {
    const item = createItem({
      type: "core.bookmark",
      source: "test",
      source_id: "test-1",
      tags: ["tag1", "tag2"],
    });
    expect(item.type).toBe("core.bookmark");
    expect(item.source).toBe("test");
    expect(item.source_id).toBe("test-1");
    expect(item.tags).toEqual(["tag1", "tag2"]);
  });
});

describe("createNote", () => {
  it("creates a note item", () => {
    const note = createNote();
    expect(note.type).toBe("core.note");
    expect(note.properties?.title).toBeDefined();
    expect(note.properties?.body).toBeDefined();
  });
});

describe("createBookmark", () => {
  it("creates a bookmark item", () => {
    const bookmark = createBookmark();
    expect(bookmark.type).toBe("core.bookmark");
    expect(bookmark.properties?.url).toBeDefined();
    expect(bookmark.properties?.title).toBeDefined();
  });
});

describe("createTask", () => {
  it("creates a task item", () => {
    const task = createTask();
    expect(task.type).toBe("core.task");
    expect(task.properties?.title).toBeDefined();
    expect(task.properties?.status).toBe("pending");
  });
});

describe("createEntity", () => {
  it("creates an entity item", () => {
    const entity = createEntity();
    expect(entity.type).toBe("core.entity");
    expect(entity.properties?.name).toBeDefined();
  });
});

describe("createPerson", () => {
  it("creates a person entity item", () => {
    const person = createPerson();
    expect(person.type).toBe("core.entity.person");
    expect(person.properties?.name).toBeDefined();
    expect(person.properties?.given_name).toBeDefined();
  });
});

describe("createPlace", () => {
  it("creates a place entity item", () => {
    const place = createPlace();
    expect(place.type).toBe("core.entity.place");
    expect(place.properties?.name).toBeDefined();
    expect(place.properties?.latitude).toBeDefined();
  });
});

describe("createBook", () => {
  it("creates a book work item", () => {
    const book = createBook();
    expect(book.type).toBe("core.media.book");
    expect(book.properties?.title).toBeDefined();
    expect(book.properties?.isbn).toBeDefined();
  });
});
