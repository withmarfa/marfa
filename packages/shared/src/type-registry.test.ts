import { describe, expect, it } from "vitest";
import {
  TYPE_REGISTRY,
  getTypeSchema,
  getResolvedFields,
  isSubtypeOf,
  validateProperties,
  validateTransition,
  validateTypeSchema,
} from "./type-registry.js";
import type { ItemState } from "@mymehq/types";

describe("TYPE_REGISTRY", () => {
  it("contains exactly 21 core types", () => {
    expect(TYPE_REGISTRY.size).toBe(21);
  });

  it("contains all media group types", () => {
    const mediaTypes = [
      "core.media",
      "core.media.book",
      "core.media.article",
      "core.media.film",
      "core.media.song",
      "core.media.album",
      "core.media.podcast",
      "core.media.series",
      "core.media.tv_episode",
    ];
    for (const id of mediaTypes) {
      expect(TYPE_REGISTRY.has(id), `missing ${id}`).toBe(true);
    }
  });

  it("contains all entity group types", () => {
    const entityTypes = [
      "core.entity",
      "core.entity.person",
      "core.entity.place",
    ];
    for (const id of entityTypes) {
      expect(TYPE_REGISTRY.has(id), `missing ${id}`).toBe(true);
    }
  });

  it("contains all file group types", () => {
    const fileTypes = [
      "core.file",
      "core.file.image",
      "core.file.audio",
      "core.file.video",
    ];
    for (const id of fileTypes) {
      expect(TYPE_REGISTRY.has(id), `missing ${id}`).toBe(true);
    }
  });

  it("contains all standalone types", () => {
    const standalone = [
      "core.note",
      "core.bookmark",
      "core.task",
      "core.event",
      "core.highlight",
    ];
    for (const id of standalone) {
      expect(TYPE_REGISTRY.has(id), `missing ${id}`).toBe(true);
    }
  });

  it("excludes deferred and removed V0 types", () => {
    // core.message is deferred post-V0; core.collection is removed entirely.
    expect(TYPE_REGISTRY.has("core.message")).toBe(false);
    expect(TYPE_REGISTRY.has("core.collection")).toBe(false);
  });
});

describe("getTypeSchema", () => {
  it("returns schema for known type", () => {
    const schema = getTypeSchema("core.note");
    expect(schema).toBeDefined();
    expect(schema?.id).toBe("core.note");
  });

  it("returns undefined for unknown type", () => {
    expect(getTypeSchema("core.nonexistent")).toBeUndefined();
  });
});

describe("getResolvedFields", () => {
  it("returns own fields plus universal fields for standalone types", () => {
    const fields = getResolvedFields("core.note");
    expect(fields).toBeDefined();
    expect(fields).toHaveProperty("body");
    expect(fields).toHaveProperty("body.required", true);
    expect(fields).toHaveProperty("title");
    expect(fields).toHaveProperty("language");
    expect(fields).toHaveProperty("attachments");
    expect(fields).toHaveProperty("links");
  });

  it("merges parent fields into subtype", () => {
    const fields = getResolvedFields("core.media.book");
    expect(fields).toBeDefined();
    expect(fields).toHaveProperty("title");
    expect(fields).toHaveProperty("title.required", true);
    expect(fields).toHaveProperty("author");
    expect(fields).toHaveProperty("isbn");
    expect(fields).toHaveProperty("page_count");
    expect(fields).toHaveProperty("attachments");
  });

  it("subtype fields override parent fields of the same name", () => {
    const fields = getResolvedFields("core.media.article");
    expect(fields).toHaveProperty("body.required", true);
  });

  it("returns undefined for unknown type", () => {
    expect(getResolvedFields("core.nonexistent")).toBeUndefined();
  });
});

describe("isSubtypeOf", () => {
  it("returns true for same type", () => {
    expect(isSubtypeOf("core.note", "core.note")).toBe(true);
  });

  it("returns true for direct subtype", () => {
    expect(isSubtypeOf("core.media.book", "core.media")).toBe(true);
  });

  it("returns false for unrelated types", () => {
    expect(isSubtypeOf("core.note", "core.media")).toBe(false);
  });

  it("returns false when child and parent are reversed", () => {
    expect(isSubtypeOf("core.media", "core.media.book")).toBe(false);
  });

  it("returns false for unknown type", () => {
    expect(isSubtypeOf("core.nonexistent", "core.media")).toBe(false);
  });
});

