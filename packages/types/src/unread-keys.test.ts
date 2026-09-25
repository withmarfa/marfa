import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { TypeSchema } from "./schema-types.js";
import {
  EDGE_TYPE_SCHEMA_KEYS,
  REFUSED_TYPE_SCHEMA_KEYS,
  TYPE_SCHEMA_KEYS,
  unreadTopLevelKeys,
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

describe("unreadTopLevelKeys", () => {
  const type = {
    id: "user.recipe",
    version: 1,
    fields: { title: { type: "string" } },
    required: ["title"],
  };
  const edge = { id: "cites", cardinality: "many-to-many" };

  it("passes a type schema carrying only keys the validator reads", () => {
    expect(unreadTopLevelKeys(type, "type")).toEqual([]);
  });

  it("refuses a top-level key the type validator does not read", () => {
    expect(
      fieldsOf(unreadTopLevelKeys({ ...type, _deferred: true }, "type")),
    ).toEqual(["_deferred"]);
  });

  it("passes an edge schema carrying only keys the validator reads", () => {
    expect(unreadTopLevelKeys(edge, "edge")).toEqual([]);
  });

  it("refuses a top-level key the edge validator does not read", () => {
    // `fields` is a type schema's key, not an edge schema's.
    expect(
      fieldsOf(unreadTopLevelKeys({ ...edge, fields: {} }, "edge")),
    ).toEqual(["fields"]);
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
      version_policy: { max_versions: 10 },
      merge_policy: { default: "last_writer_wins" },
      compatible_with: [parentSchema.id],
    };
    expect(Object.keys(full).sort()).toEqual([...TYPE_SCHEMA_KEYS].sort());
    expect(
      keysRead(full, (input) =>
        validateTypeSchema(input, { resolveSchema: () => parentSchema }),
      ),
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
    };
    expect(Object.keys(full).sort()).toEqual([...EDGE_TYPE_SCHEMA_KEYS].sort());
    expect(keysRead(full, validateEdgeTypeSchema)).toEqual(
      [...EDGE_TYPE_SCHEMA_KEYS].sort(),
    );
  });

  it("leaves a key the validator refuses to the validator", () => {
    // The witness: the validator names the key, so it is reported once.
    const refused = validateTypeSchema(
      { ...type, states: ["draft"] },
      { resolveSchema: () => undefined },
    );
    expect(refused.success).toBe(false);
    expect(refused.success ? [] : fieldsOf(refused.errors)).toEqual(["states"]);
    for (const key of REFUSED_TYPE_SCHEMA_KEYS) {
      expect(unreadTopLevelKeys({ ...type, [key]: {} }, "type"), key).toEqual(
        [],
      );
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
        expect(fieldsOf(unreadTopLevelKeys(data, kind)), file).toEqual([]);
      }
    }
  });
});
