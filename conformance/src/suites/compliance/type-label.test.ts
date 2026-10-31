import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, cleanup, trackType } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "type-label"));
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("type label compliance", () => {
  it("built-in types have labels", async () => {
    const list = await client.listTypes();
    expect(list.ok).toBe(true);

    const coreNote = list.data.data.find((t) => t.id === "core.note");
    expect(coreNote).toBeDefined();
    expect(coreNote!.label).toBe("Note");
  });

  it("get single type includes label", async () => {
    const r = await client.getType("core.note");
    expect(r.ok).toBe(true);
    expect(r.data.label).toBe("Note");
  });

  it("register custom type with label", async () => {
    // Labels are a property of any custom type, so the tier is incidental
    // to what this file is about.
    const typeId = `user.label-test-${ctx.runId}`;
    const r = await client.registerType({
      id: typeId,
      label: "Test Widget",
      fields: { title: { type: "string", required: true } },
    });
    expect(r.ok).toBe(true);

    const fetched = await client.getType(typeId);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.label).toBe("Test Widget");
  });

  it("register custom type without label", async () => {
    const typeId = `user.no-label-${ctx.runId}`;
    const r = await client.registerType({
      id: typeId,
      fields: { value: { type: "number" } },
    });
    expect(r.ok).toBe(true);

    const fetched = await client.getType(typeId);
    expect(fetched.ok).toBe(true);
    // Derived from the identifier's last segment: hyphen-separated words,
    // each capitalized.
    const derived = typeId
      .split(".")
      .pop()!
      .split("-")
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join(" ");
    expect(fetched.data.label).toBe(derived);
  });

  it("makes a label from the identifier when a replacement names none", async () => {
    const typeId = `user.relabel-${ctx.runId}`;
    expect(
      (
        await client.registerType({
          id: typeId,
          label: "Given",
          fields: { value: { type: "number" } },
        })
      ).ok,
    ).toBe(true);
    // The witness: the label the registration named is the one read back.
    expect((await client.getType(typeId)).data.label).toBe("Given");

    const replaced = await client.replaceType(typeId, {
      id: typeId,
      fields: { value: { type: "number" } },
    });
    expect(replaced.status, JSON.stringify(replaced.error)).toBe(200);
    const derived = typeId
      .split(".")
      .pop()!
      .replace(/[_-]/g, " ")
      .replace(/\b\w/g, (ch) => ch.toUpperCase());
    expect((await client.getType(typeId)).data.label).toBe(derived);
  });

  it("label appears in type list", async () => {
    const typeId = `user.label-list-${ctx.runId}`;
    const r = await client.registerType({
      id: typeId,
      label: "Listed Widget",
      fields: { name: { type: "string" } },
    });
    expect(r.ok).toBe(true);

    const list = await client.listTypes();
    expect(list.ok).toBe(true);

    const found = list.data.data.find((t) => t.id === typeId);
    expect(found).toBeDefined();
    expect(found!.label).toBe("Listed Widget");
  });

  it("answers a field's own label, and one made from the name of a field or member that names none", async () => {
    const typeId = `user.field-labels-${ctx.runId}`;
    const r = await client.registerType({
      id: typeId,
      fields: {
        due_at: { type: "datetime" },
        website: { type: "url", label: "Web Address" },
        contacts: {
          type: "array",
          items_type: "object",
          items_fields: {
            phone_number: { type: "string" },
            kind: { type: "string", label: "Kind of Contact" },
          },
        },
      },
    } as never);
    expect(r.status, JSON.stringify(r.error)).toBe(201);
    trackType(ctx, typeId, client);

    const fields = (await client.getType(typeId)).data.fields;
    expect(fields.due_at.label).toBe("Due At");
    expect(fields.website.label).toBe("Web Address");
    const members = fields.contacts.items_fields;
    expect(members?.phone_number.label).toBe("Phone Number");
    expect(members?.kind.label).toBe("Kind of Contact");
  });

  it("lists only the field labels a type declares", async () => {
    const typeId = `user.field-labels-listed-${ctx.runId}`;
    const r = await client.registerType({
      id: typeId,
      fields: {
        due_at: { type: "datetime" },
        website: { type: "url", label: "Web Address" },
      },
    } as never);
    expect(r.status, JSON.stringify(r.error)).toBe(201);
    trackType(ctx, typeId, client);

    const listed = (await client.listTypes()).data.data.find(
      (t) => t.id === typeId,
    );
    const fields = listed!.fields;
    expect(fields.website.label).toBe("Web Address");
    expect(fields.due_at).not.toHaveProperty("label");
  });

  it("answers the nearest field label a type above names, and a child's own in its place", async () => {
    const parent = `user.label-parent-${ctx.runId}`;
    const plain = `user.label-plain-${ctx.runId}`;
    const own = `user.label-own-${ctx.runId}`;
    const field = {
      type: "array",
      items_type: "object",
      items_fields: { value: { type: "string", label: "Given Member" } },
    };
    expect(
      (
        await client.registerType({
          id: parent,
          fields: {
            score: { type: "integer", label: "Given" },
            entries: field,
          },
        } as never)
      ).status,
    ).toBe(201);
    trackType(ctx, parent, client);
    expect(
      (
        await client.registerType({
          id: plain,
          parent,
          fields: {
            score: { type: "integer", description: "Restated." },
            entries: {
              ...field,
              items_fields: { value: { type: "string" } },
            },
          },
        } as never)
      ).status,
    ).toBe(201);
    trackType(ctx, plain, client, parent);
    const ownRes = await client.registerType({
      id: own,
      parent,
      fields: {
        score: { type: "integer", label: "Mine" },
        entries: {
          ...field,
          items_fields: { value: { type: "string", label: "My Member" } },
        },
      },
    } as never);
    expect(ownRes.status, JSON.stringify(ownRes.error)).toBe(201);
    trackType(ctx, own, client, parent);

    const read = async (id: string) =>
      (await client.getType(id)).data.fields as Record<
        string,
        { label?: string; items_fields?: Record<string, { label?: string }> }
      >;
    const plainFields = await read(plain);
    expect(plainFields.score.label).toBe("Given");
    expect(plainFields.entries.items_fields!.value.label).toBe("Given Member");
    const ownFields = await read(own);
    expect(ownFields.score.label).toBe("Mine");
    expect(ownFields.entries.items_fields!.value.label).toBe("My Member");
    // The witness: the child's label never reaches the parent.
    const parentFields = await read(parent);
    expect(parentFields.score.label).toBe("Given");
    expect(parentFields.entries.items_fields!.value.label).toBe("Given Member");
  });

  it("makes a plural from the label when a type names none", async () => {
    const cases: [string, string][] = [
      ["Widget", "Widgets"],
      ["Story", "Stories"],
      ["Day", "Days"],
      ["Box", "Boxes"],
      ["Church", "Churches"],
      ["URL", "URLs"],
    ];
    for (const [label, plural] of cases) {
      const typeId = `user.plural-${label.toLowerCase()}-${ctx.runId}`;
      const r = await client.registerType({
        id: typeId,
        label,
        fields: { value: { type: "number" } },
      } as never);
      expect(r.status, JSON.stringify(r.error)).toBe(201);
      trackType(ctx, typeId, client);
      expect((await client.getType(typeId)).data.plural, label).toBe(plural);
    }
  });

  it("lists only the plural a type declares", async () => {
    const made = `user.plural-listed-made-${ctx.runId}`;
    const declared = `user.plural-listed-declared-${ctx.runId}`;
    for (const body of [
      { id: made, label: "Story" },
      { id: declared, label: "Person", plural: "People" },
    ]) {
      const r = await client.registerType({
        ...body,
        fields: { value: { type: "number" } },
      } as never);
      expect(r.status, JSON.stringify(r.error)).toBe(201);
      trackType(ctx, body.id, client);
    }

    const listed = (await client.listTypes()).data.data;
    // The read answers the made plural, so the list leaving it out is a
    // choice and not a type that has none.
    expect((await client.getType(made)).data.plural).toBe("Stories");
    expect(listed.find((t) => t.id === made)).not.toHaveProperty("plural");
    expect(listed.find((t) => t.id === declared)!.plural).toBe("People");
  });

  it("keeps a plural the type names", async () => {
    const typeId = `user.plural-named-${ctx.runId}`;
    const r = await client.registerType({
      id: typeId,
      label: "Person",
      plural: "People",
      fields: { value: { type: "number" } },
    } as never);
    expect(r.status, JSON.stringify(r.error)).toBe(201);
    trackType(ctx, typeId, client);
    expect((await client.getType(typeId)).data.plural).toBe("People");

    // A child names no plural, so it gets one from its own label rather
    // than its parent's plural.
    const child = `user.plural-child-${ctx.runId}`;
    expect(
      (
        await client.registerType({
          id: child,
          parent: typeId,
          label: "Author",
          fields: {},
        } as never)
      ).status,
    ).toBe(201);
    trackType(ctx, child, client, typeId);
    expect((await client.getType(child)).data.plural).toBe("Authors");
  });

  it("does not freeze a made plural or field label when a read is written back", async () => {
    const typeId = `user.label-write-back-${ctx.runId}`;
    const r = await client.registerType({
      id: typeId,
      label: "Story",
      fields: {
        due_at: { type: "datetime" },
        website: { type: "url", label: "Web Address" },
      },
    } as never);
    expect(r.status, JSON.stringify(r.error)).toBe(201);
    trackType(ctx, typeId, client);

    const read = (await client.getType(typeId)).data;
    expect(read.plural).toBe("Stories");
    expect(read.fields.due_at.label).toBe("Due At");
    const { provenance: _provenance, ...definition } = read as typeof read & {
      provenance?: unknown;
    };
    const replaced = await client.replaceType(typeId, {
      ...definition,
      label: "Tale",
      fields: {
        ...definition.fields,
        website: { ...definition.fields.website, label: "Home Page" },
      },
    });
    expect(replaced.status, JSON.stringify(replaced.error)).toBe(200);
    expect(replaced.data.type.plural).toBe("Tales");

    const after = (await client.getType(typeId)).data;
    expect(after.plural).toBe("Tales");
    expect(after.fields.website.label).toBe("Home Page");
    const listed = (await client.listTypes()).data.data.find(
      (t) => t.id === typeId,
    );
    expect(listed!.fields.due_at).not.toHaveProperty("label");
    expect(listed!.fields.website.label).toBe("Home Page");
  });

  it("refuses a label or plural longer than 100 characters or not text", async () => {
    const shapes: [string, (text: unknown) => object][] = [
      ["label", (text) => ({ label: text, fields: {} })],
      ["plural", (text) => ({ plural: text, fields: {} })],
      [
        "fields.value.label",
        (text) => ({ fields: { value: { type: "string", label: text } } }),
      ],
      [
        "fields.entries.items_fields.value.label",
        (text) => ({
          fields: {
            entries: {
              type: "array",
              items_type: "object",
              items_fields: { value: { type: "string", label: text } },
            },
          },
        }),
      ],
    ];
    for (const [path, body] of shapes) {
      for (const bad of ["x".repeat(101), 7]) {
        const typeId = `user.long-label-${Math.random().toString(36).slice(2, 10)}`;
        const r = await client.registerType({
          id: typeId,
          ...body(bad),
        } as never);
        expect(r.status, `${path} ${String(bad)}`).toBe(400);
        expect(r.error?.error.code).toBe("invalid_schema");
        expect(JSON.stringify(r.error?.error.details)).toContain(path);
      }
      // The witness: 100 characters, counted as code points, is taken.
      const typeId = `user.long-label-${Math.random().toString(36).slice(2, 10)}`;
      const ok = await client.registerType({
        id: typeId,
        ...body("é".repeat(99) + "😀"),
      } as never);
      expect(ok.status, `${path}: ${JSON.stringify(ok.error)}`).toBe(201);
      trackType(ctx, typeId, client);
    }
  });

  it("ships labels and plurals where a core field's name or type's label reads badly", async () => {
    const person = (await client.getType("core.entity.person")).data;
    expect(person.plural).toBe("People");
    expect((await client.getType("core.note")).data.plural).toBe("Notes");
    expect((await client.getType("core.media.series")).data.plural).toBe(
      "Series",
    );
    const phones = person.fields.phones;
    expect(phones.label).toBe("Phone Numbers");
    for (const [id, plural] of [
      ["core.media", "Media"],
      ["core.file.audio", "Audio"],
    ]) {
      expect((await client.getType(id)).data.plural, id).toBe(plural);
    }
    // The core types `types/shipped` names.
    const shipped = [
      "bookmark",
      "collection",
      "entity",
      "entity.person",
      "entity.place",
      "event",
      "file",
      "file.audio",
      "file.image",
      "file.video",
      "file.webpage",
      "highlight",
      "media",
      "media.album",
      "media.article",
      "media.book",
      "media.episode",
      "media.film",
      "media.game",
      "media.series",
      "media.song",
      "message",
      "note",
      "task",
    ].map((name) => `core.${name}`);
    let urls = 0;
    for (const id of shipped) {
      const fields = (await client.getType(id)).data.fields;
      if (fields.url === undefined) continue;
      urls += 1;
      expect(fields.url.label, id).toBe("URL");
    }
    expect(urls).toBeGreaterThan(0);
    const task = (await client.getType("core.task")).data.fields;
    expect(task.due_at.label).toBe("Due");
  });
});
