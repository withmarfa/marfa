/**
 * The field a type names as its body takes a longer default length than other
 * text, and a type's own hint, or one it inherits, decides which field that is.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  trackItem,
  trackType,
} from "../../utils/setup.js";

const BODY = 1_000_000;
const OTHER = 100_000;
// One character, though two UTF-16 code units.
const ASTRAL = "\u{1F600}";

const RUN = randomUUID().replaceAll("-", "").slice(0, 8);
const PARENT = `user.bodylength-${RUN}-parent`;
const INHERITS = `user.bodylength-${RUN}-inherits`;
const RENAMES = `user.bodylength-${RUN}-renames`;
const UNNAMED = `user.bodylength-${RUN}-unnamed`;
const LOWER = `user.bodylength-${RUN}-lower`;
const HIGHER = `user.bodylength-${RUN}-higher`;
const CHANGING = `user.bodylength-${RUN}-changing`;
const EVENT_RENAMES = `user.bodylength-${RUN}-event-renames`;

const text = { type: "string" } as const;

let client: MarfaClient;
let ctx: TestContext;

async function register(schema: Record<string, unknown>): Promise<void> {
  const registered = await client.registerType({
    version: 1,
    ...schema,
  } as Parameters<MarfaClient["registerType"]>[0]);
  expect(registered.status, JSON.stringify(registered.error)).toBe(201);
  trackType(ctx, schema.id as string);
}

/** `accepted`, or the fields a refusal names, after checking its code. */
async function verdict(
  type: string,
  field: string,
  value: string,
): Promise<string | string[]> {
  const created = await client.createItem({
    type,
    properties: { [field]: value },
  });
  if (created.ok) {
    trackItem(ctx, created.data.item.id);
    return "accepted";
  }
  expect(created.status, JSON.stringify(created.error)).toBe(400);
  expect(created.error?.error.code).toBe("invalid_properties");
  return refusedFields(created.error);
}

function refusedFields(
  error: { error: { details?: Record<string, unknown> } } | undefined,
): string[] {
  const errors = error?.error.details?.errors as
    Array<{ field: string }> | undefined;
  return [...new Set(errors?.map((found) => found.field))];
}

