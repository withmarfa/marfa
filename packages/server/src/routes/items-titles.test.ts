import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeInstanceConfig } from "../storage/instance-config.js";
import type { TestContext } from "../test-utils.js";
import {
  cleanupTestContext,
  createTestContext,
  mintWorkingKey,
  request,
} from "../test-utils.js";

let ctx: TestContext;
let run = 0;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await cleanupTestContext(ctx);
});

interface Found {
  id: string;
  type: string;
  title: string;
  has_blob: boolean;
}
interface Result {
  name: string;
  items: Found[];
  more: boolean;
}

/** A name no other test uses, so a lookup sees only what the test made. */
function unique(label: string): string {
  run += 1;
  return `${label} ${String(run)} ${Math.random().toString(36).slice(2, 8)}`;
}

async function made(
  body: Record<string, unknown>,
  key = ctx.workingKey,
): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", { key, body });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

const note = (title: string, key = ctx.workingKey): Promise<string> =>
  made({ type: "core.note", properties: { title, body: "b" } }, key);

async function titles(
  names: string[],
  key: string | undefined = ctx.workingKey,
): Promise<Result[]> {
  const res = await request(ctx.app, "POST", "/items/titles", {
    key,
    body: { names },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { results: Result[] }).results;
}

async function idsFor(name: string, key?: string): Promise<string[]> {
  const [result] = await titles([name], key);
  return (result?.items ?? []).map((item) => item.id).sort();
}

describe("POST /items/titles", () => {
  it("refuses a caller with no credential", async () => {
    const res = await request(ctx.app, "POST", "/items/titles", {
      body: { names: ["x"] },
    });
    expect(res.status).toBe(401);
  });

  it("finds a title however its case and Unicode form differ, and answers the item's type and title as stored", async () => {
    const stem = unique("Caf");
    const id = await note(`${stem}\u00e9 Notes`);
    const decomposed = await note(`${stem}e\u0301 NOTES`);
    for (const name of [
      `${stem}\u00e9 notes`,
      `${stem}e\u0301 notes`,
      `  ${stem}\u00c9 NOTES\u00a0`,
    ]) {
      expect(await idsFor(name)).toEqual([id, decomposed].sort());
    }
    const [result] = await titles([`${stem}\u00e9 notes`]);
    expect(result?.items.find((item) => item.id === id)).toEqual({
      id,
      type: "core.note",
      title: `${stem}\u00e9 Notes`,
      has_blob: false,
    });
  });

  it("matches a whole title, not a part of one", async () => {
    const stem = unique("Whole");
    await note(`${stem} and more`);
    expect(await idsFor(stem)).toEqual([]);
  });

  it("folds as the core does, with no context rule for a final sigma", async () => {
    const stem = unique("sigma");
    const id = await note(`${stem} \u039f\u0394\u039f\u03a3`);
    expect(await idsFor(`${stem} \u03bf\u03b4\u03bf\u03c3`)).toEqual([id]);
    expect(await idsFor(`${stem} \u03bf\u03b4\u03bf\u03c2`)).toEqual([]);
  });

  it("answers each name once in the order named, a repeated name each time and an empty name with nothing", async () => {
    const one = unique("order-one");
    const two = unique("order-two");
    const idOne = await note(one);
    const idTwo = await note(two);
    const none = unique("none");
    const results = await titles([two, "", one, "  \u00a0 ", two, none]);
    expect(results.map((result) => result.name.trim())).toEqual([
      two,
      "",
      one,
      "",
      two,
      none,
    ]);
    expect(results.map((result) => result.items.map((i) => i.id))).toEqual([
      [idTwo],
      [],
      [idOne],
      [],
      [idTwo],
      [],
    ]);
    expect(results.every((result) => !result.more)).toBe(true);
  });

  it("answers an empty list with an empty list", async () => {
    expect(await titles([])).toEqual([]);
  });

  it("stops at 20 items for a name and says there are more", async () => {
    const name = unique("many");
    const ids: string[] = [];
    for (let at = 0; at < 20; at += 1) ids.push(await note(name));
    const [exact] = await titles([name]);
    expect(exact?.items).toHaveLength(20);
    expect(exact?.more).toBe(false);

    ids.push(await note(name));
    const [capped] = await titles([name]);
    expect(capped?.items).toHaveLength(20);
    expect(capped?.more).toBe(true);
    expect(capped?.items.map((item) => item.id)).toEqual(
      [...ids].sort().slice(0, 20),
    );
  });

  it("leaves out an item in the bin, and finds it again when it is restored, and not after it is purged", async () => {
    const name = unique("bin");
    const id = await note(name);
    expect(await idsFor(name)).toEqual([id]);

    const trashed = await request(ctx.app, "DELETE", `/items/${id}`, {
      key: ctx.workingKey,
    });
    expect(trashed.status).toBe(200);
    expect(await idsFor(name)).toEqual([]);

    const restored = await request(ctx.app, "POST", `/items/${id}/restore`, {
      key: ctx.workingKey,
    });
    expect(restored.status).toBe(200);
    expect(await idsFor(name)).toEqual([id]);

    await request(ctx.app, "DELETE", `/items/${id}`, { key: ctx.workingKey });
    const purged = await request(ctx.app, "POST", `/items/${id}/purge`, {
      key: ctx.workingKey,
    });
    expect(purged.status).toBe(200);
    expect(await idsFor(name)).toEqual([]);
    const again = await note(name);
    expect(await idsFor(name)).toEqual([again]);
  });

  it("finds an archived item", async () => {
    const name = unique("archived");
    const id = await note(name);
    const moved = await request(ctx.app, "POST", `/items/${id}/transition`, {
      key: ctx.workingKey,
      body: { state: "archived" },
    });
    expect(moved.status).toBe(200);
    expect(await idsFor(name)).toEqual([id]);
  });

  it("follows a title that an update changes, and one that becomes only white space", async () => {
    const before = unique("before");
    const after = unique("after");
    const id = await note(before);
    const patched = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.workingKey,
      body: { version: 1, properties: { title: after } },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect(await idsFor(before)).toEqual([]);
    expect(await idsFor(after)).toEqual([id]);

    const cleared = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.workingKey,
      body: { version: 2, properties: { title: " \u00a0 " } },
    });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    expect(await idsFor(after)).toEqual([]);
  });

  it("follows a title written by a natural-key upsert and by a bulk write", async () => {
    const sourceId = unique("source");
    const first = unique("upsert-first");
    const second = unique("upsert-second");
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        source_id: sourceId,
        properties: { title: first },
      },
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { item: { id: string } }).item.id;
    expect(await idsFor(first)).toEqual([id]);

    const upserted = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        source_id: sourceId,
        properties: { title: second },
      },
    });
    expect([200, 201]).toContain(upserted.status);
    expect(await idsFor(first)).toEqual([]);
    expect(await idsFor(second)).toEqual([id]);

    const bulkTitle = unique("bulk");
    const bulk = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            type: "core.note",
            source_id: sourceId,
            properties: { title: bulkTitle },
          },
          {
            type: "core.note",
            source_id: unique("bulk-new"),
            properties: { title: `${bulkTitle} new` },
          },
        ],
      },
    });
    expect(bulk.status, await bulk.clone().text()).toBe(200);
    expect(await idsFor(second)).toEqual([]);
    expect(await idsFor(bulkTitle)).toEqual([id]);
    expect(await idsFor(`${bulkTitle} new`)).toHaveLength(1);
  });

  it("leaves out a system item whatever it is titled", async () => {
    const name = unique("system");
    await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "system.connection", properties: { title: name } },
    });
    // Whether the write is admitted or refused, a title lookup does not find it.
    expect(await idsFor(name)).toEqual([]);
  });

  it("says whether an item holds a blob", async () => {
    const bytes = new TextEncoder().encode(unique("blob bytes"));
    const upload = await ctx.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.workingKey}`,
        "Content-Type": "text/plain",
      },
      body: bytes,
    });
    expect(upload.status).toBe(201);
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const name = unique("file");
    const file = await made({
      type: "core.file",
      properties: { title: name, blob_ref: hash, mime_type: "text/plain" },
    });
    const plain = await note(name);
    const [result] = await titles([name]);
    expect(
      Object.fromEntries(result?.items.map((i) => [i.id, i.has_blob]) ?? []),
    ).toEqual({ [file]: true, [plain]: false });
  });

  it("is refused for names it does not take", async () => {
    const send = (body: unknown) =>
      request(ctx.app, "POST", "/items/titles", { key: ctx.workingKey, body });
    const tooMany = await send({
      names: Array.from({ length: 201 }, (_, at) => `n${String(at)}`),
    });
    expect(tooMany.status).toBe(400);
    const limit = await send({
      names: Array.from({ length: 200 }, (_, at) => `n${String(at)}`),
    });
    expect(limit.status).toBe(200);
    expect((await send({ names: ["x".repeat(1001)] })).status).toBe(400);
    expect((await send({ names: ["x".repeat(1000)] })).status).toBe(200);
    expect((await send({ names: [4] })).status).toBe(400);
    expect((await send({})).status).toBe(400);
    expect((await send({ names: ["x"], extra: true })).status).toBe(400);
  });

  it("does not find a title that is longer than the cap", async () => {
    const stem = "L".repeat(1001);
    await note(stem);
    expect(await idsFor("L".repeat(1000))).toEqual([]);
  });
});

describe("POST /items/titles and the types a title comes from", () => {
  it("titles an item by the property its type names, and by its parent's when it names none", async () => {
    const parent = `test.titled_${Math.random().toString(36).slice(2, 8)}`;
    const child = `${parent}_child`;
    for (const body of [
      {
        id: parent,
        label: "Titled",
        version: 1,
        parent: "core.note",
        fields: { heading: { type: "string" } },
        display_hints: { title_field: "heading" },
      },
      { id: child, label: "Child", version: 1, parent, fields: {} },
    ]) {
      const res = await request(ctx.app, "POST", "/types", {
        key: ctx.workingKey,
        body,
      });
      expect(res.status, await res.clone().text()).toBe(201);
    }
    const heading = unique("heading");
    const viaParent = await made({
      type: parent,
      properties: { heading, title: "not the heading" },
    });
    const viaChild = await made({
      type: child,
      properties: { heading: `${heading} child`, title: "not either" },
    });
    expect(await idsFor(heading)).toEqual([viaParent]);
    expect(await idsFor(`${heading} child`)).toEqual([viaChild]);
    expect(await idsFor("not the heading")).toEqual([]);
  });

  it("makes the keys again, the bin's included, when a type's title property moves", async () => {
    const id = `test.moving_${Math.random().toString(36).slice(2, 8)}`;
    const child = `${id}_child`;
    const schema = (titleField: string, version: number) => ({
      id,
      label: "Moving",
      version,
      parent: "core.note",
      fields: { first: { type: "string" }, second: { type: "string" } },
      display_hints: { title_field: titleField },
    });
    const created = await request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: schema("first", 1),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const childCreated = await request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: {
        id: child,
        label: "Moving child",
        version: 1,
        parent: id,
        fields: {},
      },
    });
    expect(childCreated.status).toBe(201);

    const first = unique("first");
    const second = unique("second");
    const live = await made({ type: id, properties: { first, second } });
    const inChild = await made({
      type: child,
      properties: { first: `${first} c`, second: `${second} c` },
    });
    const binned = await made({
      type: id,
      properties: { first: `${first} b`, second: `${second} b` },
    });
    await request(ctx.app, "DELETE", `/items/${binned}`, {
      key: ctx.workingKey,
    });
    expect(await idsFor(first)).toEqual([live]);
    expect(await idsFor(second)).toEqual([]);

    const moved = await request(ctx.app, "PUT", `/types/${id}`, {
      key: ctx.workingKey,
      body: schema("second", 2),
    });
    expect(moved.status, await moved.clone().text()).toBe(200);

    expect(await idsFor(first)).toEqual([]);
    expect(await idsFor(second)).toEqual([live]);
    expect(await idsFor(`${second} c`)).toEqual([inChild]);
    expect(await idsFor(`${first} c`)).toEqual([]);

    const restored = await request(
      ctx.app,
      "POST",
      `/items/${binned}/restore`,
      {
        key: ctx.workingKey,
      },
    );
    expect(restored.status).toBe(200);
    expect(await idsFor(`${second} b`)).toEqual([binned]);
    expect(await idsFor(`${first} b`)).toEqual([]);
  });
});

describe("POST /items/titles and what a credential may read", () => {
  it("leaves out an item whose type the credential does not read, and refuses one that reads no type", async () => {
    const name = unique("scope");
    const readable = await note(name);
    const hidden = await made({
      type: "core.bookmark",
      properties: { title: name, url: "https://example.com/scope" },
    });
    expect(await idsFor(name)).toEqual([readable, hidden].sort());

    const notesOnly = await mintWorkingKey(ctx, {
      type_permissions: { "core.note": "read" },
    });
    expect(await idsFor(name, notesOnly)).toEqual([readable]);

    const nothing = await mintWorkingKey(ctx, {
      type_permissions: { "*": "none" },
    });
    const refused = await request(ctx.app, "POST", "/items/titles", {
      key: nothing,
      body: { names: [name] },
    });
    expect(refused.status).toBe(403);
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
    ).toBe("type_not_permitted");
  });
});

describe("POST /items/titles under a source filter", () => {
  let filtered: TestContext;

  beforeAll(async () => {
    filtered = await createTestContext();
  });

  afterAll(async () => {
    await cleanupTestContext(filtered);
  });

  it("leaves out an item of a listed type from a source the filter does not approve, as a listing does", async () => {
    const trusted = await mintWorkingKey(filtered, { source: "trusted" });
    const untrusted = await mintWorkingKey(filtered, { source: "untrusted" });
    const name = unique("filtered");
    const make = async (type: string, key: string) => {
      const res = await request(filtered.app, "POST", "/items", {
        key,
        body: {
          type,
          properties:
            type === "core.note"
              ? { title: name, body: "b" }
              : { title: name, url: "https://example.com/f" },
        },
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { item: { id: string } }).item.id;
    };
    const approved = await make("core.note", trusted);
    await make("core.note", untrusted);
    const unlisted = await make("core.bookmark", untrusted);
    await writeInstanceConfig(filtered.storage.settings, {
      enforcement: {
        source_filter: { types: ["core.note"], sources: ["trusted"] },
      },
    });

    const res = await request(filtered.app, "POST", "/items/titles", {
      key: trusted,
      body: { names: [name] },
    });
    expect(res.status).toBe(200);
    const [result] = ((await res.json()) as { results: Result[] }).results;
    expect(result?.items.map((item) => item.id).sort()).toEqual(
      [approved, unlisted].sort(),
    );
  });
});
