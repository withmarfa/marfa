/**
 * Every door that writes an item's properties, and the schedule rule each
 * holds an event to.
 *
 * **A census rather than a test per door.** An event's rule is unfolded on
 * every calendar read, so a rule no read can finish is refused where items
 * are written, by `validateProperties`, which each property-writing door asks
 * of the properties the row would end up with. A door added without asking
 * it would store such a rule and leave every later read to cope with it, and
 * reads as covered from any one door's tests. So the doors are read out of
 * the app's route table and classified, the modules that write items are
 * read out of the source and classified, and every property-writing door is
 * then driven with a rule that names no date that exists and a zone the zone
 * database does not resolve.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createGzip } from "node:zlib";
import * as tar from "tar-stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestContext,
  request,
  runBulkActionAsync,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/** Doors that write an item's properties, each driven below. */
const WRITING = [
  "POST /items",
  "PATCH /items/:id",
  "POST /items/bulk",
  "POST /items/bulk-actions",
  "POST /admin/restore-archive",
];

/** Doors under `/items` that write no property, with what they write. */
const NOT_WRITING: Record<string, string> = {
  "DELETE /items/:id": "moves a row to the bin",
  "DELETE /items/:id/purge": "removes a row",
  "DELETE /items/:id/extensions/:namespace": "an extension, not a property",
  "DELETE /items/:id/tags/:tag": "a tag",
  "DELETE /items/bulk-actions/jobs/:id": "cancels a queued job",
  "PATCH /items/:id/metadata": "metadata",
  "PUT /items/:id/metadata": "metadata",
  "PUT /items/:id/extensions/:namespace": "an extension, not a property",
  "POST /items/:id/tags": "a tag",
  "POST /items/:id/transition": "a state, the properties as they stand",
  "POST /items/:id/restore": "a state, the properties as they stand",
  "POST /items/bulk-get": "a read",
  "POST /items/lookup": "a read",
  "POST /items/tombstones": "a read",
};

function itemDoors(): string[] {
  return [
    ...new Set(
      ctx.app.routes
        .filter(
          (r) =>
            r.path === "/items" ||
            r.path.startsWith("/items/") ||
            r.path === "/admin/restore-archive",
        )
        .filter((r) => r.method !== "ALL" && r.method !== "GET")
        .map((r) => `${r.method} ${r.path}`),
    ),
  ].sort();
}

/**
 * Every module outside `storage/` that creates or updates an item, with why
 * what it writes is judged. A new writer fails until it is named.
 */
const ITEM_WRITERS: Record<string, string> = {
  "routes/items.ts": "asks validateProperties of the resulting properties",
  "routes/bulk.ts": "asks validateProperties of the resulting properties",
  "bulk-actions/runner.ts":
    "asks validateProperties of the resulting properties",
  "routes/admin-archive.ts": "creates through the store, which asks it",
  "enrichment/sweeper.ts":
    "asks validateProperties of the resulting properties",
  "routes/folders.ts": "system.folder rows, which carry no schedule",
  "routes/auth-pages.ts": "system rows, which carry no schedule",
  "routes/auth-consent.ts": "system rows, which carry no schedule",
  "auth/grant-lifecycle.ts": "system rows, which carry no schedule",
};

const WRITES_ITEMS = /\bitems\.(create|update)\(/;

function itemWriters(): string[] {
  const root = join(import.meta.dirname, "..");
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (rel !== "storage") walk(rel);
      } else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        rel !== "test-utils.ts" &&
        WRITES_ITEMS.test(readFileSync(join(root, rel), "utf8"))
      ) {
        out.push(rel);
      }
    }
  };
  walk("");
  return out.sort();
}

const NEVER = "RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30";
const START = "2026-01-15T09:00:00.000Z";

function fieldsOf(body: unknown): string[] {
  const errors = (
    body as { error?: { details?: { errors?: { field: string }[] } } }
  ).error?.details?.errors;
  return (errors ?? []).map((e) => e.field);
}

async function createEvent(
  properties: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; version: number }> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.event", properties, ...extra },
  });
  expect(res.status).toBe(201);
  const { item } = (await res.json()) as {
    item: { id: string; version: number };
  };
  return item;
}

async function propertiesOf(id: string): Promise<Record<string, unknown>> {
  const res = await request(ctx.app, "GET", `/items/${id}`, {
    key: ctx.workingKey,
  });
  return (
    (await res.json()) as { item: { properties: Record<string, unknown> } }
  ).item.properties;
}

async function archiveOf(itemLine: Record<string, unknown>): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const gzip = createGzip();
  gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
  pack.pipe(gzip);
  const manifest = Buffer.from(
    JSON.stringify({
      version: 0,
      format: "marfa-archive-v0",
      created_at: new Date().toISOString(),
      item_count: 1,
      edge_count: 0,
      blob_count: 0,
      blobs: {},
    }),
  );
  pack.entry({ name: "manifest.json", size: manifest.length }, manifest);
  const items = Buffer.from(`${JSON.stringify(itemLine)}\n`);
  pack.entry({ name: "items.ndjson", size: items.length }, items);
  pack.entry({ name: "edges.ndjson", size: 0 }, Buffer.alloc(0));
  pack.finalize();
  await new Promise<void>((resolve) => gzip.on("end", resolve));
  return Buffer.concat(chunks);
}

