import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RESERVED_ITEM_FIELDS,
  TYPE_REGISTRY,
  getTypeSchema,
  getResolvedFields,
  isSubtypeOf,
  registerTypeSchema,
  unregisterTypeSchema,
  validateProperties,
  validateTransition,
  validateTypeSchema,
} from "./type-registry.js";
import type { ItemState } from "@mymehq/types";
import type { Item } from "./types.js";

describe("TYPE_REGISTRY", () => {
  it("contains 22 core types and 7 system types (TSC42 §4)", () => {
    expect(TYPE_REGISTRY.size).toBe(29);
    expect(TYPE_REGISTRY.has("system.device")).toBe(true);
    expect(TYPE_REGISTRY.has("system.credential")).toBe(true);
    expect(TYPE_REGISTRY.has("system.webhook")).toBe(true);
    expect(TYPE_REGISTRY.has("system.app")).toBe(true);
    expect(TYPE_REGISTRY.has("system.connection")).toBe(true);
    expect(TYPE_REGISTRY.has("system.activity")).toBe(true);
    expect(TYPE_REGISTRY.has("system.integration")).toBe(true);
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
      "core.message",
    ];
    for (const id of standalone) {
      expect(TYPE_REGISTRY.has(id), `missing ${id}`).toBe(true);
    }
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

describe("core.message — light cross-platform message", () => {
  // T-054: a deliberately light core type. Required fields are body+from;
  // to is optional. Threading reuses existing edges (`in-thread`,
  // `parent-of`) — the schema must NOT carry a `thread_id` field.
  it("registers core.message in TYPE_REGISTRY", () => {
    expect(TYPE_REGISTRY.has("core.message")).toBe(true);
    const schema = getTypeSchema("core.message");
    expect(schema?.id).toBe("core.message");
    expect(schema?.label).toBe("Message");
  });

  it("declares body, from, and to as its own fields with the right requiredness", () => {
    const schema = getTypeSchema("core.message");
    expect(schema?.fields).toBeDefined();
    // The schema's own fields — not the resolved set, which injects the
    // universal `attachments` and `links` fields onto every type.
    expect(Object.keys(schema?.fields ?? {}).sort()).toEqual(
      ["body", "from", "to"].sort(),
    );
    const fields = getResolvedFields("core.message");
    expect(fields).toHaveProperty("body.required", true);
    expect(fields).toHaveProperty("from.required", true);
    // `to` is optional — `required: true` should be absent.
    expect(fields?.to?.required).toBeUndefined();
    expect(fields?.to?.type).toBe("array");
  });

  it("has no thread_id field — threading is edge-based", () => {
    const schema = getTypeSchema("core.message");
    expect(schema?.fields).not.toHaveProperty("thread_id");
  });

  it("accepts a valid message with body and from", () => {
    const result = validateProperties("core.message", {
      body: "Hello",
      from: "+447700900000",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a message missing body", () => {
    const result = validateProperties("core.message", {
      from: "+447700900000",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.field === "body")).toBe(true);
    }
  });

  it("rejects a message missing from", () => {
    const result = validateProperties("core.message", {
      body: "Hello",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.field === "from")).toBe(true);
    }
  });

  it("accepts to as an optional string array", () => {
    const result = validateProperties("core.message", {
      body: "Hi",
      from: "alice@example.com",
      to: ["bob@example.com", "carol@example.com"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects to when not an array", () => {
    const result = validateProperties("core.message", {
      body: "Hi",
      from: "alice@example.com",
      to: "bob@example.com",
    });
    expect(result.success).toBe(false);
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

  it("allows custom (non-core) types to transition", () => {
    // Previously validateTransition rejected any type not in TYPE_REGISTRY
    // with "Unknown type", which broke the universal lifecycle for types
    // registered at runtime via POST /types. Type existence is enforced
    // at item creation, so by the time this function runs the type is
    // known; gating here added nothing.
    expect(
      validateTransition("demo.custom_thing", "active", "archived"),
    ).toBeNull();
    expect(
      validateTransition("demo.custom_thing", "archived", "active"),
    ).toBeNull();
    expect(
      validateTransition("demo.custom_thing", "active", "trashed"),
    ).toBeNull();
    expect(
      validateTransition("demo.custom_thing", "trashed", "active"),
    ).toBeNull();
  });

  it("still blocks invalid transitions for custom types (trashed -> archived)", () => {
    const error = validateTransition(
      "demo.custom_thing",
      "trashed",
      "archived",
    );
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
          (e) => e.field === "fields.name" && e.message.includes("core.entity"),
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

// -----------------------------------------------------------------------------
// Freshness gate for RESERVED_ITEM_FIELDS. The set is hand-maintained in
// type-registry.ts; the source of truth is the Item interface in types.ts.
// This test builds the expected set from a Required<Item> literal so the
// TypeScript shape check enforces "every Item field is present in the literal",
// then asserts the runtime set matches. If Item grows a new field without
// RESERVED_ITEM_FIELDS being updated, this test fails loudly.
// -----------------------------------------------------------------------------
describe("RESERVED_ITEM_FIELDS — freshness against Item interface", () => {
  it("contains exactly the keys present on the Item wire shape", () => {
    // Required<Item> forces every optional Item key to be present in the
    // literal at compile time. The values are sentinels — we never inspect
    // them; only the key set matters.
    const itemShape: Required<Item> = {
      id: "",
      type: "",
      state: "active",
      tier: "library",
      tenant_id: null,
      properties: {},
      created_at: "",
      updated_at: "",
      timestamp: "",
      source: "",
      source_id: "",
      version: 1,
      schema_version: 1,
      device: "",
      capture_latitude: 0,
      capture_longitude: 0,
    };
    const expected = new Set(Object.keys(itemShape));
    const actual = new Set(RESERVED_ITEM_FIELDS);
    expect(actual).toEqual(expected);
  });
});

// -----------------------------------------------------------------------------
// Shadow rule — custom-type fields may not collide with first-class Item
// fields. validateTypeSchema rejects with code "property_shadows_field" for
// each colliding name. Server-side route layer (POST /types) surfaces the
// rejection as HTTP 400 + PROPERTY_SHADOWS_FIELD.
// -----------------------------------------------------------------------------
describe("validateTypeSchema — property shadow rule", () => {
  it("rejects a schema declaring a field that shadows a first-class Item field", () => {
    const result = validateTypeSchema({
      id: "test.shadow_device",
      label: "Shadow Device",
      version: 1,
      fields: {
        device: { type: "string" },
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const collision = result.errors.find(
      (e) => e.code === "property_shadows_field",
    );
    expect(collision).toBeTruthy();
    expect(collision?.field).toBe("fields.device");
  });

  it("reports every shadowing field at once, not just the first", () => {
    const result = validateTypeSchema({
      id: "test.shadow_many",
      label: "Shadow Many",
      version: 1,
      fields: {
        device: { type: "string" },
        source_id: { type: "string" },
        timestamp: { type: "datetime" },
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const fields = result.errors
      .filter((e) => e.code === "property_shadows_field")
      .map((e) => e.field);
    expect(fields).toContain("fields.device");
    expect(fields).toContain("fields.source_id");
    expect(fields).toContain("fields.timestamp");
  });

  it("accepts a schema whose fields don't shadow any first-class Item field", () => {
    const result = validateTypeSchema({
      id: "test.shadow_clean",
      label: "Shadow Clean",
      version: 1,
      fields: {
        input_device: { type: "string" },
        duration_seconds: { type: "number" },
      },
    });
    expect(result.success).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Adversarial input — a cyclical parent chain. Real TYPE_REGISTRY entries are
// generated from JSON and cannot cycle, but a future runtime registration path
// could in theory plant one. validateTypeSchema's parent-chain walk has a
// `seen` guard (type-registry.ts) that keeps it finite — these tests lock that
// behaviour in. Assertions target the stable error code, never message text.
// -----------------------------------------------------------------------------
describe("validateTypeSchema — circular inheritance", () => {
  beforeEach(() => {
    registerTypeSchema({
      id: "cycle.a",
      parent: "cycle.b",
      version: 1,
      fields: { afield: { type: "string", description: "A field" } },
    });
    registerTypeSchema({
      id: "cycle.b",
      parent: "cycle.a",
      version: 1,
      fields: { bfield: { type: "string", description: "B field" } },
    });
  });

  afterEach(() => {
    unregisterTypeSchema("cycle.a");
    unregisterTypeSchema("cycle.b");
  });

  it("terminates on a cyclical parent chain — no infinite loop", () => {
    // Validating a child of cycle.a means walking cycle.a → cycle.b → cycle.a.
    // The `seen` guard breaks the loop. Reaching this assertion at all proves
    // the guard fired; with no field collisions the validation succeeds.
    const result = validateTypeSchema({
      id: "test.cycle_descendant",
      parent: "cycle.a",
      version: 1,
      fields: { newfield: { type: "string", description: "new" } },
    });
    expect(result.success).toBe(true);
  });

  it("still surfaces inheritance violations from the immediate parent in a cycle", () => {
    // afield is declared on cycle.a. A child of cycle.a redeclaring it must
    // be caught — even though the walker enters a cycle.
    const result = validateTypeSchema({
      id: "test.cycle_redeclare_a",
      parent: "cycle.a",
      version: 1,
      fields: { afield: { type: "string", description: "override" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.errors.some((e) => e.code === "inheritance_violation"),
      ).toBe(true);
    }
  });

  it("still surfaces inheritance violations from across the cycle", () => {
    // bfield is declared on cycle.b, reachable from cycle.a only via the
    // cyclical edge. The walker must traverse it before the `seen` guard
    // breaks; otherwise this redeclaration would slip through.
    const result = validateTypeSchema({
      id: "test.cycle_redeclare_b",
      parent: "cycle.a",
      version: 1,
      fields: { bfield: { type: "string", description: "override" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.errors.some((e) => e.code === "inheritance_violation"),
      ).toBe(true);
    }
  });
});

describe("validateTypeSchema — display_hints", () => {
  const baseThing = {
    id: "acme.hint_test",
    version: 1,
    fields: {
      title: { type: "string", description: "Title" },
      body: { type: "string", description: "Body text" },
    },
  };

  it("accepts display_hints whose fields exist on the type", () => {
    const result = validateTypeSchema({
      ...baseThing,
      display_hints: { title_field: "title", body_field: "body" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.display_hints).toEqual({
        title_field: "title",
        body_field: "body",
      });
    }
  });

  it("accepts display_hints with only title_field", () => {
    const result = validateTypeSchema({
      ...baseThing,
      display_hints: { title_field: "title" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.display_hints?.title_field).toBe("title");
      expect(result.data.display_hints?.body_field).toBeUndefined();
    }
  });

  it("rejects display_hints referencing an unknown field", () => {
    const result = validateTypeSchema({
      ...baseThing,
      display_hints: { title_field: "nonexistent" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.errors.some((e) => e.field === "display_hints.title_field"),
      ).toBe(true);
    }
  });

  it("rejects display_hints that isn't an object", () => {
    const result = validateTypeSchema({
      ...baseThing,
      display_hints: "title",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.field === "display_hints")).toBe(true);
    }
  });

  it("accepts omitting display_hints entirely", () => {
    const result = validateTypeSchema(baseThing);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.display_hints).toBeUndefined();
    }
  });

  it("accepts a child of core.note whose display_hints point at an inherited field", () => {
    // `title` and `body` are declared on core.note, not on this child.
    // Pointing display_hints at inherited fields is legitimate — the
    // validator must walk the parent chain, matching merge_policy's
    // behaviour for the same reason.
    const result = validateTypeSchema({
      id: "acme.note_hinted",
      version: 1,
      parent: "core.note",
      fields: {
        extra: { type: "string" },
      },
      display_hints: { title_field: "title", body_field: "body" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.display_hints).toEqual({
        title_field: "title",
        body_field: "body",
      });
    }
  });

  it("accepts a grandchild pointing display_hints at a grandparent field", () => {
    // core.entity.person inherits `name` from core.entity. A child of
    // core.entity.person can reach the grandparent field — confirms the
    // walk traverses the full parent chain, not just the immediate parent.
    const result = validateTypeSchema({
      id: "acme.person_hinted",
      version: 1,
      parent: "core.entity.person",
      fields: {
        extra: { type: "string" },
      },
      display_hints: { title_field: "name" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.display_hints?.title_field).toBe("name");
    }
  });

  it("rejects a child whose display_hints reference a field on neither child nor ancestor", () => {
    const result = validateTypeSchema({
      id: "acme.note_bad_hint",
      version: 1,
      parent: "core.note",
      fields: {
        extra: { type: "string" },
      },
      display_hints: { title_field: "nonexistent" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.errors.some((e) => e.field === "display_hints.title_field"),
      ).toBe(true);
    }
  });
});

describe("merge_policy — per-type registry snapshot", () => {
  // Snapshot of the per-type merge-policy table — keep aligned with
  // the `merge_policy` declarations in `packages/types/core/*.json`.
  const cases: {
    typeId: string;
    expectedKeepBoth: string[];
    expectedDefault: string;
  }[] = [
    {
      typeId: "core.note",
      expectedKeepBoth: ["body", "notes"],
      expectedDefault: "last_writer_wins",
    },
    {
      typeId: "core.bookmark",
      expectedKeepBoth: ["body", "notes"],
      expectedDefault: "last_writer_wins",
    },
    {
      typeId: "core.task",
      expectedKeepBoth: ["body", "notes"],
      expectedDefault: "last_writer_wins",
    },
    {
      typeId: "core.event",
      expectedKeepBoth: ["notes"],
      expectedDefault: "last_writer_wins",
    },
    {
      typeId: "core.highlight",
      expectedKeepBoth: ["note"],
      expectedDefault: "last_writer_wins",
    },
    {
      typeId: "core.message",
      expectedKeepBoth: ["body"],
      expectedDefault: "last_writer_wins",
    },
    {
      typeId: "core.entity",
      expectedKeepBoth: [],
      expectedDefault: "last_writer_wins",
    },
    {
      typeId: "core.entity.person",
      expectedKeepBoth: [],
      expectedDefault: "last_writer_wins",
    },
    {
      typeId: "core.entity.place",
      expectedKeepBoth: [],
      expectedDefault: "last_writer_wins",
    },
    {
      typeId: "core.media",
      expectedKeepBoth: ["body", "notes"],
      expectedDefault: "last_writer_wins",
    },
    {
      typeId: "core.media.book",
      expectedKeepBoth: ["body", "notes"],
      expectedDefault: "last_writer_wins",
    },
    {
      typeId: "core.media.article",
      expectedKeepBoth: ["body", "notes"],
      expectedDefault: "last_writer_wins",
    },
    {
      typeId: "core.media.film",
      expectedKeepBoth: ["body", "notes"],
      expectedDefault: "last_writer_wins",
    },
    {
      typeId: "core.media.song",
      expectedKeepBoth: ["body", "notes"],
      expectedDefault: "last_writer_wins",
    },
    {
      typeId: "core.media.album",
      expectedKeepBoth: ["body", "notes"],
      expectedDefault: "last_writer_wins",
    },
    {
      typeId: "core.media.podcast",
      expectedKeepBoth: ["body", "notes"],
      expectedDefault: "last_writer_wins",
    },
    {
      typeId: "core.media.series",
      expectedKeepBoth: ["body", "notes"],
      expectedDefault: "last_writer_wins",
    },
    {
      typeId: "core.media.tv_episode",
      expectedKeepBoth: ["body", "notes"],
      expectedDefault: "last_writer_wins",
    },
    {
      typeId: "core.file",
      expectedKeepBoth: [],
      expectedDefault: "last_writer_wins",
    },
    {
      typeId: "core.file.image",
      expectedKeepBoth: [],
      expectedDefault: "last_writer_wins",
    },
    {
      typeId: "core.file.audio",
      expectedKeepBoth: [],
      expectedDefault: "last_writer_wins",
    },
    {
      typeId: "core.file.video",
      expectedKeepBoth: [],
      expectedDefault: "last_writer_wins",
    },
  ];

  for (const { typeId, expectedKeepBoth, expectedDefault } of cases) {
    it(`${typeId} — declares the artifact's policy`, () => {
      const schema = getTypeSchema(typeId);
      expect(schema, `missing schema for ${typeId}`).toBeDefined();
      const policy = schema?.merge_policy;
      expect(policy, `missing policy for ${typeId}`).toBeDefined();
      expect(policy?.default).toBe(expectedDefault);
      const keepBoth = Object.entries(policy?.fields ?? {})
        .filter(([, strategy]) => strategy === "keep_both_copies")
        .map(([field]) => field)
        .sort();
      expect(keepBoth).toEqual([...expectedKeepBoth].sort());
    });
  }
});

describe("validateTypeSchema — merge_policy", () => {
  const baseThing = {
    id: "acme.merge_test",
    version: 1,
    fields: {
      title: { type: "string", description: "Title" },
      body: { type: "string", description: "Body text" },
    },
  };

  it("accepts merge_policy whose fields exist and use known strategies", () => {
    const result = validateTypeSchema({
      ...baseThing,
      merge_policy: {
        fields: { body: "keep_both_copies" },
        default: "last_writer_wins",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.merge_policy?.fields?.body).toBe("keep_both_copies");
      expect(result.data.merge_policy?.default).toBe("last_writer_wins");
    }
  });

  it("accepts merge_policy with only a default", () => {
    const result = validateTypeSchema({
      ...baseThing,
      merge_policy: { default: "last_writer_wins" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects merge_policy referencing an unknown field", () => {
    const result = validateTypeSchema({
      ...baseThing,
      merge_policy: { fields: { nonexistent: "keep_both_copies" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.errors.some((e) =>
          e.field.startsWith("merge_policy.fields.nonexistent"),
        ),
      ).toBe(true);
    }
  });

  it("rejects merge_policy with an unknown strategy", () => {
    const result = validateTypeSchema({
      ...baseThing,
      merge_policy: { fields: { body: "made_up_strategy" } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects merge_policy with an unknown default strategy", () => {
    const result = validateTypeSchema({
      ...baseThing,
      merge_policy: { default: "made_up" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects merge_policy that isn't an object", () => {
    const result = validateTypeSchema({
      ...baseThing,
      merge_policy: "keep_both_copies",
    });
    expect(result.success).toBe(false);
  });

  it("accepts omitting merge_policy entirely", () => {
    const result = validateTypeSchema(baseThing);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.merge_policy).toBeUndefined();
    }
  });

  it("accepts a child of core.note overriding an inherited field's strategy", () => {
    // `body` is declared on core.note, not on this child. Overriding its
    // merge strategy (without redeclaring the field itself) is legitimate.
    const result = validateTypeSchema({
      id: "acme.note_override",
      version: 1,
      parent: "core.note",
      fields: {
        extra: { type: "string" },
      },
      merge_policy: {
        fields: { body: "last_writer_wins" },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.merge_policy?.fields?.body).toBe("last_writer_wins");
    }
  });

  it("rejects merge_policy referencing a field on neither child nor ancestor", () => {
    const result = validateTypeSchema({
      id: "acme.note_bad_override",
      version: 1,
      parent: "core.note",
      fields: {
        extra: { type: "string" },
      },
      merge_policy: {
        fields: { nonexistent: "keep_both_copies" },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.errors.some((e) =>
          e.field.startsWith("merge_policy.fields.nonexistent"),
        ),
      ).toBe(true);
    }
  });
});
