import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { TypeSchema } from "./schema-types.js";
import {
  DISPLAY_HINTS_KEYS,
  EDGE_PROPERTY_KEYS,
  EDGE_TYPE_SCHEMA_KEYS,
  FIELD_DEFINITION_KEYS,
  MERGE_POLICY_KEYS,
  REFUSED_TYPE_SCHEMA_KEYS,
  TYPE_SCHEMA_KEYS,
  VERSION_POLICY_KEYS,
  unreadKeys,
  validateEdgeTypeSchema,
  validateTypeSchema,
} from "./schema-validation.js";

const typesRoot = resolve(import.meta.dirname, "..");

function filesIn(dir: string): { file: string; data: unknown }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      data: JSON.parse(readFileSync(join(dir, file), "utf-8")) as unknown,
    }));
}

const fieldsOf = (issues: { field: string }[]) => issues.map((i) => i.field);

/**
 * Hands the validator a proxy over `schema` and answers every top-level key
 * it asked about, by property read or by `in`, whether or not the schema
 * holds it.
 */
function keysRead(schema: object, validate: (input: unknown) => void) {
  const read = new Set<string>();
  const record = (key: string | symbol) => {
    if (typeof key === "string") read.add(key);
  };
  validate(
    new Proxy(schema, {
      get(target, key, receiver) {
        record(key);
        return Reflect.get(target, key, receiver) as unknown;
      },
      has(target, key) {
        record(key);
        return Reflect.has(target, key);
      },
    }),
  );
  return [...read].sort();
}

const parentSchema: TypeSchema = {
  id: "user.base",
  version: 1,
  fields: { title: { type: "string" } },
};

const context = { resolveSchema: () => parentSchema };

/** The paths a refusal names, or `undefined` for a schema the validator takes. */
function refusedPaths(result: {
  success: boolean;
  errors?: { field: string }[];
}): string[] | undefined {
  return result.success ? undefined : fieldsOf(result.errors ?? []);
}