describe("every item write door holds an event's schedule to one rule", () => {
  it("classifies every door that writes under /items, and no door it does not", () => {
    const doors = itemDoors();
    expect(doors.length).toBeGreaterThan(10);
    expect(doors).toEqual([...WRITING, ...Object.keys(NOT_WRITING)].sort());
  });

  it("names every module that writes an item", () => {
    expect(itemWriters()).toEqual(Object.keys(ITEM_WRITERS).sort());
    for (const [file, why] of Object.entries(ITEM_WRITERS)) {
      if (why.startsWith("asks validateProperties")) {
        expect(
          readFileSync(join(import.meta.dirname, "..", file), "utf8"),
        ).toContain("validateProperties(");
      }
    }
  });

  it.each([
    [
      "a rule that names no date that exists",
      { recurrence: [NEVER] },
      "recurrence",
    ],
    ["a zone that does not resolve", { timezone: "Europe/Berlim" }, "timezone"],
  ])(
    "refuses %s on a create and a natural-key upsert through POST /items",
    async (_label, bad, field) => {
      const source_id = `census-${field}-${Math.random().toString(36).slice(2)}`;
      const create = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: {
          type: "core.event",
          properties: { title: "census", starts_at: START, ...bad },
        },
      });
      expect(create.status).toBe(400);
      const body = (await create.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_properties");
      expect(fieldsOf(body)).toEqual([field]);

      // The witness: the same door takes the same event without it.
      const { id } = await createEvent(
        { title: "census", starts_at: START },
        { source_id },
      );
      const upsert = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: {
          type: "core.event",
          source_id,
          properties: { title: "census", starts_at: START, ...bad },
        },
      });
      expect(upsert.status).toBe(400);
      expect(fieldsOf(await upsert.json())).toEqual([field]);
      expect(Object.keys(await propertiesOf(id))).not.toContain(field);
    },
  );

  it("refuses it on PATCH /items/:id", async () => {
    const { id, version } = await createEvent({
      title: "census patch",
      starts_at: START,
    });
    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.workingKey,
      body: { version, properties: { recurrence: [NEVER] } },
    });
    expect(res.status).toBe(400);
    expect(fieldsOf(await res.json())).toEqual(["recurrence"]);
    expect((await propertiesOf(id)).recurrence).toBeUndefined();
  });

  it("refuses it per entry on POST /items/bulk, creating and updating", async () => {
    const source_id = `census-bulk-${Math.random().toString(36).slice(2)}`;
    const { id } = await createEvent(
      { title: "census bulk", starts_at: START },
      { source_id },
    );
    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        atomic: false,
        items: [
          {
            type: "core.event",
            properties: { title: "new", starts_at: START, recurrence: [NEVER] },
          },
          {
            type: "core.event",
            source_id,
            properties: { title: "census bulk", recurrence: [NEVER] },
          },
          {
            type: "core.event",
            properties: { title: "fine", starts_at: START },
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { outcome: string; error?: { code: string } }[];
    };
    expect(body.results.map((r) => r.outcome)).toEqual([
      "errored",
      "errored",
      "created",
    ]);
    for (const refused of body.results.slice(0, 2)) {
      expect(refused.error?.code).toBe("invalid_properties");
      expect(JSON.stringify(refused.error)).toMatch(/"recurrence"|recurrence:/);
    }
    expect((await propertiesOf(id)).recurrence).toBeUndefined();
  });

  it("refuses it per row on POST /items/bulk-actions update_properties", async () => {
    const marker = `census-ba-${Math.random().toString(36).slice(2, 8)}`;
    const { id } = await createEvent(
      { title: "census bulk action", starts_at: START },
      { tags: [marker] },
    );
    const { initialStatus, result } = await runBulkActionAsync(
      ctx,
      {
        action: "update_properties",
        patch: { recurrence: [NEVER] },
        filter: { tags: [marker] },
      },
      ctx.workingKey,
    );
    expect(initialStatus).toBe(202);
    expect(result?.matched).toBe(1);
    expect(result?.succeeded).toBe(0);
    expect(result?.errors?.[0]?.code).toBe("invalid_properties");
    expect(result?.errors?.[0]?.message).toContain("recurrence");
    expect((await propertiesOf(id)).recurrence).toBeUndefined();
  });

  it("refuses the whole archive on POST /admin/restore-archive", async () => {
    const id = "01912345-0000-7000-8000-00000000ca5e";
    const line = (properties: Record<string, unknown>) => ({
      item: {
        id,
        type: "core.event",
        properties,
        source: "census",
        source_id: id,
      },
      metadata: { item_id: id, tags: [], extensions: {} },
    });
    const restore = async (archive: Buffer) =>
      ctx.app.request("/admin/restore-archive", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.operatorKey}`,
          "Content-Type": "application/gzip",
        },
        body: archive,
      });

    const refused = await restore(
      await archiveOf(
        line({ title: "archived", starts_at: START, recurrence: [NEVER] }),
      ),
    );
    expect(refused.status).toBe(400);
    expect(fieldsOf(await refused.json())).toEqual(["recurrence"]);
    // The witness: the same archive without the rule restores.
    const taken = await restore(
      await archiveOf(line({ title: "archived", starts_at: START })),
    );
    expect(taken.status).toBe(200);
  });

  it("refuses more rule than one series may carry through POST /items/bulk", async () => {
    const lines = Array.from(
      { length: 700 },
      (_, i) =>
        `RRULE:FREQ=DAILY;BYHOUR=${String(i % 24)};BYMINUTE=${String(i % 60)}`,
    );
    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        atomic: false,
        items: [
          {
            type: "core.event",
            properties: {
              title: "many rules",
              starts_at: START,
              recurrence: lines,
            },
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { outcome: string; error?: { code: string } }[];
    };
    expect(body.results[0]?.outcome).toBe("errored");
    expect(body.results[0]?.error?.code).toBe("invalid_properties");
  });
});