beforeAll(async () => {
  ({ ctx, client } = await createTestContext(
    "compliance",
    "body-field-length",
  ));
  await register({
    id: PARENT,
    fields: { description: text, body: text },
    display_hints: { body_field: "description" },
  });
  await register({ id: INHERITS, parent: PARENT, fields: {} });
  await register({
    id: RENAMES,
    parent: PARENT,
    fields: {},
    display_hints: { body_field: "body" },
  });
  await register({
    id: EVENT_RENAMES,
    parent: "core.event",
    fields: { body: text },
    display_hints: { body_field: "body" },
  });
  await register({ id: UNNAMED, fields: { body: text } });
  await register({
    id: LOWER,
    fields: { body: { type: "string", max_length: 50 } },
    display_hints: { body_field: "body" },
  });
  await register({
    id: HIGHER,
    fields: { body: { type: "string", max_length: 1_200_000 } },
    display_hints: { body_field: "body" },
  });
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("the length a text field allows", () => {
  it("follows a body a type names, inherits or renames", async () => {
    expect(await verdict(PARENT, "description", "x".repeat(BODY))).toBe(
      "accepted",
    );
    expect(await verdict(PARENT, "description", "x".repeat(BODY + 1))).toEqual([
      "description",
    ]);
    expect(await verdict(PARENT, "body", "x".repeat(OTHER))).toBe("accepted");
    expect(await verdict(PARENT, "body", "x".repeat(OTHER + 1))).toEqual([
      "body",
    ]);

    expect(await verdict(INHERITS, "description", "x".repeat(BODY))).toBe(
      "accepted",
    );
    expect(await verdict(INHERITS, "body", "x".repeat(OTHER + 1))).toEqual([
      "body",
    ]);

    expect(await verdict(RENAMES, "body", "x".repeat(BODY))).toBe("accepted");
    expect(await verdict(RENAMES, "description", "x".repeat(OTHER))).toBe(
      "accepted",
    );
    expect(
      await verdict(RENAMES, "description", "x".repeat(OTHER + 1)),
    ).toEqual(["description"]);
  });

  it("gives core.event's description the body's length, and a child that renames its body puts it back", async () => {
    const event = { starts_at: "2026-11-06T10:00:00Z", title: "Event" };
    const write = (type: string, description: string) =>
      client.createItem({ type, properties: { ...event, description } });
    const own = await write("core.event", "x".repeat(BODY));
    expect(own.status, JSON.stringify(own.error)).toBe(201);
    trackItem(ctx, own.data.item.id);
    const child = await write(EVENT_RENAMES, "x".repeat(OTHER + 1));
    expect(child.status).toBe(400);
    expect(refusedFields(child.error)).toEqual(["description"]);
    const fits = await write(EVENT_RENAMES, "x".repeat(OTHER));
    expect(fits.status, JSON.stringify(fits.error)).toBe(201);
    trackItem(ctx, fits.data.item.id);
  });

  it("answers the same at each limit for a character outside the Basic Multilingual Plane", async () => {
    const ending = (characters: number) => "x".repeat(characters - 1) + ASTRAL;
    expect(await verdict(PARENT, "description", ending(BODY))).toBe("accepted");
    expect(await verdict(PARENT, "description", ending(BODY + 1))).toEqual([
      "description",
    ]);
    expect(await verdict(PARENT, "body", ending(OTHER))).toBe("accepted");
    expect(await verdict(PARENT, "body", ending(OTHER + 1))).toEqual(["body"]);
  });

  it("holds a field called body to 100,000 where the type names no body", async () => {
    expect(await verdict(UNNAMED, "body", "x".repeat(OTHER))).toBe("accepted");
    expect(await verdict(UNNAMED, "body", "x".repeat(OTHER + 1))).toEqual([
      "body",
    ]);
  });

  it("lets a body field's own max_length win, lower or higher", async () => {
    expect(await verdict(LOWER, "body", "x".repeat(50))).toBe("accepted");
    expect(await verdict(LOWER, "body", "x".repeat(51))).toEqual(["body"]);
    // Over the default, through the door whose request size allows it.
    const higher = await client.bulkItems({
      atomic: false,
      items: [
        { type: HIGHER, properties: { body: "x".repeat(1_200_000) } },
        { type: HIGHER, properties: { body: "x".repeat(1_200_001) } },
      ],
    });
    expect(higher.status, JSON.stringify(higher.error)).toBe(200);
    expect(higher.data.results.map((row) => row.outcome)).toEqual([
      "created",
      "errored",
    ]);
    expect(higher.data.results[1]?.error?.code).toBe("invalid_properties");
    trackItem(ctx, higher.data.results[0]!.id!);
  });

  it("holds a create, an update and a bulk write to the body's length", async () => {
    const created = await client.createItem({
      type: PARENT,
      properties: { description: "short" },
    });
    expect(created.status).toBe(201);
    const id = created.data.item.id;
    trackItem(ctx, id);

    const updated = await client.updateItem(id, {
      version: created.data.item.version,
      properties: { description: "x".repeat(BODY) },
    });
    expect(updated.status, JSON.stringify(updated.error)).toBe(200);
    const over = await client.updateItem(id, {
      version: updated.data.item.version,
      properties: { description: "x".repeat(BODY + 1) },
    });
    expect(over.status).toBe(400);
    expect(over.error?.error.code).toBe("invalid_properties");
    expect(refusedFields(over.error)).toEqual(["description"]);
    const otherOver = await client.updateItem(id, {
      version: updated.data.item.version,
      properties: { body: "x".repeat(OTHER + 1) },
    });
    expect(otherOver.status).toBe(400);
    expect(refusedFields(otherOver.error)).toEqual(["body"]);
    const read = await client.getItem(id);
    expect(read.data.item.properties.description).toHaveLength(BODY);

    const bulk = await client.bulkItems({
      atomic: false,
      items: [
        { type: PARENT, properties: { description: "x".repeat(BODY) } },
        { type: PARENT, properties: { description: "x".repeat(BODY + 1) } },
      ],
    });
    expect(bulk.status, JSON.stringify(bulk.error)).toBe(200);
    expect(bulk.data.results.map((row) => row.outcome)).toEqual([
      "created",
      "errored",
    ]);
    expect(bulk.data.results[1]?.error?.code).toBe("invalid_properties");
    trackItem(ctx, bulk.data.results[0]!.id!);
  });

  it("refuses a move that puts a long body under a shorter field, and keeps the item", async () => {
    const long = "x".repeat(500_000);
    const created = await client.createItem({
      type: PARENT,
      properties: { description: long },
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    const id = created.data.item.id;
    trackItem(ctx, id);

    const moved = await client.updateItem(id, {
      version: created.data.item.version,
      type: RENAMES,
      retype: true,
    });
    expect(moved.status).toBe(400);
    expect(moved.error?.error.code).toBe("invalid_properties");
    expect(refusedFields(moved.error)).toEqual(["description"]);

    const read = await client.getItem(id);
    expect(read.data.item.type).toBe(PARENT);
    expect(read.data.item.version).toBe(created.data.item.version);
    expect(read.data.item.properties.description).toBe(long);

    // The witness: the same move goes through once the value fits.
    const shortened = await client.updateItem(id, {
      version: created.data.item.version,
      properties: { description: "x".repeat(OTHER) },
    });
    expect(shortened.status, JSON.stringify(shortened.error)).toBe(200);
    const fits = await client.updateItem(id, {
      version: shortened.data.item.version,
      type: RENAMES,
      retype: true,
    });
    expect(fits.status, JSON.stringify(fits.error)).toBe(200);
  });

  it("keeps a long value when the type names another body, and refuses an edit until it is shortened", async () => {
    const fields = { title: text, description: text, body: text };
    await register({
      id: CHANGING,
      fields,
      display_hints: { body_field: "description" },
    });
    const long = "x".repeat(500_000);
    const created = await client.createItem({
      type: CHANGING,
      properties: { title: "Held", description: long },
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    const id = created.data.item.id;
    trackItem(ctx, id);

    // The witness: this edit is taken while the long value's field is the body.
    const before = await client.updateItem(id, {
      version: created.data.item.version,
      properties: { title: "Edited" },
    });
    expect(before.status, JSON.stringify(before.error)).toBe(200);

    const schema = await client.getType(CHANGING);
    expect(schema.ok).toBe(true);
    const replaced = await client.replaceType(CHANGING, {
      version: schema.data.version,
      fields,
      display_hints: { body_field: "body" },
    });
    expect(replaced.ok, JSON.stringify(replaced.error)).toBe(true);

    const read = await client.getItem(id);
    expect(read.data.item.properties.description).toBe(long);
    expect(read.data.item.version).toBe(before.data.item.version);

    const edited = await client.updateItem(id, {
      version: read.data.item.version,
      properties: { title: "Edited again" },
    });
    expect(edited.status).toBe(400);
    expect(edited.error?.error.code).toBe("invalid_properties");
    expect(refusedFields(edited.error)).toEqual(["description"]);

    const shortened = await client.updateItem(id, {
      version: read.data.item.version,
      properties: { title: "Edited again", description: "x".repeat(OTHER) },
    });
    expect(shortened.status, JSON.stringify(shortened.error)).toBe(200);
  });
});
