import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { RowOperation, TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "conversation",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

async function conversation(title?: string) {
  const made = await client.createItem({
    type: "core.conversation",
    source: ctx.source,
    properties: title === undefined ? {} : { title },
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackItem(ctx, made.data.item.id);
  return made.data.item;
}

function message(
  text: string,
  extra: Record<string, unknown> = {},
): RowOperation {
  return {
    op: "put",
    values: {
      author: "alice",
      text,
      sent_at: new Date().toISOString(),
      ...extra,
    },
  } as RowOperation;
}

async function append(item: string, operations: RowOperation[]) {
  const res = await client.writeRows(item, "messages", { operations });
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data;
}

async function image() {
  const blob = await client.uploadBlob(PNG, "image/png");
  expect(blob.status, JSON.stringify(blob.error)).toBe(201);
  const made = await client.createItem({
    type: "core.file.image",
    source: ctx.source,
    properties: { blob_ref: blob.data.hash, mime_type: "image/png" },
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackItem(ctx, made.data.item.id);
  return made.data.item.id;
}

describe("the type", () => {
  it("ships core.conversation with an optional title", async () => {
    const type = (await client.getType("core.conversation")).data as {
      fields: Record<string, { type: string; required?: boolean }>;
      display_hints?: { title_field?: string };
    };
    expect(Object.keys(type.fields)).toEqual(["title"]);
    expect(type.fields.title?.type).toBe("string");
    expect(type.fields.title?.required).not.toBe(true);
    expect(type.display_hints?.title_field).toBe("title");
  });

  it("creates a conversation with no properties", async () => {
    const made = await conversation();
    expect(made.properties).toEqual({});
  });

  it("declares a messages table with the author, text, sent time and attachment columns", async () => {
    const type = (await client.getType("core.conversation")).data as {
      tables: Record<string, { columns: Record<string, unknown> }>;
    };
    expect(Object.keys(type.tables)).toEqual(["messages"]);
    expect(type.tables.messages?.columns).toMatchObject({
      author: { type: "string", required: true },
      text: { type: "string", searchable: true },
      sent_at: { type: "datetime", required: true },
      attachment: { type: "item", type_constraints: ["core.file"] },
    });
    expect(Object.keys(type.tables.messages?.columns ?? {})).toEqual([
      "author",
      "text",
      "sent_at",
      "attachment",
    ]);

    const item = await conversation("Planning");
    const refused = await client.writeRows(item.id, "messages", {
      operations: [
        { op: "put", values: { text: "no author" } },
        { op: "put", values: { author: "alice", text: "no time" } },
      ],
    });
    expect(refused.status).toBe(400);
    expect(
      (await client.listRows(item.id, "messages")).data.data,
    ).toHaveLength(0);
    const textless = await append(item.id, [
      {
        op: "put",
        values: { author: "alice", sent_at: new Date().toISOString() },
      } as RowOperation,
    ]);
    expect(textless.results).toHaveLength(1);
  });
});

describe("appending and reading", () => {
  it("appends a message as a row, moving last_activity_at and nothing else of the conversation", async () => {
    const made = await conversation("Lunch");
    await new Promise((r) => setTimeout(r, 5));
    const written = await append(made.id, [message("Noon?")]);
    const read = (await client.getItem(made.id)).data.item;
    expect(read.last_activity_at! > made.last_activity_at!).toBe(true);
    expect(read.last_activity_at).toBe(written.last_activity_at);
    expect(read.updated_at).toBe(made.updated_at);
    expect(read.version).toBe(made.version);
    const rows = (await client.listRows(made.id, "messages")).data.data;
    expect(rows.map((r) => r.values.text)).toEqual(["Noon?"]);
    expect(
      (await client.listTables(made.id)).data.data.find(
        (t) => t.name === "messages",
      )?.row_count,
    ).toBe(1);
  });

  it("gives each message appended without an id an id after every earlier one", async () => {
    const made = await conversation("Order");
    const texts: string[] = [];
    for (const size of [1, 40, 1, 7]) {
      const batch = Array.from({ length: size }, () => {
        const text = `m${String(texts.length + 1).padStart(3, "0")}`;
        texts.push(text);
        return message(text);
      });
      await append(made.id, batch);
    }
    const other = await conversation("Other");
    await append(other.id, [message("elsewhere")]);
    await append(made.id, [message("last")]);
    texts.push("last");

    const ascending = (
      await client.listRows(made.id, "messages", { limit: 1000 })
    ).data.data;
    expect(ascending.map((r) => r.values.text)).toEqual(texts);
  });

  it("reads the latest messages first, a page at a time", async () => {
    const made = await conversation("Long");
    const texts: string[] = [];
    for (let batch = 0; batch < 3; batch++) {
      const operations = Array.from({ length: 20 }, () => {
        texts.push(`m${String(texts.length).padStart(3, "0")}`);
        return message(texts[texts.length - 1]!);
      });
      await append(made.id, operations);
    }
    const first = await client.listRows(made.id, "messages", {
      sort: "id",
      direction: "desc",
      limit: 25,
    });
    expect(first.data.data.map((r) => r.values.text)).toEqual(
      texts.slice(-25).reverse(),
    );
    expect(first.data.next_cursor).not.toBeNull();
    const second = await client.listRows(made.id, "messages", {
      sort: "id",
      direction: "desc",
      limit: 25,
      cursor: first.data.next_cursor!,
    });
    expect(second.data.data.map((r) => r.values.text)).toEqual(
      texts.slice(10, 35).reverse(),
    );

    const newest = await client.listRows(made.id, "messages", {
      sort: "id",
      direction: "desc",
      limit: 1,
    });
    expect(newest.data.data[0]?.values.text).toBe("m059");
    expect(newest.data.next_cursor).not.toBeNull();
  });
});

describe("listing conversations", () => {
  it("lists conversations by the latest message, newest first", async () => {
    const older = await conversation("older");
    const newer = await conversation("newer");
    const untouched = await conversation("untouched");
    await new Promise((r) => setTimeout(r, 5));
    await append(newer.id, [message("hello")]);
    await new Promise((r) => setTimeout(r, 5));
    await append(older.id, [message("later")]);
    const listed = (
      await client.listItems({
        type: "core.conversation",
        source: ctx.source,
        sort: "last_activity_at",
        direction: "desc",
      })
    ).data.data.map((i) => i.id);
    const mine = [older.id, newer.id, untouched.id];
    expect(listed.filter((id) => mine.includes(id))).toEqual([
      older.id,
      newer.id,
      untouched.id,
    ]);
    const byCreation = (
      await client.listItems({
        type: "core.conversation",
        source: ctx.source,
        sort: "created_at",
        direction: "desc",
      })
    ).data.data.map((i) => i.id);
    expect(byCreation.filter((id) => mine.includes(id))).toEqual([
      untouched.id,
      newer.id,
      older.id,
    ]);
  });
});

describe("pictures and files", () => {
  it("takes a message that names an image or any other file", async () => {
    const made = await conversation("Photos");
    const photo = await image();
    const blob = await client.uploadBlob(
      new TextEncoder().encode("minutes"),
      "text/plain",
    );
    expect(blob.status).toBe(201);
    const file = await client.createItem({
      type: "core.file",
      source: ctx.source,
      properties: { blob_ref: blob.data.hash, mime_type: "text/plain" },
    } as never);
    expect(file.status, JSON.stringify(file.error)).toBe(201);
    trackItem(ctx, file.data.item.id);
    await append(made.id, [
      message("a photo", { attachment: photo }),
      message("minutes", { attachment: file.data.item.id }),
    ]);
    const rows = (await client.listRows(made.id, "messages")).data.data;
    expect(rows.map((r) => r.values.attachment)).toEqual([
      photo,
      file.data.item.id,
    ]);
  });

  it("refuses an attachment that is not a file", async () => {
    const made = await conversation("Notes");
    const note = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { title: "Not a file" },
    } as never);
    trackItem(ctx, note.data.item.id);
    const refused = await client.writeRows(made.id, "messages", {
      operations: [message("see note", { attachment: note.data.item.id })],
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(refused.error?.error.details).toMatchObject({
      errors: [{ path: "operations.0.values.attachment" }],
    });
    expect(
      (await client.listRows(made.id, "messages")).data.data,
    ).toHaveLength(0);
  });

  it("withholds the attachment of a message from a key that may not read files, and keeps the message", async () => {
    const made = await conversation("Private photos");
    const photo = await image();
    const sent = await append(made.id, [message("look", { attachment: photo })]);
    const id = sent.results[0]!.id;
    const key = await client.createKey({
      label: "conversation-reader",
      source: `${ctx.source}-reader`,
      type_permissions: { "core.conversation": "read" },
    });
    expect(key.ok, JSON.stringify(key.error)).toBe(true);
    trackKey(ctx, key.data.id);
    const reader = new MarfaClient({ baseUrl: apiUrl, apiKey: key.data.key });

    const row = (await reader.getRow(made.id, "messages", id)).data;
    expect(row.values.text).toBe("look");
    expect(row.values).not.toHaveProperty("attachment");
    expect(row.withheld).toEqual(["attachment"]);
    const listed = (await reader.listRows(made.id, "messages")).data.data;
    expect(listed[0]?.withheld).toEqual(["attachment"]);
    expect(
      (await client.getRow(made.id, "messages", id)).data.values.attachment,
    ).toBe(photo);
  });
});
