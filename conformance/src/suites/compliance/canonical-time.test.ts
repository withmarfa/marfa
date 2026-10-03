import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateId } from "../../generators/items.js";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  getOperatorClient,
  trackItem,
} from "../../utils/setup.js";
import { itemsArchive } from "../../utils/archive.js";

let client: MarfaClient;
let ctx: TestContext;
type Row = {
  id: string;
  version: number;
  occurred_at: string;
  created_at: string;
  updated_at: string;
};
const rows: Row[] = [];
beforeAll(async () => {
  ({ client, ctx } = await createTestContext("compliance", "canonical-time"));
  for (const time of ["2026-04-01T09:00:00+02:00", "2026-04-01T08:00:00Z"]) {
    const res = await client.createItem({
      type: "core.note",
      occurred_at: time,
      properties: { body: "chronocanonical" },
    });
    expect(res.ok).toBe(true);
    trackItem(ctx, res.data.item.id);
    const occurredAt = res.data.item.occurred_at;
    const updatedAt = res.data.item.updated_at;
    if (occurredAt === null || updatedAt === null)
      throw new Error("a created item's time is absent");
    rows.push({
      ...res.data.item,
      occurred_at: occurredAt,
      updated_at: updatedAt,
    });
  }
});
afterAll(async () => {
  await cleanup(ctx);
});

function scoped(params: Record<string, string>): URLSearchParams {
  const ownSource = `source eq "${ctx.source}"`;
  return new URLSearchParams({
    ...params,
    filter: params.filter ? `${ownSource} AND ${params.filter}` : ownSource,
  });
}

async function ids(
  path: string,
  params: Record<string, string>,
): Promise<string[]> {
  const page = await client.rawRequest<{ data: (Row | { item: Row })[] }>(
    `${path}?${scoped(params)}`,
  );
  expect(page.ok, JSON.stringify(page.error)).toBe(true);
  return page.data.data
    .map((row) => ("item" in row ? row.item.id : row.id))
    .sort();
}

