import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { FieldDefinition, TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackEdgeType,
  trackItem,
  cleanup,
} from "../../utils/setup.js";
import { collectUntil, withStream } from "../../utils/stream.js";

/**
 * A thumbnail is a field type of its own: a small image a writer supplies,
 * carried inside its item on every door that answers the item, and never
 * searched. A device holds it with the item rather than fetching it, which
 * is what lets a phone hold a library's thumbnails and not its bytes.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let typeId: string;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CAP = 16 * 1024;
const padded = (size: number): Buffer =>
  Buffer.concat([PNG, Buffer.alloc(size - PNG.length, 7)]);
const uri = (bytes: Buffer, mime = "image/png"): string =>
  `data:${mime};base64,${bytes.toString("base64")}`;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "thumbnails",
  ));
  typeId = `user.snapshot-${ctx.runId}`;
  const registered = await client.registerType({
    id: typeId,
    fields: {
      title: { type: "string" },
      body: { type: "string" },
      thumbnail: { type: "thumbnail" },
    },
  });
  expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
});

afterAll(async () => {
  await cleanup(ctx);
});

async function create(
  properties: Record<string, unknown>,
): ReturnType<MarfaClient["createItem"]> {
  const created = await client.createItem({
    type: typeId,
    source: ctx.source,
    properties,
  });
  if (created.ok) trackItem(ctx, created.data.item.id);
  return created;
}

describe("a thumbnail field", () => {
  it("registers by its type or by the format that stands for it", async () => {
    const read = await client.getType(typeId);
    expect(read.ok).toBe(true);
    expect(read.data.fields.thumbnail?.type).toBe("thumbnail");

    const byFormat = `user.snapshot-format-${ctx.runId}`;
    const registered = await client.registerType({
      id: byFormat,
      fields: { cover: { type: "string", format: "thumbnail" } },
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    const stored = await client.getType(byFormat);
    expect(stored.ok).toBe(true);
    expect(
      stored.data.fields.cover,
      "a thumbnail declared by its format is stored under a second spelling",
    ).toEqual({ type: "thumbnail" });
  });

  it("refuses a thumbnail named for a field search indexes, and a second thumbnail", async () => {
    const refusedShapes: Array<Record<string, FieldDefinition>> = [
      { title: { type: "thumbnail" } },
      { body: { type: "thumbnail" } },
      { description: { type: "thumbnail" } },
      { name: { type: "thumbnail" } },
      { thumbnail: { type: "thumbnail" }, cover: { type: "thumbnail" } },
      { covers: { type: "array", items_type: "thumbnail" } },
      { title: { type: "array", items_type: "thumbnail" } },
    ];
    for (const fields of refusedShapes) {
      const refused = await client.registerType({
        id: `user.snapshot-refused-${ctx.runId}`,
        fields,
      });
      expect(
        refused.status,
        `a type declaring ${JSON.stringify(fields)} was registered`,
      ).toBe(400);
    }
    // Counting the one a subtype inherits.
    const inheriting = await client.registerType({
      id: `user.snapshot-child-${ctx.runId}`,
      parent: typeId,
      fields: { cover: { type: "thumbnail" } },
    });
    expect(
      inheriting.status,
      "a subtype added a thumbnail beside the one it inherits",
    ).toBe(400);
    // The witnesses: the type registered before all this declares one
    // thumbnail under a name search does not index, and a subtype that adds
    // none registers.
    expect((await client.getType(typeId)).ok).toBe(true);
    const plainChild = await client.registerType({
      id: `user.snapshot-plain-${ctx.runId}`,
      parent: typeId,
      fields: { camera: { type: "string" } },
    });
    expect(plainChild.ok, JSON.stringify(plainChild.error)).toBe(true);
  });

  it("refuses a parent gaining a thumbnail beside one its child already declares", async () => {
    const parent = `user.album-${ctx.runId}`;
    expect(
      (
        await client.registerType({
          id: parent,
          fields: { label: { type: "string" } },
        })
      ).ok,
    ).toBe(true);
    const child = await client.registerType({
      id: `user.album-child-${ctx.runId}`,
      parent,
      fields: { preview: { type: "thumbnail" } },
    });
    expect(child.ok, JSON.stringify(child.error)).toBe(true);
    const widened = await client.updateType(parent, {
      id: parent,
      version: 2,
      fields: { label: { type: "string" }, cover: { type: "thumbnail" } },
    });
    expect(
      widened.status,
      "a parent gained a thumbnail beside its child's, so the child's items carry two and a device reads one of them",
    ).toBe(400);
    // The witness: the same update without the thumbnail is taken.
    const plain = await client.updateType(parent, {
      id: parent,
      version: 2,
      fields: { label: { type: "string" }, note: { type: "string" } },
    });
    expect(plain.ok, JSON.stringify(plain.error)).toBe(true);
  });

  it("refuses a parent gaining a thumbnail under a name its child declares as text, and takes one its child declares as a thumbnail", async () => {
    const parent = `user.shelf-${ctx.runId}`;
    expect(
      (
        await client.registerType({
          id: parent,
          fields: { label: { type: "string" } },
        })
      ).ok,
    ).toBe(true);
    const child = await client.registerType({
      id: `user.shelf-child-${ctx.runId}`,
      parent,
      fields: { cover: { type: "string" }, preview: { type: "thumbnail" } },
    });
    expect(child.ok, JSON.stringify(child.error)).toBe(true);
    const texted = await client.updateType(parent, {
      id: parent,
      version: 2,
      fields: { label: { type: "string" }, cover: { type: "thumbnail" } },
    });
    expect(
      texted.status,
      "a parent gained a thumbnail its child reads as text, so a device reads the child's text as the image",
    ).toBe(400);
    expect(texted.error?.error.code).toBe("inheritance_violation");
    const errors = texted.error?.error.details?.errors as
      Array<{ field: string; code?: string }> | undefined;
    expect(errors?.map((error) => [error.field, error.code])).toContainEqual([
      "fields.cover.type",
      "inheritance_violation",
    ]);
    // The same name and the same shape is the child redeclaring what its
    // parent now declares, not a second thumbnail beside it.
    const same = await client.updateType(parent, {
      id: parent,
      version: 2,
      fields: { label: { type: "string" }, preview: { type: "thumbnail" } },
    });
    expect(same.ok, JSON.stringify(same.error)).toBe(true);
  });

  it("refuses a title or a body naming the thumbnail, and an edge property that is one", async () => {
    const titled = await client.registerType({
      id: `user.snapshot-titled-${ctx.runId}`,
      fields: { cover: { type: "thumbnail" }, caption: { type: "string" } },
      display_hints: { title_field: "cover" },
    });
    expect(
      titled.status,
      "a type named its thumbnail as its title, so the image's base64 is read and searched as text",
    ).toBe(400);
    const bodied = await client.registerType({
      id: `user.snapshot-bodied-${ctx.runId}`,
      fields: { cover: { type: "thumbnail" }, caption: { type: "string" } },
      display_hints: { body_field: "cover" },
    });
    expect(bodied.status).toBe(400);
    // The witness: the same type titled by its caption registers.
    const captioned = await client.registerType({
      id: `user.snapshot-captioned-${ctx.runId}`,
      fields: { cover: { type: "thumbnail" }, caption: { type: "string" } },
      display_hints: { title_field: "caption" },
    });
    expect(captioned.ok, JSON.stringify(captioned.error)).toBe(true);

    const edge = await client.registerEdgeType({
      id: `mock.depicts.${ctx.runId}`,
      cardinality: "many-to-many",
      property_schema: { preview: { type: "thumbnail" } },
    });
    expect(
      edge.status,
      "an edge type declared a thumbnail property, which nothing checks and nothing reads",
    ).toBe(400);
    // The format that stands for a thumbnail on a type's field is refused
    // on an edge's property too, rather than dropped and the edge type
    // registered as though it had carried none.
    const formatEdge = await client.registerEdgeType({
      id: `mock.depicts-format.${ctx.runId}`,
      cardinality: "many-to-many",
      property_schema: { preview: { type: "string", format: "thumbnail" } },
    });
    expect(
      formatEdge.status,
      "an edge type declared a thumbnail by its format, and the format was dropped rather than refused",
    ).toBe(400);
    const arrayEdge = await client.registerEdgeType({
      id: `mock.depicts-array.${ctx.runId}`,
      cardinality: "many-to-many",
      property_schema: { previews: { type: "array", items_type: "thumbnail" } },
    });
    expect(
      arrayEdge.status,
      "an edge type declared an array of thumbnails, whose elements nothing checks",
    ).toBe(400);
    const plainEdge = await client.registerEdgeType({
      id: `mock.depicts-plain.${ctx.runId}`,
      cardinality: "many-to-many",
      property_schema: { note: { type: "string" } },
    });
    expect(plainEdge.ok, JSON.stringify(plainEdge.error)).toBe(true);
    trackEdgeType(ctx, `mock.depicts-plain.${ctx.runId}`);
  });

  it("travels inside its item on a get, a list, an event frame and an export", async ({
    signal,
  }) => {
    const value = uri(padded(200));
    const created = await withStream(apiUrl, apiKey, {}, async (stream) => {
      // Let the subscription settle before the write, or its event is
      // published to nobody.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const made = await create({ title: "Holiday", thumbnail: value });
      expect(made.ok, JSON.stringify(made.error)).toBe(true);
      const id = made.data.item.id;
      const { events } = await collectUntil(
        stream,
        (seen) =>
          seen.some(
            (event) =>
              (event.data as { item?: { id?: string } }).item?.id === id,
          ),
        `the create of ${id} to reach the stream`,
        signal,
      );
      const frame = events.find(
        (event) => (event.data as { item?: { id?: string } }).item?.id === id,
      );
      expect(
        (frame?.data as { item: { properties: Record<string, unknown> } }).item
          .properties.thumbnail,
        "the event frame did not carry the thumbnail, so a device following the stream holds the item without it",
      ).toBe(value);
      return made.data.item;
    });
    expect(created.properties.thumbnail).toBe(value);

    const got = await client.getItem(created.id);
    expect(got.ok).toBe(true);
    expect(got.data.item.properties.thumbnail).toBe(value);

    const listed = await client.listItems({ type: typeId, limit: 50 });
    expect(listed.ok).toBe(true);
    expect(
      listed.data.data.find((item) => item.id === created.id)?.properties
        .thumbnail,
      "a list answered the item without its thumbnail, so a hydration holds none",
    ).toBe(value);

    const exported = await client.exportItems({ type: typeId });
    expect(exported.ok).toBe(true);
    expect(exported.data).toContain(value);
  });

  it("refuses a thumbnail over the cap or not an image, naming the field", async () => {
    // The witness: an image at the cap is taken.
    const atCap = await create({
      title: "At the cap",
      thumbnail: uri(padded(CAP)),
    });
    expect(atCap.ok, JSON.stringify(atCap.error)).toBe(true);

    for (const [what, value] of [
      ["over the cap", uri(padded(CAP + 1))],
      ["not an image", uri(Buffer.from("plain text"), "text/plain")],
      [
        "not the image it says",
        uri(Buffer.from("GIF89a and more"), "image/png"),
      ],
      ["a link rather than the bytes", "https://example.com/thumb.png"],
      // Bits the bytes do not use, which a strict decoder refuses.
      ["not canonical base64", "data:image/png;base64,iVBORw0KGgp="],
      [
        "an uppercase media type",
        `data:image/PNG;base64,${padded(64).toString("base64")}`,
      ],
    ] as const) {
      const refused = await create({ title: what, thumbnail: value });
      expect(refused.ok, `a thumbnail ${what} was taken`).toBe(false);
      expect(refused.status).toBe(400);
      expect(refused.error?.error.code).toBe("invalid_properties");
      const errors = refused.error?.error.details?.errors as
        Array<{ field: string }> | undefined;
      expect(errors?.map((error) => error.field)).toContain("thumbnail");
    }
  });

  it("refuses a thumbnail that is not an image on an update and inside a bulk page", async () => {
    const made = await create({ title: "Updated", thumbnail: uri(padded(64)) });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    const id = made.data.item.id;
    // The witness: an image is taken on the update door.
    const replaced = uri(padded(65));
    const taken = await client.updateItem(id, {
      properties: { thumbnail: replaced },
      version: made.data.item.version,
    });
    expect(taken.ok, JSON.stringify(taken.error)).toBe(true);
    expect(taken.data.item.properties.thumbnail).toBe(replaced);

    const refused = await client.updateItem(id, {
      properties: { thumbnail: uri(Buffer.from("plain text"), "text/plain") },
      version: taken.data.item.version,
    });
    expect(
      refused.status,
      "an update wrote a thumbnail that is not an image",
    ).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    expect(
      (
        refused.error?.error.details?.errors as
          Array<{ field: string }> | undefined
      )?.map((error) => error.field),
    ).toContain("thumbnail");
    const kept = await client.getItem(id);
    expect(kept.ok && kept.data.item.properties.thumbnail).toBe(replaced);

    const marker = `thumbnails-bulk-${ctx.runId}`;
    const entry = (thumbnail: string, n: number) => ({
      type: typeId,
      properties: { title: marker, thumbnail },
      source_id: `${marker}-${String(n)}`,
    });
    const page = await client.bulkItems({
      items: [
        entry(uri(padded(64)), 1),
        entry(uri(Buffer.from("GIF89a and more"), "image/png"), 2),
      ],
    });
    expect(
      page.status,
      "a bulk page wrote a thumbnail that is not an image",
    ).toBe(400);
    expect(page.error?.error.code).toBe("bulk_atomic_rollback");
    const details = page.error?.error.details as
      | {
          index?: number;
          code?: string;
          details?: { errors?: Array<{ field: string }> };
        }
      | undefined;
    expect(details?.index).toBe(1);
    expect(details?.code).toBe("invalid_properties");
    expect(details?.details?.errors?.map((error) => error.field)).toContain(
      "thumbnail",
    );
    const rolledBack = await client.search(marker, { limit: 10 });
    expect(rolledBack.ok).toBe(true);
    expect(
      rolledBack.data.data,
      "the page's good entry was written beside the refused one",
    ).toEqual([]);
    // The witness: the good entry alone is written.
    const alone = await client.bulkItems({
      items: [entry(uri(padded(64)), 3)],
    });
    expect(alone.ok, JSON.stringify(alone.error)).toBe(true);
    expect(alone.data.counts.created).toBe(1);
    for (const result of alone.data.results) {
      if (result.id) trackItem(ctx, result.id);
    }
    const found = await client.search(marker, { limit: 10 });
    expect(found.ok).toBe(true);
    expect(
      found.data.data.map((hit) => hit.item.id),
      "the search that found nothing after the rollback cannot see a written entry either",
    ).toEqual(alone.data.results.map((result) => result.id));
  });

  it("is not found by a search that finds the same token in a body", async () => {
    // A PNG's signature, then base64 that spells a word of its own: `/`
    // ends one token and starts the next.
    let token = `thumb${ctx.runId.replace(/[^A-Za-z0-9]/g, "")}`;
    while ((token.length + 1) % 4 !== 0) token += "Q";
    const image = `data:image/png;base64,iVBORw0KGgoA/${token}`;
    const inThumbnail = await create({
      title: "Carries the token in its image",
      thumbnail: image,
    });
    expect(inThumbnail.ok, JSON.stringify(inThumbnail.error)).toBe(true);
    const inBody = await create({ title: "Carries it in words", body: image });
    expect(inBody.ok, JSON.stringify(inBody.error)).toBe(true);

    const found = await client.search(token, { limit: 50 });
    expect(found.ok).toBe(true);
    const ids = found.data.data.map((hit) => hit.item.id);
    // The witness: the same image held as a body's text is searchable, so
    // the thumbnail's absence is the rule's doing and not the tokenizer's.
    expect(
      ids,
      "the image held as text was not found either, so nothing here is about the thumbnail",
    ).toContain(inBody.data.item.id);
    expect(
      ids,
      "a search matched an image's base64, so every thumbnail answers searches for whatever its encoding spells",
    ).not.toContain(inThumbnail.data.item.id);
  });
});
