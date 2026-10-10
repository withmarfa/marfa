/**
 * What the type and edge type doors answer a definition carrying a key the
 * schema does not define.
 *
 * Each door once read such a key as it read any other: the type or edge type
 * registered without it, so a misspelt rule or an `integer` bounded by a
 * `minimum` nothing enforces came back as a success. The cases pair every
 * refusal with the same body, mended, that registers, so a refusal cannot be
 * the door refusing everything.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EDGE_PROPERTY_KEYS, EDGE_TYPE_SCHEMA_KEYS } from "@withmarfa/shared";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import {
  EdgePropertyDefinitionSchema,
  EdgeTypeRequestSchema,
} from "./edge-types.js";

let ctx: TestContext;
let sequence = 0;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

const unique = (stem: string): string =>
  `user.${stem}_${Math.random().toString(36).slice(2, 8)}${String(++sequence)}`;

type Body = Record<string, unknown>;

interface Answer {
  status: number;
  code: string | undefined;
  paths: string[];
  body: Body;
}

async function send(
  method: "POST" | "PUT",
  path: string,
  body: Body,
): Promise<Answer> {
  const res = await request(ctx.app, method, path, {
    key: ctx.workingKey,
    body,
  });
  const parsed = (await res.json()) as Body & {
    error?: { code?: string; details?: { errors?: { field: string }[] } };
  };
  return {
    status: res.status,
    code: parsed.error?.code,
    paths: (parsed.error?.details?.errors ?? []).map((e) => e.field),
    body: parsed,
  };
}

const fields = { title: { type: "string" }, serves: { type: "integer" } };

describe("POST /types", () => {
  it("names a top-level key the schema does not define", async () => {
    const id = unique("top");
    const bad = await send("POST", "/types", {
      id,
      fields,
      requird: ["title"],
    });
    expect(bad).toMatchObject({ status: 400, code: "invalid_schema" });
    expect(bad.paths).toEqual(["requird"]);
    expect(
      (await request(ctx.app, "GET", `/types/${id}`, { key: ctx.workingKey }))
        .status,
    ).toBe(404);

    const mended = await send("POST", "/types", {
      id,
      fields,
      required: ["title"],
    });
    expect(mended.status).toBe(201);
  });

  it("names each key inside a field, whatever the field's type", async () => {
    const id = unique("field");
    const bad = await send("POST", "/types", {
      id,
      fields: {
        title: { type: "string", max_length: 10 },
        serves: { type: "integer", minimum: 1, maximum: 12 },
        kind: { type: "enum", enum_values: ["a"], values: ["b"] },
      },
    });
    expect(bad).toMatchObject({ status: 400, code: "invalid_schema" });
    expect(bad.paths).toEqual([
      "fields.title.max_length",
      "fields.serves.minimum",
      "fields.serves.maximum",
      "fields.kind.values",
    ]);

    const mended = await send("POST", "/types", {
      id,
      fields: {
        title: { type: "string", maxLength: 10 },
        serves: { type: "integer" },
        kind: { type: "enum", enum_values: ["a"] },
      },
    });
    expect(mended.status).toBe(201);
  });

  it("names a key inside display_hints, version_policy and merge_policy", async () => {
    const id = unique("nested");
    const bad = await send("POST", "/types", {
      id,
      fields,
      display_hints: { title_field: "title", subtitle: "title" },
      version_policy: { max_versions: 5, keep_forever: true },
      merge_policy: { default: "last_writer_wins", fallback: "x" },
    });
    expect(bad).toMatchObject({ status: 400, code: "invalid_schema" });
    expect(bad.paths).toEqual([
      "display_hints.subtitle",
      "version_policy.keep_forever",
      "merge_policy.fallback",
    ]);

    const mended = await send("POST", "/types", {
      id,
      fields,
      display_hints: { title_field: "title" },
      version_policy: { max_versions: 5 },
      merge_policy: { default: "last_writer_wins" },
    });
    expect(mended.status).toBe(201);
  });

  it("names the key before it asks whether the identifier is taken", async () => {
    const id = unique("taken");
    expect((await send("POST", "/types", { id, fields })).status).toBe(201);
    const again = await send("POST", "/types", { id, fields, bogus: 1 });
    expect(again).toMatchObject({ status: 400, code: "invalid_schema" });
  });

  it("takes an inherited field restated with only the keys a definition has", async () => {
    const id = unique("child");
    const registered = await send("POST", "/types", {
      id,
      parent: "core.note",
      fields: {
        body: { type: "string", description: "The note.", required: true },
      },
    });
    expect(registered.status).toBe(201);
  });
});

describe("PUT /types/{id}", () => {
  it("names the same keys on a replacement, and leaves the stored type as it was", async () => {
    const id = unique("replace");
    expect((await send("POST", "/types", { id, fields })).status).toBe(201);

    const bad = await send("PUT", `/types/${id}`, {
      fields: { ...fields, serves: { type: "integer", minimum: 1 } },
      lable: "Recipe",
    });
    expect(bad).toMatchObject({ status: 400, code: "invalid_schema" });
    expect(bad.paths).toEqual(["lable", "fields.serves.minimum"]);

    const stored = await request(ctx.app, "GET", `/types/${id}`, {
      key: ctx.workingKey,
    });
    const type = (await stored.json()) as {
      label: string;
      fields: Record<string, unknown>;
    };
    expect(type.fields.serves).toEqual({ type: "integer" });
    expect(type.label).not.toBe("Recipe");

    const mended = await send("PUT", `/types/${id}`, {
      fields,
      label: "Recipe",
    });
    expect(mended.status).toBe(200);
  });

  it("takes back the type exactly as GET /types/{id} answers it", async () => {
    // Every key the answer carries is one the schema defines, so a client
    // that reads a type, changes one thing and replaces it is not refused.
    const id = unique("round_trip");
    expect(
      (
        await send("POST", "/types", {
          id,
          fields: { ...fields, kind: { type: "enum", enum_values: ["a"] } },
          required: ["title"],
          roles: ["container"],
          link_field: "title",
          display_hints: { title_field: "title" },
          version_policy: { recent_days: 3 },
          merge_policy: { default: "keep_both_copies" },
        })
      ).status,
    ).toBe(201);
    const read = await request(ctx.app, "GET", `/types/${id}`, {
      key: ctx.workingKey,
    });
    const answer = (await read.json()) as Body;
    expect(Object.keys(answer)).toEqual(
      expect.arrayContaining(["display_hints", "version_policy", "roles"]),
    );
    const replaced = await send("PUT", `/types/${id}`, answer);
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
  });

  it("takes the type's own id in the body, as it always has", async () => {
    const id = unique("replace_id");
    expect((await send("POST", "/types", { id, fields })).status).toBe(201);
    expect((await send("PUT", `/types/${id}`, { id, fields })).status).toBe(
      200,
    );
  });
});

describe("POST /edge-types", () => {
  const name = () => `unread-${Math.random().toString(36).slice(2, 8)}`;

  it("names a top-level key and a property key the edge type does not define", async () => {
    const id = `user.${name()}`;
    const bad = await send("POST", "/edge-types", {
      id,
      cardinality: "many-to-many",
      cascade: "orphan",
      property_schema: { rank: { type: "number", minimum: 0 } },
    });
    expect(bad).toMatchObject({ status: 400, code: "invalid_schema" });
    expect(bad.paths).toEqual(["cascade", "property_schema.rank.minimum"]);

    const mended = await send("POST", "/edge-types", {
      id,
      cardinality: "many-to-many",
      cascade_on_delete: "orphan",
      property_schema: { rank: { type: "number" } },
    });
    expect(mended.status).toBe(201);
  });

  it("still answers `extends` as it did", async () => {
    const answer = await send("POST", "/edge-types", {
      id: `user.${name()}`,
      cardinality: "many-to-many",
      extends: "references",
    });
    expect(answer).toMatchObject({ status: 400, code: "validation_error" });
  });

  it("names a property key an item field takes and an edge property does not", async () => {
    const answer = await send("POST", "/edge-types", {
      id: `user.${name()}`,
      cardinality: "many-to-many",
      property_schema: { note: { type: "string", maxLength: 10 } },
    });
    expect(answer).toMatchObject({ status: 400, code: "invalid_schema" });
    expect(answer.paths).toEqual(["property_schema.note.maxLength"]);
  });

  it("is held to the keys its request schema declares", () => {
    // A key the schema declares and the check does not list would be refused
    // as unread, and one the check lists and the schema does not would be
    // stripped: either way the door and the check disagree.
    expect(Object.keys(EdgeTypeRequestSchema.shape).sort()).toEqual(
      [...EDGE_TYPE_SCHEMA_KEYS].sort(),
    );
    expect(Object.keys(EdgePropertyDefinitionSchema.shape).sort()).toEqual(
      [...EDGE_PROPERTY_KEYS].sort(),
    );
  });
});
