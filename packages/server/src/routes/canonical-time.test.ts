import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestContext,
  request,
  runBulkActionAsync,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.cleanup();
});

interface Row {
  id: string;
  version: number;
  occurred_at: string;
  updated_at: string;
  created_at: string;
}
async function create(time: string): Promise<Row> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: {
      type: "core.note",
      occurred_at: time,
      properties: { body: "chronocanonical" },
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: Row }).item;
}
async function read(id: string): Promise<Row> {
  const res = await request(ctx.app, "GET", `/items/${id}`, {
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { item: Row }).item;
}
async function ids(path: string, query: URLSearchParams): Promise<string[]> {
  const res = await request(ctx.app, "GET", `${path}?${query.toString()}`, {
    key: ctx.workingKey,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: (Row | { item: Row })[] };
  return body.data.map((r) => ("item" in r ? r.item.id : r.id)).sort();
}

describe("canonical item instants", () => {
  it("compares a stale echo by instant rather than timestamp spelling", async () => {
    const original = await create("2026-04-01T07:00:00.000Z");
    const changed = await request(ctx.app, "PATCH", `/items/${original.id}`, {
      key: ctx.workingKey,
      body: {
        version: original.version,
        occurred_at: "2026-04-01T08:00:00.000Z",
      },
    });
    expect(changed.status).toBe(200);
    const echoed = await request(ctx.app, "PATCH", `/items/${original.id}`, {
      key: ctx.workingKey,
      body: {
        version: original.version,
        occurred_at: "2026-04-01T09:00:00+02:00",
        properties: { body: "independent edit" },
      },
    });
    expect(echoed.status).toBe(200);
    expect((await read(original.id)).occurred_at).toBe(
      "2026-04-01T08:00:00.000Z",
    );
  });

  it.each([
    "2026-04-01T09:00:00+02:00",
    "2026-04-01T07:00:00Z",
    "2026-04-01T07:00:00",
  ])("canonicalizes a create spelling %s", async (time) => {
    expect((await create(time)).occurred_at).toBe("2026-04-01T07:00:00.000Z");
  });

  it("canonicalizes bulk creates, bulk upserts, patches and queued updates", async () => {
    const bulk = async (time: string) => {
      const res = await request(ctx.app, "POST", "/items/bulk", {
        key: ctx.workingKey,
        body: {
          items: [
            {
              type: "core.note",
              source_id: "canonical-bulk",
              occurred_at: time,
              properties: { body: "chronocanonical" },
            },
          ],
        },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        counts: { errored: number };
        results: { id: string }[];
      };
      expect(body.counts.errored).toBe(0);
      return body.results[0]!.id;
    };
    const id = await bulk("2026-04-01T09:00:00+02:00");
    expect((await read(id)).occurred_at).toBe("2026-04-01T07:00:00.000Z");
    expect(await bulk("2026-04-01T10:00:00+02:00")).toBe(id);
    const current = await read(id);
    expect(current.occurred_at).toBe("2026-04-01T08:00:00.000Z");
    const patched = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.workingKey,
      body: {
        version: current.version,
        occurred_at: "2026-04-01T11:00:00+02:00",
      },
    });
    expect(patched.status).toBe(200);
    expect((await read(id)).occurred_at).toBe("2026-04-01T09:00:00.000Z");
    const action = await runBulkActionAsync(
      ctx,
      {
        action: "update_occurred_at",
        occurred_at: "2026-04-01T12:00:00+02:00",
        filter: { type: "core.note" },
      },
      ctx.workingKey,
    );
    expect(action.result?.succeeded).toBe(1);
    expect((await read(id)).occurred_at).toBe("2026-04-01T10:00:00.000Z");
  });

  it("bounds and sorts offset instants through listings, search, export and bulk selection", async () => {
    const early = await create("2026-04-01T09:00:00+02:00");
    const late = await create("2026-04-01T08:00:00Z");
    for (const path of ["/items", "/search"]) {
      const base: Record<string, string> =
        path === "/search" ? { q: "chronocanonical" } : { type: "core.note" };
      expect(
        await ids(
          path,
          new URLSearchParams({
            ...base,
            occurred_before: "2026-04-01T07:30:00Z",
          }),
        ),
      ).toEqual([early.id]);
      expect(
        await ids(
          path,
          new URLSearchParams({
            ...base,
            occurred_after: "2026-04-01T07:30:00Z",
          }),
        ),
      ).toEqual([late.id]);
    }
    const page = await request(
      ctx.app,
      "GET",
      "/items?type=core.note&sort=occurred_at&direction=asc&limit=1",
      { key: ctx.workingKey },
    );
    expect(page.status).toBe(200);
    expect(((await page.json()) as { data: Row[] }).data[0]?.id).toBe(early.id);
    const exported = await request(
      ctx.app,
      "GET",
      "/export?format=ndjson&occurred_before=2026-04-01T07:30:00Z",
      { key: ctx.workingKey },
    );
    expect(exported.status).toBe(200);
    const text = await exported.text();
    expect(text).toContain(early.id);
    expect(text).not.toContain(late.id);
    const selected = await runBulkActionAsync(
      ctx,
      {
        action: "transition",
        state: "archived",
        dry_run: true,
        filter: { occurred_before: "2026-04-01T07:30:00Z" },
      },
      ctx.workingKey,
    );
    expect(selected.result?.ids).toEqual([early.id]);
  });

  it.each(["occurred_at", "created_at", "updated_at"] as const)(
    "normalizes %s comparison literals in both filter compilers",
    async (field) => {
      const row = await create("2026-04-01T07:00:00.084Z");
      const instant = row[field];
      const noMillis = instant.replace(/\.\d{3}Z$/, "Z");
      for (const path of ["/items", "/search"]) {
        const base: Record<string, string> =
          path === "/search" ? { q: "chronocanonical" } : { type: "core.note" };
        expect(
          await ids(
            path,
            new URLSearchParams({
              ...base,
              filter: `${field} gte "${noMillis}"`,
            }),
          ),
        ).toEqual([row.id]);
        const offset = instant.replace("Z", "+00:00");
        expect(
          await ids(
            path,
            new URLSearchParams({ ...base, filter: `${field} eq "${offset}"` }),
          ),
        ).toEqual([row.id]);
        expect(
          await ids(
            path,
            new URLSearchParams({ ...base, filter: `${field} lt "${offset}"` }),
          ),
        ).toEqual([]);
      }
    },
  );
});
