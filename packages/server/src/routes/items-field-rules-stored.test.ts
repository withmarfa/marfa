/**
 * What an update stores of the properties it did not touch, and what a
 * conflicted copy is judged as: a stale write that keeps both copies stores
 * the copy as a create of its type would, and an update that names one field
 * leaves every other stored value as it was.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupTestContext,
  createTestContext,
  overwritePropertiesUnchecked,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
let sequence = 0;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await cleanupTestContext(ctx);
});

type Body = Record<string, unknown>;

const send = async (method: string, path: string, body?: Body) => {
  const res = await request(ctx.app, method, path, {
    key: ctx.workingKey,
    ...(body !== undefined && { body }),
  });
  return { status: res.status, body: (await res.json()) as Body };
};

const itemOf = (answer: { body: Body }) =>
  answer.body.item as {
    id: string;
    version: number;
    properties: Record<string, unknown>;
  };

const register = async (fields: Body, mergeFields: Body) => {
  const id = `user.stored_${Math.random().toString(36).slice(2, 8)}${String(++sequence)}`;
  const registered = await send("POST", "/types", {
    id,
    fields,
    merge_policy: { default: "last_writer_wins", fields: mergeFields },
  });
  expect(registered.status, JSON.stringify(registered.body)).toBe(201);
  return id;
};

const listedIds = async (type: string) => {
  const listed = await send("GET", `/items?type=${type}&limit=100`);
  return (listed.body.data as { id: string }[]).map((item) => item.id).sort();
};

describe("a conflicted copy is judged as a create of its type", () => {
  let type: string;

  beforeAll(async () => {
    type = await register(
      {
        title: { type: "string" },
        link: { type: "url" },
        n: { type: "integer" },
      },
      { link: "keep_both_copies", n: "keep_both_copies" },
    );
  });

  /** An item whose `field` a first writer has moved on, and a second writer's
   *  stale body for it. */
  const collide = async (field: string, first: unknown, stale: unknown) => {
    const created = await send("POST", "/items", {
      type,
      properties: { title: "Shared" },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { id, version } = itemOf(created);
    const moved = await send("PATCH", `/items/${id}`, {
      properties: { [field]: first },
      version,
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const before = await listedIds(type);
    const answer = await send("PATCH", `/items/${id}?conflict=auto`, {
      properties: { [field]: stale },
      version,
    });
    return { id, before, moved: itemOf(moved), answer };
  };

  it("stores a url in the copy without the whitespace around it", async () => {
    const { answer } = await collide(
      "link",
      "https://a.test/",
      "  https://c.test/ \t",
    );
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const copyId = (
      answer.body.conflict_resolution as { conflicted_copy_id?: string }
    ).conflicted_copy_id;
    expect(copyId, "no copy was written").toBeTruthy();
    const copy = await send("GET", `/items/${String(copyId)}`);
    expect(itemOf(copy).properties.link).toBe("https://c.test/");
  });

  it("refuses a copy holding a value of the wrong kind, writing neither the copy nor the change", async () => {
    const { id, before, moved, answer } = await collide("n", 7, "not a number");
    expect(answer.status, JSON.stringify(answer.body)).toBe(400);
    expect((answer.body.error as { code: string }).code).toBe(
      "invalid_properties",
    );
    const errors = (
      answer.body.error as { details: { errors: { field: string }[] } }
    ).details.errors;
    expect(errors.map((e) => e.field)).toContain("n");
    expect(await listedIds(type), "a copy was written").toEqual(before);
    const kept = itemOf(await send("GET", `/items/${id}`));
    expect(kept.version).toBe(moved.version);
    expect(kept.properties.n).toBe(7);

    // The witness: a number in the same collision makes the copy.
    const taken = await collide("n", 7, 9);
    expect(taken.answer.status, JSON.stringify(taken.answer.body)).toBe(200);
    const copyId = (
      taken.answer.body.conflict_resolution as { conflicted_copy_id?: string }
    ).conflicted_copy_id;
    expect(copyId, "no copy was written").toBeTruthy();
    expect(
      itemOf(await send("GET", `/items/${String(copyId)}`)).properties.n,
    ).toBe(9);
  });
});

describe("an update keeps what it did not touch", () => {
  it("keeps a stored null on an optional field and an own __proto__ key", async () => {
    const type = await register(
      {
        title: { type: "string" },
        note: { type: "string" },
        meta: { type: "object" },
        rows: { type: "array", items_type: "object" },
      },
      {},
    );
    const created = await send("POST", "/items", {
      type,
      properties: { title: "t" },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { id, version } = itemOf(created);

    // JSON.parse makes `__proto__` an own key, which an object literal does not.
    const meta = JSON.parse('{"__proto__": {"x": 1}, "k": 1}') as Body;
    const rows = JSON.parse('[{"__proto__": {"y": 2}, "k": 2}]') as Body[];
    expect(Object.hasOwn(meta, "__proto__")).toBe(true);
    await overwritePropertiesUnchecked(ctx.storage, id, {
      title: "t",
      note: null,
      meta,
      rows,
    });

    const updated = await send("PATCH", `/items/${id}`, {
      properties: { title: "t2" },
      version,
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);

    const raw = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.workingKey,
    });
    const text = await raw.text();
    const properties = (JSON.parse(text) as Body & { item: Body }).item
      .properties as Body;
    expect(properties.title).toBe("t2");
    expect(
      Object.hasOwn(properties, "note"),
      "the stored null was dropped",
    ).toBe(true);
    expect(properties.note).toBeNull();
    expect(Object.hasOwn(properties.meta as Body, "__proto__")).toBe(true);
    expect(properties.meta).toEqual(meta);
    expect(Object.hasOwn((properties.rows as Body[])[0]!, "__proto__")).toBe(
      true,
    );
    expect(properties.rows).toEqual(rows);
  });

  it("still clears a field a replace names with a null, and leaves one a merge names", async () => {
    const type = await register(
      { title: { type: "string" }, note: { type: "string" } },
      {},
    );
    const created = await send("POST", "/items", {
      type,
      properties: { title: "t", note: "n" },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { id, version } = itemOf(created);

    const merged = await send("PATCH", `/items/${id}`, {
      properties: { note: null },
      version,
    });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(itemOf(merged).properties).toEqual({ title: "t", note: "n" });

    const replaced = await send("PATCH", `/items/${id}`, {
      properties: { title: "t", note: null },
      properties_mode: "replace",
      version: itemOf(merged).version,
    });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expect(itemOf(replaced).properties).toEqual({ title: "t" });
    expect(itemOf(await send("GET", `/items/${id}`)).properties).toEqual({
      title: "t",
    });
  });

  it("stores an own __proto__ key of an object field on a create", async () => {
    const type = await register({ meta: { type: "object" } }, {});
    const meta = JSON.parse('{"__proto__": {"x": 1}, "k": 1}') as Body;
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type, properties: { meta } },
    });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as { item: { id: string } };
    const read = await request(ctx.app, "GET", `/items/${item.id}`, {
      key: ctx.workingKey,
    });
    const properties = ((await read.json()) as { item: { properties: Body } })
      .item.properties;
    expect(Object.hasOwn(properties.meta as Body, "__proto__")).toBe(true);
    expect(properties.meta).toEqual(meta);
  });
});