describe("unreadKeys", () => {
  const type = {
    id: "user.recipe",
    version: 1,
    fields: { title: { type: "string" }, serves: { type: "integer" } },
    required: ["title"],
  };
  const edge = { id: "cites", cardinality: "many-to-many" };

  it("passes a type schema carrying only keys the validator reads", () => {
    expect(unreadKeys(type, "type")).toEqual([]);
    expect(validateTypeSchema(type, context).success).toBe(true);
  });

  it("names a top-level key the type validator does not read, and the validator refuses it", () => {
    expect(fieldsOf(unreadKeys({ ...type, _deferred: true }, "type"))).toEqual([
      "_deferred",
    ]);
    expect(
      refusedPaths(validateTypeSchema({ ...type, _deferred: true }, context)),
    ).toEqual(["_deferred"]);
  });

  it("names a key inside a field by its path, whatever the field's type", () => {
    // `minimum` and `maximum` are no part of a field definition: nothing
    // enforces them, so a schema carrying them says something that is false.
    const bad = {
      ...type,
      fields: {
        title: { type: "string", max_length: 10 },
        serves: { type: "integer", minimum: 1, maximum: 12 },
      },
    };
    expect(refusedPaths(validateTypeSchema(bad, context))).toEqual([
      "fields.title.max_length",
      "fields.serves.minimum",
      "fields.serves.maximum",
    ]);
  });

  it("takes every key of a field definition on a field that can carry it", () => {
    // The witness for the refusal above: every key it leaves alone registers.
    const everything = {
      id: "user.everything",
      version: 1,
      fields: {
        name: {
          type: "string",
          description: "d",
          required: true,
          searchable: false,
          maxLength: 10,
        },
        kind: { type: "enum", enum_values: ["a", "b"] },
        tags: { type: "array", items_type: "string", maxItems: 3 },
        lang: { type: "string", format: "bcp47" },
      },
    };
    expect(
      new Set(Object.values(everything.fields).flatMap(Object.keys)),
    ).toEqual(FIELD_DEFINITION_KEYS);
    expect(validateTypeSchema(everything, context).success).toBe(true);
  });

  it("names a key inside display_hints, version_policy and merge_policy", () => {
    const bad = {
      ...type,
      display_hints: { title_field: "title", subtitle_field: "title" },
      version_policy: { max_versions: 5, keep_forever: true },
      merge_policy: { default: "last_writer_wins", fallback: "x" },
    };
    expect(refusedPaths(validateTypeSchema(bad, context))).toEqual([
      "display_hints.subtitle_field",
      "version_policy.keep_forever",
      "merge_policy.fallback",
    ]);
  });

  it("points a misspelling at the key it is likely to mean", () => {
    const [found] = unreadKeys(
      { ...type, fields: { title: { type: "string", max_length: 10 } } },
      "type",
    );
    expect(found?.hint).toContain('"maxLength"');
    const [other] = unreadKeys(
      { ...type, fields: { title: { type: "string", minimum: 1 } } },
      "type",
    );
    expect(other?.hint).not.toContain("Write");
  });

  it("leaves a field that is not an object to the validator", () => {
    expect(
      unreadKeys({ ...type, fields: { title: "string" } }, "type"),
    ).toEqual([]);
    expect(
      refusedPaths(
        validateTypeSchema({ ...type, fields: { title: "string" } }, context),
      ),
    ).toEqual(["fields.title"]);
  });

  it("passes an edge schema carrying only keys the validator reads", () => {
    expect(unreadKeys(edge, "edge")).toEqual([]);
    expect(validateEdgeTypeSchema(edge).success).toBe(true);
  });

  it("names a top-level key and a property key the edge validator does not read", () => {
    // `fields` is a type schema's key, not an edge schema's.
    const bad = {
      ...edge,
      fields: {},
      property_schema: { rank: { type: "number", minimum: 0 } },
    };
    expect(fieldsOf(unreadKeys(bad, "edge"))).toEqual([
      "fields",
      "property_schema.rank.minimum",
    ]);
    const result = validateEdgeTypeSchema(bad);
    expect(refusedPaths(result)).toEqual([
      "fields",
      "property_schema.rank.minimum",
    ]);
  });

  it("lists exactly the keys the type validator reads", () => {
    // Every key on the list is present, so a validator that stops reading
    // one drops it from the set, and one that starts reading a key off the
    // list adds it, whether or not a schema carries that key.
    const full = {
      id: "user.recipe",
      parent: parentSchema.id,
      label: "Recipe",
      description: "A recipe.",
      version: 1,
      fields: { serves: { type: "number" } },
      required: ["title"],
      roles: [],
      display_hints: { title_field: "title" },
      link_field: "title",
      version_policy: { max_versions: 10 },
      merge_policy: { default: "last_writer_wins" },
      compatible_with: [parentSchema.id],
    };
    expect(Object.keys(full).sort()).toEqual([...TYPE_SCHEMA_KEYS].sort());
    expect(
      keysRead(full, (input) => validateTypeSchema(input, context)),
    ).toEqual([...TYPE_SCHEMA_KEYS, ...REFUSED_TYPE_SCHEMA_KEYS].sort());
  });

  it("lists exactly the keys the edge validator reads", () => {
    const full = {
      id: "cites",
      label: "Cites",
      description: "One item cites another.",
      cardinality: "many-to-many",
      source_type_constraints: ["*"],
      target_type_constraints: ["*"],
      cascade_on_delete: "orphan",
      property_schema: {},
      reverse_name: "cited-by",
      written_at: "source",
    };
    expect(Object.keys(full).sort()).toEqual([...EDGE_TYPE_SCHEMA_KEYS].sort());
    expect(keysRead(full, validateEdgeTypeSchema)).toEqual(
      [...EDGE_TYPE_SCHEMA_KEYS].sort(),
    );
  });

  it("holds each nested list to the keys its model has", () => {
    const sorted = (keys: ReadonlySet<string>) => [...keys].sort();
    expect(sorted(DISPLAY_HINTS_KEYS)).toEqual(["body_field", "title_field"]);
    expect(sorted(VERSION_POLICY_KEYS)).toEqual([
      "daily_snapshot_days",
      "max_versions",
      "recent_days",
      "weekly_snapshot_days",
    ]);
    expect(sorted(MERGE_POLICY_KEYS)).toEqual(["default", "fields"]);
    expect(sorted(EDGE_PROPERTY_KEYS)).toEqual(
      sorted(FIELD_DEFINITION_KEYS).filter(
        (key) => !["maxItems", "maxLength", "searchable"].includes(key),
      ),
    );
  });

  it("leaves a key the validator refuses to the validator", () => {
    // The witness: the validator names the key, so it is reported once.
    const refused = validateTypeSchema({ ...type, states: ["draft"] }, context);
    expect(refusedPaths(refused)).toEqual(["states"]);
    for (const key of REFUSED_TYPE_SCHEMA_KEYS) {
      expect(unreadKeys({ ...type, [key]: {} }, "type"), key).toEqual([]);
    }
  });

  it("finds no unread key in any in-tree file", () => {
    const families: { dir: string; kind: "type" | "edge" }[] = [
      { dir: join(typesRoot, "core"), kind: "type" },
      { dir: join(typesRoot, "core", "system"), kind: "type" },
      { dir: join(typesRoot, "core", "edges"), kind: "edge" },
    ];
    for (const { dir, kind } of families) {
      const files = filesIn(dir);
      expect(files.length, dir).toBeGreaterThan(0);
      for (const { file, data } of files) {
        expect(fieldsOf(unreadKeys(data, kind)), file).toEqual([]);
      }
    }
  });
});
