/**
 * The edge checker judges the graph a write will change, so it runs only
 * where that write's transaction is open: outside one, the graph it judged
 * can change before the write lands.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { assertEdgesCanBeCreated } from "./edge-constraints.js";

let ctx: TestContext;
let parent: string;
let child: string;

async function note(body: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body } },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  parent = await note("parent");
  child = await note("child");
});

afterAll(async () => {
  await ctx.cleanup();
});

const check = () =>
  assertEdgesCanBeCreated(
    ctx.storage,
    [{ source_id: parent, target_id: child, edge_type: "parent-of" }],
    () => true,
  );

describe("the edge checker", () => {
  it("judges an edge inside a write transaction", async () => {
    const schemas = await ctx.storage.runInTransaction(check);
    expect(schemas.map((schema) => schema.id)).toEqual(["parent-of"]);
  });

  it("judges an edge inside a savepoint of one", async () => {
    const schemas = await ctx.storage.runInTransaction(() =>
      ctx.storage.runInTransaction(check),
    );
    expect(schemas.map((schema) => schema.id)).toEqual(["parent-of"]);
  });

  it("refuses to run outside a transaction", async () => {
    await expect(check()).rejects.toThrow(/write transaction/);
  });

  it("refuses to run inside a read snapshot", async () => {
    await expect(ctx.storage.runInReadSnapshot(check)).rejects.toThrow(
      /write transaction/,
    );
  });

  it("refuses to run once the transaction it began in has committed", async () => {
    let later: Promise<unknown> | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await ctx.storage.runInTransaction(() => {
      later = gate.then(check);
    });
    release();
    await expect(later).rejects.toThrow(/write transaction/);
  });
});
