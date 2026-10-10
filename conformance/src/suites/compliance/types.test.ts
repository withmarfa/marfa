import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import type { TypeSchema } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "types"));
});

// `createTestContext` wraps `registerType` so a successful registration is
// tracked on the context, and `cleanup` owns removing it. A second delete loop
// here would be a second owner for the same row: it deletes the type, then
// cleanup's delete answers not-found and reports a fixture it did not leak.
afterAll(async () => {
  await cleanup(ctx);
});

describe("type registration and listing", () => {
  it("registers a custom type", async () => {
    const customType: TypeSchema = {
      id: `user.evaluator-custom-${ctx.runId}`,
      fields: {
        name: { type: "string", required: true, searchable: true },
        count: { type: "number" },
      },
    };

    const r = await client.registerType(customType);
    expect(r.ok).toBe(true);
    expect(r.data.type.id).toBe(customType.id);
  });

  it("lists registered types", async () => {
    const r = await client.listTypes();
    expect(r.ok).toBe(true);
    expect(r.data.data.length).toBeGreaterThanOrEqual(1);

    const typeIds = r.data.data.map((t) => t.id);
    expect(typeIds).toContain("core.note");
    expect(typeIds).toContain("core.bookmark");
  });

  it("ships exactly the core types, each with fields and a label", async () => {
    const shipped = [
      "core.bookmark",
      "core.entity",
      "core.entity.person",
      "core.entity.place",
      "core.event",
      "core.file",
      "core.file.audio",
      "core.file.image",
      "core.file.video",
      "core.highlight",
      "core.media",
      "core.media.album",
      "core.media.article",
      "core.media.book",
      "core.media.episode",
      "core.media.film",
      "core.media.series",
      "core.media.song",
      "core.message",
      "core.note",
      "core.task",
    ];
    const r = await client.listTypes();
    expect(r.ok).toBe(true);
    const core = r.data.data.filter((t) => t.id.startsWith("core."));
    expect(core.map((t) => t.id).sort()).toEqual(shipped);
    for (const type of core) {
      expect(Object.keys(type.fields).length, type.id).toBeGreaterThan(0);
      expect(type.label, type.id).toBeTruthy();
    }
  });

  it("selects a type filter's items by identifier and by declared parent alike", async () => {
    const root = `user.subtree-${ctx.runId}`;
    const fields = { name: { type: "string" as const } };
    const named = `${root}.named`;
    const declared = `user.declares-${ctx.runId}`;
    const lookalike = `${root}x`;
    for (const body of [
      { id: root, fields },
      { id: named, fields },
      { id: declared, parent: root, fields },
      { id: lookalike, fields },
    ]) {
      const r = await client.registerType(body);
      expect(r.status, JSON.stringify(r.error)).toBe(201);
    }
    // The witness for the name half: the child names no parent.
    expect((await client.getType(named)).data.parent).toBeUndefined();

    const ids = new Map<string, string>();
    for (const type of [root, named, declared, lookalike]) {
      const created = await client.createItem({
        type,
        source: ctx.source,
        properties: { name: type },
      });
      expect(created.status, JSON.stringify(created.error)).toBe(201);
      trackItem(ctx, created.data.item.id);
      ids.set(type, created.data.item.id);
    }

    const listed = await client.listItems({ type: root, limit: 100 });
    expect(listed.ok).toBe(true);
    const got = listed.data.data.map((i) => i.id);
    expect(got).toContain(ids.get(root));
    expect(got).toContain(ids.get(named));
    expect(got).toContain(ids.get(declared));
    expect(got).not.toContain(ids.get(lookalike));
  });

  it("selects with a type the types declared under it, as with its own name", async () => {
    const declared = `acme-${ctx.runId}.meeting`;
    const registered = await client.registerType({
      id: declared,
      parent: "core.event",
      fields: {},
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    // The witness: the type's own name does not start with `core.event`, so
    // only its declared parent can bring the row into either selection.
    expect(declared.startsWith("core.event")).toBe(false);

    const write = async (type: string, properties: Record<string, unknown>) => {
      const r = await client.createItem({
        type,
        source: ctx.source,
        properties,
      });
      expect(r.status, JSON.stringify(r.error)).toBe(201);
      trackItem(ctx, r.data.item.id);
      return r.data.item.id;
    };
    const tag = `selects-declared-${ctx.runId}`;
    const event = { title: tag, starts_at: "2032-05-10T10:00:00.000Z" };
    const child = await write(declared, event);
    const plain = await write("core.event", event);
    const note = await write("core.note", { title: tag, body: tag });

    const answered = async (type: string): Promise<string[]> => {
      const r = await client.listItems({
        type,
        source: ctx.source,
        limit: 100,
      });
      expect(r.status, `${type}: ${JSON.stringify(r.error)}`).toBe(200);
      return r.data.data.map((i) => i.id);
    };
    for (const type of ["core.event", "core.event.*"]) {
      const ids = await answered(type);
      expect(ids, type).toContain(child);
      expect(ids, type).toContain(plain);
      expect(ids, type).not.toContain(note);
    }
  });

  it("declares executable on core.file, which every file type inherits", async () => {
    // A folder keeps a file's executable permission there (`folders/executable-created`).
    for (const id of ["core.file", "core.file.image"]) {
      const r = await client.getType(id);
      expect(r.ok, `GET /types/${id}`).toBe(true);
      // The witness: the field beside it that every file carries.
      expect(r.data.fields.mime_type?.type).toBe("string");
      expect(
        r.data.fields.executable?.type,
        `${id} does not declare executable, so a file's permission has nowhere to go`,
      ).toBe("boolean");
    }
  });

  it("items of a custom type follow the universal lifecycle", async () => {
    // Lifecycle is metadata-layer and universal (active | archived | trashed).
    // Custom types inherit the same states; a schema declares none of its own.
    const typeName = `user.evaluator-lifecycle-${ctx.runId}`;
    await client.registerType({
      id: typeName,
      fields: { name: { type: "string", required: true } },
    });

    const r = await client.createItem({
      type: typeName,
      properties: { name: "Test item" },
      source: ctx.source,
    });
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    expect(r.data.item.state).toBe("active");

    const archived = await client.transitionItem(r.data.item.id, "archived");
    expect(archived.ok).toBe(true);
    expect(archived.data.item.state).toBe("archived");

    const invalid = await client.transitionItem(r.data.item.id, "nonexistent");
    expect(invalid.status).toBe(400);
    expect(invalid.error?.error.code).toBe("validation_error");
  });

  it("rejects type registration with invalid type identifier", async () => {
    const r = await client.registerType({
      id: "invalid",
      fields: {},
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("validation_error");
    // The field is the witness. `validation_error` is the code every other
    // shape failure on this door answers with, so the code alone would still
    // pass if the grammar gate went and the body were refused elsewhere.
    const errors = r.error?.error.details?.errors as
      { path: string }[] | undefined;
    expect(errors?.[0]?.path).toBe("id");
  });

  it("rejects type registration without fields", async () => {
    const r = await client.registerType({
      id: "user.evaluator-nofields",
      fields: undefined as unknown as Record<string, never>,
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("missing_required_field");
  });

  it("refuses a registration with no id as an invalid schema", async () => {
    const fields = { name: { type: "string" as const } };
    const r = await client.registerType({ fields } as unknown as TypeSchema);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_schema");
    const errors = r.error?.error.details?.errors as
      { field: string }[] | undefined;
    expect(errors?.map((e) => e.field)).toContain("id");

    // The witness: the same fields with an id register.
    const registered = await client.registerType({
      id: `user.with-id-${ctx.runId}`,
      fields,
    });
    expect(registered.status).toBe(201);
  });

  // Custom-type schemas may not declare property names that collide with
  // first-class Item wire fields (`source_id`, `occurred_at`, `version`,
  // `schema_version`, `tier`, `state`, `capture_latitude`,
  // `capture_longitude`, plus the structural keys). Letting a property
  // shadow a first-class field name produces ambiguous data: two values
  // under the same key, with nothing telling downstream consumers which is
  // authoritative. The server returns 400 `property_shadows_field`.
  it("rejects type registration whose property name shadows a first-class Item field", async () => {
    const id = `user.shadow-capture-${ctx.runId}`;
    const r = await client.registerType({
      id,
      fields: {
        capture_latitude: { type: "number" },
      },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("property_shadows_field");
  });

  it("refuses each field named like one every item has", async () => {
    // The sixteen names an item carries itself.
    const names = [
      "id",
      "type",
      "state",
      "tier",
      "properties",
      "created_at",
      "updated_at",
      "occurred_at",
      "source",
      "source_id",
      "version",
      "schema_version",
      "capture_latitude",
      "capture_longitude",
      "trashed_by_cascade",
      "trashed_with",
    ];
    for (const name of names) {
      const id = `user.shadow-${name.replace(/_/g, "-")}-${ctx.runId}`;
      const r = await client.registerType({
        id,
        fields: { [name]: { type: "string" } },
      });
      expect(r.status, name).toBe(400);
      expect(r.error?.error.code, name).toBe("property_shadows_field");
      const errors = r.error?.error.details?.errors as
        { field: string }[] | undefined;
      expect(
        errors?.map((e) => e.field),
        name,
      ).toEqual([`fields.${name}`]);
      expect((await client.getType(id)).status, name).toBe(404);

      // The witness: the same type with the field under another name
      // registers.
      const accepted = await client.registerType({
        id,
        fields: { [`${name}_value`]: { type: "string" } },
      });
      expect(accepted.status, name).toBe(201);
    }
  });

  it("refuses a duplicate registration with a bad schema as the bad schema", async () => {
    const id = `user.duplicate-bad-${ctx.runId}`;
    const fields = { name: { type: "string" as const } };
    expect((await client.registerType({ id, fields })).status).toBe(201);

    // The witness: the duplicate with a good schema is the conflict.
    const duplicate = await client.registerType({ id, fields });
    expect(duplicate.status).toBe(409);
    expect(duplicate.error?.error.code).toBe("type_already_exists");

    // Refused by the validator.
    const shadowing = await client.registerType({
      id,
      fields: { capture_latitude: { type: "number" } },
    });
    expect(shadowing.status).toBe(400);
    expect(shadowing.error?.error.code).toBe("property_shadows_field");

    // Refused before the validator, by the shape of the body.
    const unreadable = await client.registerType({
      id,
      fields: { name: { type: "not_a_field_type" } },
    } as unknown as TypeSchema);
    expect(unreadable.status).toBe(400);
    expect(unreadable.error?.error.code).toBe("invalid_schema");
  });

  it("keeps a list of strings with a type-naming format a list", async () => {
    const id = `user.link-list-${ctx.runId}`;
    const r = await client.registerType({
      id,
      fields: {
        links: { type: "array", items_type: "string", format: "url" },
        href: { type: "string", format: "url" },
      },
    });
    expect(r.status).toBe(201);

    const read = await client.getType(id);
    expect(read.ok).toBe(true);
    expect(read.data.fields.links).toMatchObject({
      type: "array",
      items_type: "url",
    });
    expect(read.data.fields.links?.format).toBeUndefined();
    expect(read.data.fields.href?.type).toBe("url");

    const item = await client.createItem({
      type: id,
      properties: { links: ["https://example.com/a", "https://example.com/b"] },
      source: ctx.source,
    });
    expect(item.status).toBe(201);
    trackItem(ctx, item.data.item.id);
    expect(item.data.item.properties.links).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("refuses a type-naming format on a field that is neither a string nor a list of strings", async () => {
    const r = await client.registerType({
      id: `user.number-url-${ctx.runId}`,
      fields: { count: { type: "number", format: "url" } },
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_schema");
    const errors = r.error?.error.details?.errors as
      { field: string }[] | undefined;
    expect(errors?.some((e) => e.field === "fields.count.format")).toBe(true);
  });

  it("stores email, datetime and date formats on a string as their own types", async () => {
    const id = `user.format-types-${ctx.runId}`;
    const formats = ["email", "datetime", "date"] as const;
    const registered = await client.registerType({
      id,
      fields: Object.fromEntries(
        formats.map((format) => [`as_${format}`, { type: "string", format }]),
      ),
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);

    const read = await client.getType(id);
    expect(read.ok).toBe(true);
    for (const format of formats) {
      expect(read.data.fields[`as_${format}`], format).toEqual({
        type: format,
      });
    }
  });

  it("leaves a format that names the field's own type unchanged, and refuses thumbnail on a list", async () => {
    const id = `user.format-same-${ctx.runId}`;
    const registered = await client.registerType({
      id,
      fields: { home: { type: "url", format: "url" } },
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    expect((await client.getType(id)).data.fields.home).toEqual({
      type: "url",
    });

    const refusedId = `user.format-list-thumbnail-${ctx.runId}`;
    const refused = await client.registerType({
      id: refusedId,
      fields: {
        covers: { type: "array", items_type: "string", format: "thumbnail" },
      },
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_schema");
    const errors = refused.error?.error.details?.errors as
      { field: string }[] | undefined;
    expect(errors?.map((e) => e.field)).toContain("fields.covers.format");
    expect((await client.getType(refusedId)).status).toBe(404);

    // The witness: the same list takes a format that names a type a list may
    // hold.
    const urls = await client.registerType({
      id: refusedId,
      fields: {
        covers: { type: "array", items_type: "string", format: "url" },
      },
    });
    expect(urls.status, JSON.stringify(urls.error)).toBe(201);
  });

  it("keeps bcp47 and iso3166 as formats of a string, and refuses them on any other type", async () => {
    const id = `user.format-kept-${ctx.runId}`;
    const registered = await client.registerType({
      id,
      fields: {
        locale: { type: "string", format: "bcp47" },
        country: { type: "string", format: "iso3166" },
      },
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const read = await client.getType(id);
    expect(read.ok).toBe(true);
    expect(read.data.fields.locale).toEqual({
      type: "string",
      format: "bcp47",
    });
    expect(read.data.fields.country).toEqual({
      type: "string",
      format: "iso3166",
    });

    const refusedId = `user.format-kept-refused-${ctx.runId}`;
    const others: Record<string, unknown>[] = [
      { type: "number" },
      { type: "integer" },
      { type: "boolean" },
      { type: "url" },
      { type: "array", items_type: "string" },
    ];
    for (const format of ["bcp47", "iso3166"]) {
      for (const other of others) {
        const refused = await client.registerType({
          id: refusedId,
          fields: { code: { ...other, format } },
        } as never);
        const label = `${format} on ${JSON.stringify(other)}`;
        expect(refused.status, label).toBe(400);
        expect(refused.error?.error.code, label).toBe("invalid_schema");
        const errors = refused.error?.error.details?.errors as
          { field: string }[] | undefined;
        expect(
          errors?.map((e) => e.field),
          label,
        ).toContain("fields.code.format");
      }
    }
    expect((await client.getType(refusedId)).status).toBe(404);
  });

  it("refuses a replacement whose property name shadows a first-class Item field, as registration does", async () => {
    const id = `user.shadow-replace-${ctx.runId}`;
    const registered = await client.registerType({
      id,
      fields: { name: { type: "string" } },
    });
    expect(registered.status).toBe(201);

    const r = await client.replaceType(id, {
      fields: {
        name: { type: "string" },
        capture_latitude: { type: "number" },
      },
    });
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("property_shadows_field");
  });

  it("refuses a replacement that breaks its compatible_with claim, as registration does", async () => {
    const id = `user.compat-replace-${ctx.runId}`;
    const registered = await client.registerType({
      id,
      fields: { body: { type: "string", required: true } },
      compatible_with: "core.note",
    });
    expect(registered.status).toBe(201);

    // core.note requires `body`; the replacement drops it.
    const missingField = await client.replaceType(id, {
      fields: { extra: { type: "string" } },
      compatible_with: "core.note",
    });
    expect(missingField.status).toBe(422);
    expect(missingField.error?.error.code).toBe("compatible_with_violation");

    const unknownTarget = await client.replaceType(id, {
      fields: { body: { type: "string", required: true } },
      compatible_with: "no.such-type-exists",
    });
    expect(unknownTarget.status).toBe(422);
    expect(unknownTarget.error?.error.code).toBe("compatible_with_violation");
  });

  it("refuses a key the type schema does not define, at the top level, in a field and in a block, naming each path", async () => {
    const fields = { title: { type: "string" }, serves: { type: "integer" } };
    const bodies: {
      what: string;
      bad: object;
      paths: string[];
      mended: object;
    }[] = [
      {
        what: "a top-level key",
        bad: { fields, requird: ["title"] },
        paths: ["requird"],
        mended: { fields, required: ["title"] },
      },
      {
        what: "a bound on an integer field",
        bad: {
          fields: {
            ...fields,
            serves: { type: "integer", minimum: 1, maximum: 12 },
          },
        },
        paths: ["fields.serves.minimum", "fields.serves.maximum"],
        mended: { fields },
      },
      {
        what: "a misspelled rule of a string field",
        bad: { fields: { title: { type: "string", max_length: 10 } } },
        paths: ["fields.title.max_length"],
        mended: { fields: { title: { type: "string", maxLength: 10 } } },
      },
      {
        what: "a key in display_hints, version_policy and merge_policy",
        bad: {
          fields,
          display_hints: { title_field: "title", subtitle: "title" },
          version_policy: { max_versions: 5, keep_forever: true },
          merge_policy: { default: "last_writer_wins", fallback: "x" },
        },
        paths: [
          "display_hints.subtitle",
          "version_policy.keep_forever",
          "merge_policy.fallback",
        ],
        mended: {
          fields,
          display_hints: { title_field: "title" },
          version_policy: { max_versions: 5 },
          merge_policy: { default: "last_writer_wins" },
        },
      },
    ];
    for (const [index, { what, bad, paths, mended }] of bodies.entries()) {
      const id = `user.unread-key-${ctx.runId}-${String(index)}`;
      const refused = await client.registerType({ id, ...bad } as never);
      expect(refused.status, what).toBe(400);
      expect(refused.error?.error.code, what).toBe("invalid_schema");
      const errors = refused.error?.error.details?.errors as
        { field: string }[] | undefined;
      expect(
        errors?.map((e) => e.field),
        what,
      ).toEqual(paths);
      expect((await client.getType(id)).status, what).toBe(404);

      // The witness: the same body with only those keys mended registers.
      const registered = await client.registerType({ id, ...mended } as never);
      expect(
        registered.status,
        `${what}: ${JSON.stringify(registered.error)}`,
      ).toBe(201);
    }
  });

  it("refuses a key the type schema does not define on a replacement, and keeps the type as it was", async () => {
    const id = `user.unread-key-replace-${ctx.runId}`;
    const fields = { serves: { type: "integer" as const } };
    const registered = await client.registerType({ id, fields });
    expect(registered.status).toBe(201);

    const refused = await client.replaceType(id, {
      fields: { serves: { type: "integer", minimum: 1 } },
      lable: "Recipe",
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_schema");
    const errors = refused.error?.error.details?.errors as
      { field: string }[] | undefined;
    expect(errors?.map((e) => e.field)).toEqual([
      "lable",
      "fields.serves.minimum",
    ]);
    expect((await client.getType(id)).data.fields).toEqual(fields);

    // The witness: the same replacement without the keys is taken.
    const mended = await client.replaceType(id, {
      fields,
      label: "Recipe",
    });
    expect(mended.status).toBe(200);
  });

  it("writes and reads items of a type whose fields share a name with an object's built-in members", async () => {
    const names = ["toString", "valueOf", "constructor", "hasOwnProperty"];
    const id = `user.builtin-names-${ctx.runId}`;
    const registered = await client.registerType({
      id,
      fields: Object.fromEntries(
        names.map((name) => [name, { type: "string" as const }]),
      ),
    });
    expect(registered.status).toBe(201);
    expect(Object.keys(registered.data.type.fields).sort()).toEqual(
      [...names].sort(),
    );

    const bare = await client.createItem({
      type: id,
      properties: {},
      source: ctx.source,
    });
    expect(bare.status).toBe(201);
    trackItem(ctx, bare.data.item.id);
    expect(bare.data.item.properties).toEqual({});

    const values = Object.fromEntries(names.map((name) => [name, `${name}!`]));
    const full = await client.createItem({
      type: id,
      properties: values,
      source: ctx.source,
    });
    expect(full.status).toBe(201);
    trackItem(ctx, full.data.item.id);

    const read = await client.getItem(full.data.item.id);
    expect(read.status).toBe(200);
    expect(read.data.item.properties).toEqual(values);

    const patched = await client.updateItem(full.data.item.id, {
      properties: { valueOf: "changed" },
      version: full.data.item.version,
    });
    expect(patched.status).toBe(200);
    expect(patched.data.item.properties).toEqual({
      ...values,
      valueOf: "changed",
    });
  });
});

// Per-type merge policy drives client-side conflict resolution.
describe("type merge_policy", () => {
  it("GET /types/core.note returns the artifact-declared merge_policy", async () => {
    const r = await client.getType("core.note");
    expect(r.ok).toBe(true);
    expect(r.data.merge_policy).toBeDefined();
    expect(r.data.merge_policy?.default).toBe("last_writer_wins");
    expect(r.data.merge_policy?.fields?.body).toBe("keep_both_copies");
    expect(r.data.merge_policy?.fields?.notes).toBe("keep_both_copies");
    // Last-writer-wins fields must NOT appear under `fields` — they fall
    // through to the `default` strategy. The artifact's principle is that
    // only deviations from the default are listed.
    expect(r.data.merge_policy?.fields?.title).toBeUndefined();
    expect(r.data.merge_policy?.fields?.language).toBeUndefined();
  });

  it("POST /types accepts a custom type with a valid merge_policy", async () => {
    const typeId = `user.evaluator-mp-valid-${ctx.runId}`;
    const r = await client.registerType({
      id: typeId,
      fields: {
        title: { type: "string" },
        body: { type: "string" },
      },
      merge_policy: {
        fields: { body: "keep_both_copies" },
        default: "last_writer_wins",
      },
    } as TypeSchema);
    expect(r.ok).toBe(true);

    const fetched = await client.getType(typeId);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.merge_policy?.fields?.body).toBe("keep_both_copies");
    expect(fetched.data.merge_policy?.default).toBe("last_writer_wins");
  });

  it("POST /types rejects a merge_policy referencing an unknown field", async () => {
    const typeId = `user.evaluator-mp-unknown-field-${ctx.runId}`;
    const r = await client.registerType({
      id: typeId,
      fields: { body: { type: "string" } },
      merge_policy: {
        fields: { does_not_exist: "keep_both_copies" },
      },
    } as TypeSchema);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    // The code, not only the status. `invalid_schema` is what the validator
    // answers when nothing more specific applies, and a 400 alone cannot
    // tell it from the shape refusals the route's own body schema answers.
    expect(r.error?.error.code).toBe("invalid_schema");
  });

  it("POST /types rejects a merge_policy with an unknown strategy", async () => {
    const typeId = `user.evaluator-mp-bad-strategy-${ctx.runId}`;
    const r = await client.registerType({
      id: typeId,
      fields: { body: { type: "string" } },
      // Cast through unknown — the client typings forbid this exact malformation,
      // which is the contract we're asserting the server enforces.
      merge_policy: {
        fields: { body: "made_up_strategy" as unknown as "keep_both_copies" },
      },
    } as TypeSchema);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_schema");
  });

  it("refuses a merge_policy naming an unknown field or strategy on a replacement too", async () => {
    const id = `user.evaluator-mp-replace-${ctx.runId}`;
    const registered = await client.registerType({
      id,
      fields: { body: { type: "string" } },
    });
    expect(registered.status).toBe(201);

    // The witness: a policy naming a declared field and a known strategy.
    const accepted = await client.replaceType(id, {
      fields: { body: { type: "string" } },
      merge_policy: { fields: { body: "keep_both_copies" } },
    });
    expect(accepted.status).toBe(200);

    const unknownField = await client.replaceType(id, {
      fields: { body: { type: "string" } },
      merge_policy: { fields: { does_not_exist: "keep_both_copies" } },
    });
    expect(unknownField.status).toBe(400);
    expect(unknownField.error?.error.code).toBe("invalid_schema");

    const unknownStrategy = await client.replaceType(id, {
      fields: { body: { type: "string" } },
      merge_policy: { fields: { body: "made_up_strategy" } },
    });
    expect(unknownStrategy.status).toBe(400);
    expect(unknownStrategy.error?.error.code).toBe("invalid_schema");

    // Neither refusal replaced the type.
    const read = await client.getType(id);
    expect(read.data.merge_policy?.fields?.body).toBe("keep_both_copies");
  });

  it("a core child type exposes the parent's resolved merge_policy on GET", async () => {
    // core.entity.person extends core.entity; the parent declares only
    // `default: last_writer_wins` and no per-field overrides, and that is what
    // the resolved policy must expose on the child.
    const fetched = await client.getType("core.entity.person");
    expect(fetched.ok).toBe(true);
    expect(fetched.data.merge_policy).toBeDefined();
    expect(fetched.data.merge_policy?.default).toBe("last_writer_wins");
    // No keep-both fields on the entity branch.
    expect(fetched.data.merge_policy?.fields ?? {}).toEqual({});
  });

  it("a runtime-registered custom child type inherits the parent's resolved merge_policy on GET", async () => {
    // A runtime-registered child of `core.note` without its own declaration
    // inherits the parent's resolved policy: `body` and `notes` keep-both, default
    // last-writer-wins. The inheritance is honored both at request time
    // (this test) and at conflict time (covered in
    // correctness/merge-policy.test.ts).
    //
    // The child is registered under `user.*`: inheriting from a core parent is
    // the thing under test, and the child's own id has to sit outside the
    // reserved namespaces because nothing registers a `core.*` type over
    // HTTP.
    const childId = `user.note-evaluator-inherit-${ctx.runId}`;
    const cr = await client.registerType({
      id: childId,
      parent: "core.note",
      fields: { extra: { type: "string" } },
    });
    expect(cr.ok).toBe(true);

    const fetched = await client.getType(childId);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.merge_policy).toBeDefined();
    expect(fetched.data.merge_policy?.default).toBe("last_writer_wins");
    expect(fetched.data.merge_policy?.fields?.body).toBe("keep_both_copies");
    expect(fetched.data.merge_policy?.fields?.notes).toBe("keep_both_copies");
  });

  it("answers 404 for a type that is not registered", async () => {
    const r = await client.getType(`user.absent-${ctx.runId}`);
    expect(r.status).toBe(404);
    expect(r.error?.error.code).toBe("type_not_found");
  });
});