describe("validateProperties", () => {
  it("accepts valid properties for core.note", () => {
    const result = validateProperties("core.note", {
      body: "Hello world",
      title: "My note",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required field", () => {
    const result = validateProperties("core.note", {
      title: "My note",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.field === "body")).toBe(true);
    }
  });

  it("preserves custom fields (passthrough)", () => {
    const result = validateProperties("core.note", {
      body: "Hello",
      custom_field: "preserved",
      reading_time: 5,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveProperty("custom_field", "preserved");
      expect(result.data).toHaveProperty("reading_time", 5);
    }
  });

  it("validates field types", () => {
    const result = validateProperties("core.note", {
      body: 123, // should be string
    });
    expect(result.success).toBe(false);
  });

  it("validates enum values", () => {
    const result = validateProperties("core.highlight", {
      text: "Passage",
      color: "chartreuse",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid enum values", () => {
    const result = validateProperties("core.highlight", {
      text: "Passage",
      color: "yellow",
    });
    expect(result.success).toBe(true);
  });

  it("validates subtype with inherited required fields", () => {
    // core.media.book inherits title (required) from core.media
    const result = validateProperties("core.media.book", {
      isbn: "978-0-13-468599-1",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.field === "title")).toBe(true);
    }
  });

  it("accepts valid subtype properties including inherited fields", () => {
    const result = validateProperties("core.media.book", {
      title: "Clean Code",
      isbn: "978-0-13-468599-1",
      page_count: 464,
    });
    expect(result.success).toBe(true);
  });

  it("validates integer fields reject floats", () => {
    const result = validateProperties("core.media.book", {
      title: "A Book",
      page_count: 3.5,
    });
    expect(result.success).toBe(false);
  });

  it("validates url fields", () => {
    const result = validateProperties("core.bookmark", {
      url: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid url fields", () => {
    const result = validateProperties("core.bookmark", {
      url: "https://example.com",
    });
    expect(result.success).toBe(true);
  });

  it("returns error for unknown type", () => {
    const result = validateProperties("core.nonexistent", { body: "hi" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]).toHaveProperty("field", "_type");
    }
  });

  it("validates file types with multiple required fields", () => {
    const result = validateProperties("core.file.image", {
      blob_ref: "sha256:abc",
      mime_type: "image/png",
      // missing width and height
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.errors.map((e) => e.field);
      expect(fields).toContain("width");
      expect(fields).toContain("height");
    }
  });

  it("accepts valid file.image with all required fields", () => {
    const result = validateProperties("core.file.image", {
      blob_ref: "sha256:abc",
      mime_type: "image/png",
      width: 1920,
      height: 1080,
    });
    expect(result.success).toBe(true);
  });
});

describe("validateTransition", () => {
  it("allows active -> archived", () => {
    expect(validateTransition("core.note", "active", "archived")).toBeNull();
  });

  it("allows active -> trashed", () => {
    expect(validateTransition("core.note", "active", "trashed")).toBeNull();
  });

  it("allows archived -> active", () => {
    expect(validateTransition("core.note", "archived", "active")).toBeNull();
  });

  it("allows archived -> trashed", () => {
    expect(validateTransition("core.note", "archived", "trashed")).toBeNull();
  });

  it("allows trashed -> active (restore)", () => {
    expect(validateTransition("core.note", "trashed", "active")).toBeNull();
  });

  it("rejects trashed -> archived", () => {
    const error = validateTransition("core.note", "trashed", "archived");
    expect(error).not.toBeNull();
  });

  it("rejects active -> active (no-op)", () => {
    const error = validateTransition("core.note", "active", "active");
    expect(error).not.toBeNull();
  });

  it("returns error for unknown type", () => {
    const error = validateTransition("core.nonexistent", "active", "archived");
    expect(error).not.toBeNull();
  });

  it("returns error for invalid current state", () => {
    const error = validateTransition(
      "core.note",
      "bogus" as ItemState,
      "active",
    );
    expect(error).not.toBeNull();
  });

  it("returns error for invalid target state", () => {
    const error = validateTransition(
      "core.note",
      "active",
      "bogus" as ItemState,
    );
    expect(error).not.toBeNull();
  });
});

describe("validateTypeSchema — inheritance rule", () => {
  it("rejects a child type that redefines a direct parent field", () => {
    const result = validateTypeSchema({
      id: "acme.bookmark_ext",
      parent: "core.bookmark",
      version: 1,
      fields: {
        title: { type: "string", description: "Different title meaning" },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.errors.some(
          (e) =>
            e.field === "fields.title" && e.message.includes("core.bookmark"),
        ),
      ).toBe(true);
    }
  });

  it("rejects a child type that redefines a deep-ancestor field", () => {
    // core.entity.person inherits name from core.entity; a child of
    // core.entity.person must not redeclare name.
    const result = validateTypeSchema({
      id: "acme.employee",
      parent: "core.entity.person",
      version: 1,
      fields: {
        name: { type: "string", description: "Override" },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.errors.some(
          (e) =>
            e.field === "fields.name" && e.message.includes("core.entity"),
        ),
      ).toBe(true);
    }
  });

  it("accepts a child type that adds new fields without collisions", () => {
    const result = validateTypeSchema({
      id: "acme.bookmark_ext",
      parent: "core.bookmark",
      version: 1,
      fields: {
        acme_category: { type: "string", description: "Internal tag" },
        acme_score: { type: "integer", description: "Priority" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a type without a parent regardless of field names", () => {
    const result = validateTypeSchema({
      id: "acme.thing",
      version: 1,
      fields: {
        title: { type: "string", description: "A title" },
        body: { type: "string", description: "Body text" },
      },
    });
    expect(result.success).toBe(true);
  });
});
