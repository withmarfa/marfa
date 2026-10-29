/**
 * A row stored with a NULL source reads as the source `unknown`, so the
 * `source` parameter, the `source` filter field and an export's `source`
 * parameter all decide it as `unknown`. A row of another source is the
 * witness that each door still narrows.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestContext,
  request,
  cleanupTestContext,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
const NOW = "2026-01-01T00:00:00.000Z";
const NULL_ID = "01900000-0000-7000-8000-0000000000a1";
const OTHER_ID = "01900000-0000-7000-8000-0000000000a2";
const BODY = "nullsourcefixture";

beforeAll(async () => {
  ctx = await createTestContext();
  const run = (
    ctx.storage as unknown as {
      __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
    }
  ).__sqliteRun;
  for (const [id, source] of [
    [NULL_ID, null],
    [OTHER_ID, "somewhere-else"],
  ] as const) {
    await run(
      `INSERT INTO items (id, type, source, state, tier, properties, created_at, updated_at, occurred_at, version)
       VALUES (?, 'core.note', ?, 'active', 'library', jsonb(?), ?, ?, ?, 1)`,
      [id, source, JSON.stringify({ body: BODY }), NOW, NOW, NOW],
    );
  }
});

afterAll(async () => {
  await cleanupTestContext(ctx);
});

const mine = new Set([NULL_ID, OTHER_ID]);

async function listed(query: string): Promise<string[]> {
  const res = await request(ctx.app, "GET", `/items${query}`, {
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data.map((item) => item.id).filter((id) => mine.has(id));
}

describe("a row stored with a NULL source", () => {
  it("reads as unknown", async () => {
    const res = await request(ctx.app, "GET", `/items/${NULL_ID}`, {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: { source: string } };
    expect(body.item.source).toBe("unknown");
  });

  it("is listed by ?source=unknown and not by another source", async () => {
    expect(await listed("?source=unknown&limit=200")).toEqual([NULL_ID]);
    expect(await listed("?source=somewhere-else&limit=200")).toEqual([
      OTHER_ID,
    ]);
  });

  it('is listed by filter=source eq "unknown" and not by another source', async () => {
    const filter = (source: string) =>
      `?limit=200&filter=${encodeURIComponent(`source eq "${source}"`)}`;
    expect(await listed(filter("unknown"))).toEqual([NULL_ID]);
    expect(await listed(filter("somewhere-else"))).toEqual([OTHER_ID]);
  });

  it("is exported by ?source=unknown and not by another source", async () => {
    const exported = async (source: string) => {
      const res = await request(ctx.app, "GET", `/export?source=${source}`, {
        key: ctx.workingKey,
      });
      expect(res.status).toBe(200);
      return (await res.text())
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { item?: { id: string } })
        .flatMap((row) =>
          row.item && mine.has(row.item.id) ? [row.item.id] : [],
        );
    };
    expect(await exported("unknown")).toEqual([NULL_ID]);
    expect(await exported("somewhere-else")).toEqual([OTHER_ID]);
  });

  it("is not what a create without a source stores", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: BODY } },
    });
    expect(res.status).toBe(201);
    const { item } = (await res.json()) as { item: { id: string } };
    const run = (
      ctx.storage as unknown as {
        __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
      }
    ).__sqliteRun;
    // `changes` counts the rows matched, which is the only answer the
    // escape hatch gives.
    const nullRows = (id: string) =>
      run("UPDATE items SET source = source WHERE source IS NULL AND id = ?", [
        id,
      ]);
    expect(await nullRows(NULL_ID)).toEqual({ changes: 1 });
    expect(await nullRows(item.id)).toEqual({ changes: 0 });
  });
});