describe("canonical instants on item writes and filters", () => {
  it("stores own time in UTC and orders and bounds it by instant", async () => {
    expect(rows.map((row) => row.occurred_at)).toEqual([
      "2026-04-01T07:00:00.000Z",
      "2026-04-01T08:00:00.000Z",
    ]);
    for (const path of ["/items", "/search"]) {
      const params: Record<string, string> =
        path === "/search" ? { q: "chronocanonical" } : { type: "core.note" };
      expect(
        await ids(path, { ...params, occurred_before: "2026-04-01T07:30:00Z" }),
      ).toEqual([rows[0]!.id]);
      expect(
        await ids(path, { ...params, occurred_after: "2026-04-01T07:30:00Z" }),
      ).toEqual([rows[1]!.id]);
    }
    const sorted = await client.rawRequest<{ data: Row[] }>(
      `/items?${new URLSearchParams({ source: ctx.source, sort: "occurred_at", direction: "asc" })}`,
    );
    expect(sorted.ok).toBe(true);
    expect(sorted.data.data.map((row) => row.id)).toEqual(
      rows.map((row) => row.id),
    );
    const selected = await client.rawRequest<{ ids: string[] }>(
      "/items/bulk-actions",
      {
        method: "POST",
        body: {
          action: "transition",
          state: "archived",
          dry_run: true,
          filter: {
            source: ctx.source,
            occurred_before: "2026-04-01T07:30:00Z",
          },
        },
      },
    );
    expect(selected.ok).toBe(true);
    expect(selected.data.ids).toEqual([rows[0]!.id]);
  });

  it("normalizes filter timestamps on listing and search", async () => {
    for (const field of ["created_at", "updated_at", "occurred_at"] as const) {
      const row = rows[0]!;
      const offset = row[field].replace("Z", "+00:00");
      for (const path of ["/items", "/search"]) {
        const params: Record<string, string> =
          path === "/search" ? { q: "chronocanonical" } : { type: "core.note" };
        const expected = rows
          .filter((r) => r[field] === row[field])
          .map((r) => r.id)
          .sort();
        expect(
          await ids(path, { ...params, filter: `${field} eq "${offset}"` }),
        ).toEqual(expected);
        const second = row[field].replace(/\.\d{3}Z$/, "Z");
        expect(
          await ids(path, { ...params, filter: `${field} gte "${second}"` }),
        ).toEqual(
          rows
            .filter((r) => Date.parse(r[field]) >= Date.parse(second))
            .map((r) => r.id)
            .sort(),
        );
      }
    }
  });

  it("normalizes a patch before comparing stale changes", async () => {
    const row = rows[0]!;
    const first = await client.rawRequest<{ item: Row }>(`/items/${row.id}`, {
      method: "PATCH",
      body: { version: row.version, occurred_at: "2026-04-01T10:00:00+02:00" },
    });
    expect(first.ok).toBe(true);
    expect(first.data.item.occurred_at).toBe("2026-04-01T08:00:00.000Z");
    const echo = await client.rawRequest<{ item: Row }>(`/items/${row.id}`, {
      method: "PATCH",
      body: {
        version: row.version,
        occurred_at: "2026-04-01T09:00:00+02:00",
        properties: { body: "chronocanonical non-colliding text" },
      },
    });
    expect(echo.ok).toBe(true);
    expect(echo.data.item.occurred_at).toBe("2026-04-01T08:00:00.000Z");
  });

  it("refuses a timestamp outside the four-digit UTC range", async () => {
    for (const time of [
      "0000-01-01T00:30:00+02:00",
      "9999-12-31T23:30:00-02:00",
    ]) {
      const created = await client.createItem({
        type: "core.note",
        occurred_at: time,
        properties: { body: "bounded year" },
      });
      if (created.ok) trackItem(ctx, created.data.item.id);
      expect(created.status).toBe(400);
    }
  });

  it("refuses invalid time comparisons while retaining text operators", async () => {
    for (const path of ["/items", "/search"]) {
      const base: Record<string, string> =
        path === "/search" ? { q: "chronocanonical" } : { type: "core.note" };
      for (const literal of ['"not-a-date"', "42", "null"]) {
        const refused = await client.rawRequest(
          `${path}?${scoped({ ...base, filter: `created_at eq ${literal}` })}`,
        );
        expect(refused.status).toBe(400);
      }
      expect(
        await ids(path, { ...base, filter: 'created_at starts_with "2026"' }),
      ).toEqual(rows.map((row) => row.id).sort());
    }
  });

  it("normalizes bulk upserts, queued time updates and restored own time", async () => {
    const sourceId = "canonical-bulk";
    let id = "";
    for (const [time, expected] of [
      ["2026-04-01T09:00:00+02:00", "2026-04-01T07:00:00.000Z"],
      ["2026-04-01T10:00:00+02:00", "2026-04-01T08:00:00.000Z"],
    ]) {
      const bulk = await client.bulkItems([
        {
          type: "core.note",
          source_id: sourceId,
          occurred_at: time,
          properties: { body: "bulk clock" },
        },
      ]);
      expect(bulk.ok).toBe(true);
      expect(bulk.data.counts.errored).toBe(0);
      const written = bulk.data.results[0]!.id;
      if (typeof written !== "string")
        throw new Error("bulk write answered no id");
      if (id) expect(written).toBe(id);
      else {
        id = written;
        trackItem(ctx, id);
      }
      const row = await client.getItem(id);
      expect(row.ok).toBe(true);
      expect(row.data.item.occurred_at).toBe(expected);
    }
    const queued = await client.rawRequest<{ id: string }>(
      "/items/bulk-actions",
      {
        method: "POST",
        body: {
          action: "update_occurred_at",
          occurred_at: "2026-04-01T11:00:00+02:00",
          filter: { source: ctx.source, filter: `source_id eq "${sourceId}"` },
        },
      },
    );
    expect(queued.status).toBe(202);
    const job = await client.pollBulkActionToTerminal(queued.data.id);
    expect(job.status).toBe("completed");
    expect(job.result?.succeeded).toBe(1);
    expect((await client.getItem(id)).data.item.occurred_at).toBe(
      "2026-04-01T09:00:00.000Z",
    );

    const restoredId = generateId();
    const restored = await getOperatorClient().restoreArchive(
      itemsArchive([
        {
          id: restoredId,
          type: "core.note",
          source: ctx.source,
          occurred_at: "2026-01-01T00:30:00+02:00",
          properties: { body: "restored clock" },
        },
      ]),
    );
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    trackItem(ctx, restoredId);
    expect(restored.data.imported).toBe(1);
    expect((await client.getItem(restoredId)).data.item.occurred_at).toBe(
      "2025-12-31T22:30:00.000Z",
    );
  });
});
