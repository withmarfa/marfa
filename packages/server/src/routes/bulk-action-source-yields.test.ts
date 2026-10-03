import { setImmediate } from "node:timers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { itemWrites } from "../storage/item-writes.js";
import { writeInstanceConfig } from "../storage/instance-config.js";
import { BulkActionWorker } from "../bulk-actions/worker.js";
import type { SourceFilterSettings } from "../storage/filter-sql.js";
import type { Item } from "@withmarfa/shared";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await ctx.cleanup();
});

async function seed(count: number) {
  await ctx.storage.runInTransaction(async () => {
    for (let i = 0; i < count; i++)
      await itemWrites(ctx.storage).create({
        type: "core.note",
        properties: { body: "sourceyieldfixture" },
        source: "yield-fixture",
        source_id: String(i),
      });
  });
}

async function credential(mode: string, filter: SourceFilterSettings) {
  await writeInstanceConfig(ctx.storage.settings, {
    enforcement: {
      source_filter:
        mode === "instance"
          ? filter
          : { types: ["*"], sources: ["unrelated-source"] },
    },
  });
  const response = await request(ctx.app, "POST", "/keys", {
    key: ctx.workingKey,
    body: {
      label: "source visibility",
      source: "yield-fixture",
      type_permissions: { "core.note": "write", "core.bookmark": "write" },
      ...(mode === "credential"
        ? { enforcement_override: { source_filter: filter } }
        : {}),
    },
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; key: string };
}

async function changeRow(row: Item, change: string) {
  if (change.startsWith("retype")) {
    const response = await request(ctx.app, "PATCH", `/items/${row.id}`, {
      key: ctx.workingKey,
      body: {
        type: "core.bookmark",
        retype: true,
        properties: { url: "https://example.com/retyped" },
        version: row.version,
      },
    });
    expect(response.status).toBe(200);
  } else if (change === "source hidden") {
    // Public writes keep provenance immutable; this seam exercises the current source column.
    await (
      ctx.storage as unknown as {
        __sqliteRun(sql: string, params: unknown[]): Promise<void>;
      }
    ).__sqliteRun("UPDATE items SET source = ? WHERE id = ?", [
      "other-source",
      row.id,
    ]);
  } else if (change === "properties") {
    const response = await request(ctx.app, "PATCH", `/items/${row.id}`, {
      key: ctx.workingKey,
      body: { properties: { body: "differentproperty" }, version: row.version },
    });
    expect(response.status).toBe(200);
  }
}

const action = {
  action: "update_tier",
  tier: "feed",
  filter: { source: "yield-fixture" },
};

describe("bulk actions retain current source visibility across yields", () => {
  it.each(
    ["instance", "credential"].flatMap((mode) =>
      [
        "retype hidden",
        "source hidden",
        "retype approved",
        "properties",
        "unchanged",
      ].flatMap((change) =>
        [true, false].map((dryRun) => ({ mode, change, dryRun })),
      ),
    ),
  )(
    "checks current row source visibility after $change under $mode filtering (dry_run=$dryRun)",
    async ({ mode, change, dryRun }) => {
      await seed(201);
      const sourceFilter = {
        types: [change.startsWith("retype") ? "core.bookmark" : "core.note"],
        sources: [
          change === "retype hidden" ? "approved-source" : "yield-fixture",
        ],
      };
      const key = await credential(mode, sourceFilter);
      const selectedAction = {
        ...action,
        filter: {
          ...action.filter,
          ...(change === "properties"
            ? { filter: 'properties.body eq "sourceyieldfixture"' }
            : {}),
        },
      };
      const witness = await request(ctx.app, "POST", "/items/bulk-actions", {
        key: key.key,
        body: { ...selectedAction, dry_run: true },
      });
      expect(witness.status).toBe(200);
      expect(((await witness.json()) as { ids: string[] }).ids).toHaveLength(
        201,
      );

      let changed: Promise<void> | undefined;
      let selectedId = "";
      const list = ctx.storage.items.list.bind(ctx.storage.items);
      vi.spyOn(ctx.storage.items, "list").mockImplementation(
        async (filters) => {
          const page = await list(filters);
          changed ??= new Promise((resolve, reject) =>
            setImmediate(() => {
              selectedId = page.data[0]!.id;
              void changeRow(page.data[0]!, change).then(resolve, reject);
            }),
          );
          return page;
        },
      );
      const response = await request(ctx.app, "POST", "/items/bulk-actions", {
        key: key.key,
        body: { ...selectedAction, dry_run: dryRun },
      });
      await changed;
      vi.restoreAllMocks();
      const current =
        (await ctx.storage.items.getIncludingTrashed(selectedId))!;
      const listing = await request(
        ctx.app,
        "GET",
        `/items?type=${current.type}&source=${current.source}&limit=200`,
        { key: key.key },
      );
      expect(listing.status).toBe(200);
      const visibleIds = ((await listing.json()) as { data: Item[] }).data.map(
        (row) => row.id,
      );
      const hidden = change.endsWith("hidden");
      if (hidden) {
        expect(visibleIds).not.toContain(selectedId);
        expect(response.status).toBe(403);
        const body = await response.text();
        expect(body).not.toContain(selectedId);
        expect(body).not.toContain('"matched"');
        expect(body).not.toContain('"ids"');
        const jobs = await (
          ctx.storage as unknown as {
            __sqliteAll(sql: string): Promise<unknown[]>;
          }
        ).__sqliteAll("SELECT id FROM bulk_action_jobs");
        expect(jobs).toEqual([]);
        const worker = new BulkActionWorker({ storage: ctx.storage });
        expect(await worker.runOnce()).toBe(false);
        expect((await ctx.storage.items.get(selectedId))?.tier).toBe("library");
      } else {
        expect(visibleIds).toContain(selectedId);
        expect(response.status).toBe(dryRun ? 200 : 202);
        const body = (await response.json()) as {
          id?: string;
          ids?: string[];
          matched: number;
        };
        expect(body.matched).toBe(201);
        if (dryRun) expect(body.ids).toContain(selectedId);
        else {
          const job = (await ctx.storage.bulkActionJobs.getById(body.id!))!;
          expect(JSON.parse(job.matched_ids) as string[]).toContain(selectedId);
          const worker = new BulkActionWorker({ storage: ctx.storage });
          expect(await worker.runOnce()).toBe(true);
          expect((await ctx.storage.items.get(selectedId))?.tier).toBe("feed");
        }
        if (change === "properties") {
          const originalQuery = await request(
            ctx.app,
            "GET",
            "/items?filter=properties.body%20eq%20%22sourceyieldfixture%22&limit=200",
            { key: key.key },
          );
          expect(originalQuery.status).toBe(200);
          expect(
            ((await originalQuery.json()) as { data: Item[] }).data.map(
              (row) => row.id,
            ),
          ).not.toContain(selectedId);
        }
      }
    },
  );

  it.each(
    ["instance", "credential"].flatMap((mode) =>
      [
        "retype hidden",
        "source hidden",
        "retype approved",
        "lever narrowing",
      ].map((change) => ({ mode, change })),
    ),
  )(
    "checks current source visibility after a committed chunk yield under $mode filtering ($change)",
    async ({ mode, change }) => {
      await seed(3);
      const key = await credential(mode, {
        types: [change.startsWith("retype") ? "core.bookmark" : "core.note"],
        sources: [
          change === "retype hidden" ? "approved-source" : "yield-fixture",
        ],
      });
      const response = await request(ctx.app, "POST", "/items/bulk-actions", {
        key: key.key,
        body: action,
      });
      expect(response.status).toBe(202);
      const envelope = (await response.json()) as { id: string };
      const queued = (await ctx.storage.bulkActionJobs.getById(envelope.id))!;
      const ids = JSON.parse(queued.matched_ids) as string[];
      const target = (await ctx.storage.items.get(ids[1]!))!;
      let changed: Promise<void> | undefined;
      const progress = ctx.storage.bulkActionJobs.updateProgress.bind(
        ctx.storage.bulkActionJobs,
      );
      vi.spyOn(ctx.storage.bulkActionJobs, "updateProgress").mockImplementation(
        async (...args) => {
          await progress(...args);
          changed ??= new Promise((resolve, reject) =>
            setImmediate(() => {
              void (async () => {
                if (change === "lever narrowing") {
                  const filter = {
                    types: ["core.note"],
                    sources: ["other-source"],
                  };
                  if (mode === "instance")
                    await writeInstanceConfig(ctx.storage.settings, {
                      enforcement: { source_filter: filter },
                    });
                  else {
                    const narrowed = await request(
                      ctx.app,
                      "PATCH",
                      `/keys/${key.id}`,
                      {
                        key: ctx.workingKey,
                        body: {
                          enforcement_override: { source_filter: filter },
                        },
                      },
                    );
                    expect(narrowed.status).toBe(200);
                  }
                } else await changeRow(target, change);
              })().then(resolve, reject);
            }),
          );
        },
      );
      const worker = new BulkActionWorker({
        storage: ctx.storage,
        chunkSize: 1,
      });
      expect(await worker.runOnce()).toBe(true);
      await changed;
      const job = (await ctx.storage.bulkActionJobs.getById(envelope.id))!;
      const hidden = change !== "retype approved";
      expect(job.status).toBe("completed");
      expect(job.processed_count).toBe(3);
      expect(job.succeeded_count).toBe(
        change === "lever narrowing" ? 1 : hidden ? 2 : 3,
      );
      expect(job.errored_count).toBe(
        change === "lever narrowing" ? 2 : hidden ? 1 : 0,
      );
      expect((await ctx.storage.items.get(target.id))?.tier).toBe(
        hidden ? "library" : "feed",
      );
      if (hidden) {
        const result = JSON.parse(job.result!) as {
          errors: { id: string; code: string; message: string }[];
        };
        expect(result.errors.find((error) => error.id === target.id)).toEqual({
          id: target.id,
          code: "item_not_found",
          message: "Item not found",
        });
        expect(job.result).not.toContain("core.bookmark");
      }
    },
  );
});

it.each(["selection", "worker"])(
  "does not treat a failed current-source lookup as an empty result (%s)",
  async (door) => {
    await seed(3);
    const key = await credential("instance", {
      types: ["core.note"],
      sources: ["yield-fixture"],
    });
    let jobId: string | undefined;
    if (door === "worker") {
      const response = await request(ctx.app, "POST", "/items/bulk-actions", {
        key: key.key,
        body: action,
      });
      expect(response.status).toBe(202);
      jobId = ((await response.json()) as { id: string }).id;
    }
    const getMany = ctx.storage.items.getMany.bind(ctx.storage.items);
    vi.spyOn(ctx.storage.items, "getMany").mockImplementation(
      async (ids, opts) => {
        if (opts && "source_filter" in opts)
          throw new Error("source policy lookup failed");
        return getMany(ids, opts);
      },
    );
    if (door === "selection") {
      const response = await request(ctx.app, "POST", "/items/bulk-actions", {
        key: key.key,
        body: { ...action, dry_run: true },
      });
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('"matched"');
    } else {
      const worker = new BulkActionWorker({ storage: ctx.storage });
      expect(await worker.runOnce()).toBe(true);
      const job = (await ctx.storage.bulkActionJobs.getById(jobId!))!;
      expect(job.succeeded_count).toBe(0);
      expect(job.errored_count).toBe(3);
      expect(job.result).toContain("internal_error");
    }
    const rows = await ctx.storage.items.list({ all_states: true });
    expect(rows.data).toHaveLength(3);
    expect(rows.data.every((row) => row.tier === "library")).toBe(true);
  },
);

it.each([true, false])(
  "keeps a now-absent row in the frozen selection rather than treating it as source-hidden (dry_run=%s)",
  async (dryRun) => {
    await seed(201);
    const key = await credential("instance", {
      types: ["core.note"],
      sources: ["yield-fixture"],
    });
    let removed: Promise<void> | undefined;
    let selectedId = "";
    const list = ctx.storage.items.list.bind(ctx.storage.items);
    vi.spyOn(ctx.storage.items, "list").mockImplementation(async (filters) => {
      const page = await list(filters);
      removed ??= new Promise((resolve, reject) =>
        setImmediate(() => {
          selectedId = page.data[0]!.id;
          void ctx.storage
            .runInTransaction(async () => {
              await itemWrites(ctx.storage).delete(selectedId);
              await itemWrites(ctx.storage).purge(selectedId);
            })
            .then(resolve, reject);
        }),
      );
      return page;
    });
    const response = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: key.key,
      body: { ...action, dry_run: dryRun },
    });
    await removed;
    expect(await ctx.storage.items.getIncludingTrashed(selectedId)).toBeNull();
    expect(response.status).toBe(dryRun ? 200 : 202);
    const body = (await response.json()) as {
      id?: string;
      ids?: string[];
      matched: number;
    };
    expect(body.matched).toBe(201);
    if (dryRun) expect(body.ids).toContain(selectedId);
    else {
      const queued = (await ctx.storage.bulkActionJobs.getById(body.id!))!;
      expect(JSON.parse(queued.matched_ids) as string[]).toContain(selectedId);
      const worker = new BulkActionWorker({ storage: ctx.storage });
      expect(await worker.runOnce()).toBe(true);
      const job = (await ctx.storage.bulkActionJobs.getById(body.id!))!;
      expect(job.succeeded_count).toBe(200);
      expect(job.errored_count).toBe(1);
    }
  },
);
