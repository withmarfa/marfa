import { setImmediate } from "node:timers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { itemWrites } from "../storage/item-writes.js";
import { BulkActionWorker } from "../bulk-actions/worker.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx.cleanup();
});

async function seed(count: number) {
  const ids: string[] = [];
  await ctx.storage.runInTransaction(async () => {
    for (let i = 0; i < count; i++) {
      const item = await itemWrites(ctx.storage).create({
        type: "core.note",
        properties: { body: "yieldfixture" },
        source: "yield-fixture",
        source_id: String(i),
      });
      ids.push(item.id);
    }
  });
  return ids;
}

const action = {
  action: "update_tier",
  tier: "feed",
  filter: { source: "yield-fixture" },
};

describe("bulk actions give other requests an event-loop turn", () => {
  it.each(["dry run", "cap refusal", "missing expected ID"])(
    "yields during %s selection with bounded enumeration pages",
    async (kind) => {
      await seed(450);
      let pages = 0;
      const limits: (number | undefined)[] = [];
      let observed: Promise<number> | undefined;
      const list = ctx.storage.items.list.bind(ctx.storage.items);
      vi.spyOn(ctx.storage.items, "list").mockImplementation(
        async (filters) => {
          pages++;
          limits.push(filters.limit);
          const result = await list(filters);
          observed ??= new Promise((resolve) =>
            setImmediate(() => {
              resolve(pages);
            }),
          );
          return result;
        },
      );
      const body =
        kind === "missing expected ID"
          ? {
              action: "purge",
              confirm: "PURGE",
              dry_run: true,
              max_items: 1,
              expected_ids: ["01900000-0000-7000-8000-000000000001"],
              filter: action.filter,
            }
          : {
              ...action,
              max_items: kind === "cap refusal" ? 449 : 450,
              dry_run: kind === "dry run",
            };
      const response = await request(ctx.app, "POST", "/items/bulk-actions", {
        key: ctx.workingKey,
        body,
      });
      expect(response.status).toBe(kind === "cap refusal" ? 400 : 200);
      const result = (await response.json()) as {
        matched?: number;
        ids?: string[];
        error?: { details?: { matched: number; cap: number } };
      };
      expect(pages).toBe(3);
      expect(await observed).toBe(1);
      expect(limits[0]).toBe(200);
      if (kind === "missing expected ID") expect(result.matched).toBe(0);
      if (kind === "dry run") expect(result.ids).toHaveLength(450);
      if (kind === "cap refusal")
        expect(result.error?.details).toEqual({ matched: 450, cap: 449 });
    },
  );

  it.each(
    [
      "revoke",
      "read narrowing",
      "write narrowing",
      "source override",
      "instance source filter",
    ].flatMap((change) => [true, false].map((dryRun) => ({ change, dryRun }))),
  )(
    "does not disclose or queue a stale selection after $change (dry_run=$dryRun)",
    async ({ change, dryRun }) => {
      const ids = await seed(450);
      const minted = await request(ctx.app, "POST", "/keys", {
        key: ctx.workingKey,
        body: {
          label: "yield authority",
          source: "yield-fixture",
          default_tier: "feed",
          type_permissions: { "core.note": "write", "core.bookmark": "write" },
          extension_permissions: {},
          edge_permissions: {},
        },
      });
      expect(minted.status).toBe(201);
      const credential = (await minted.json()) as { id: string; key: string };
      // The unchanged credential can enumerate these rows before authority changes.
      const witness = await request(ctx.app, "POST", "/items/bulk-actions", {
        key: credential.key,
        body: { ...action, dry_run: true },
      });
      expect(witness.status).toBe(200);
      expect(((await witness.json()) as { ids: string[] }).ids).toHaveLength(
        450,
      );

      let withdrawal: Promise<void> | undefined;
      const list = ctx.storage.items.list.bind(ctx.storage.items);
      vi.spyOn(ctx.storage.items, "list").mockImplementation(
        async (filters) => {
          const result = await list(filters);
          withdrawal ??= new Promise((resolve, reject) =>
            setImmediate(() => {
              void (async () => {
                if (change === "instance source filter") {
                  await ctx.storage.settings.set(
                    "instance_config",
                    JSON.stringify({
                      enforcement: {
                        source_filter: {
                          types: ["core.note"],
                          sources: ["other-source"],
                        },
                      },
                    }),
                  );
                } else {
                  const body =
                    change === "read narrowing"
                      ? { type_permissions: { "core.bookmark": "write" } }
                      : change === "write narrowing"
                        ? {
                            type_permissions: {
                              "core.note": "read",
                              "core.bookmark": "write",
                            },
                          }
                        : {
                            enforcement_override: {
                              source_filter: {
                                types: ["core.note"],
                                sources: ["other-source"],
                              },
                            },
                          };
                  const response = await request(
                    ctx.app,
                    change === "revoke" ? "DELETE" : "PATCH",
                    `/keys/${credential.id}`,
                    {
                      key: ctx.workingKey,
                      ...(change === "revoke" ? {} : { body }),
                    },
                  );
                  expect(response.status).toBe(200);
                }
              })().then(resolve, reject);
            }),
          );
          return result;
        },
      );
      const response = await request(ctx.app, "POST", "/items/bulk-actions", {
        key: credential.key,
        body: { ...action, dry_run: dryRun },
      });
      await withdrawal;
      expect(response.status).toBe(
        change === "revoke" ? 401 : change === "read narrowing" ? 404 : 403,
      );
      const result = await response.text();
      for (const id of ids) expect(result).not.toContain(id);
      expect(result).not.toContain('"matched"');
      expect(result).not.toContain('"ids"');
      const queued = await (
        ctx.storage as unknown as {
          __sqliteAll(sql: string): Promise<unknown[]>;
        }
      ).__sqliteAll("SELECT id FROM bulk_action_jobs");
      expect(queued).toEqual([]);
    },
  );

  it("lets cancellation run after committed chunk progress and before the next chunk", async () => {
    const ids = await seed(3);
    const response = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: ctx.workingKey,
      body: action,
    });
    expect(response.status).toBe(202);
    const job = (await response.json()) as { id: string };
    let cancellation: Promise<void> | undefined;
    let observed: { status: string; processed: number } | undefined;
    const progress = ctx.storage.bulkActionJobs.updateProgress.bind(
      ctx.storage.bulkActionJobs,
    );
    vi.spyOn(ctx.storage.bulkActionJobs, "updateProgress").mockImplementation(
      async (...args) => {
        await progress(...args);
        cancellation ??= new Promise((resolve, reject) =>
          setImmediate(() => {
            void (async () => {
              const row = await ctx.storage.bulkActionJobs.getById(job.id);
              observed = {
                status: row!.status,
                processed: row!.processed_count,
              };
              const canceled = await request(
                ctx.app,
                "DELETE",
                `/items/bulk-actions/jobs/${job.id}`,
                { key: ctx.workingKey },
              );
              expect(canceled.status).toBe(200);
            })().then(resolve, reject);
          }),
        );
      },
    );
    const worker = new BulkActionWorker({ storage: ctx.storage, chunkSize: 1 });
    expect(await worker.runOnce()).toBe(true);
    await cancellation;
    expect(observed).toEqual({ status: "in_progress", processed: 1 });
    const row = await ctx.storage.bulkActionJobs.getById(job.id);
    expect(row?.status).toBe("canceled");
    expect(row?.processed_count).toBe(1);
    const rows = await ctx.storage.items.getMany(ids);
    expect(
      [...rows.values()].filter((item) => item.tier === "feed"),
    ).toHaveLength(1);
  });

  it("hides a selected row retyped outside the credential's reach during a selection yield", async () => {
    await seed(450);
    const minted = await request(ctx.app, "POST", "/keys", {
      key: ctx.workingKey,
      body: {
        label: "current row authority",
        source: "yield-fixture",
        type_permissions: { "core.note": "write" },
      },
    });
    expect(minted.status).toBe(201);
    const credential = (await minted.json()) as { key: string };
    let changed: Promise<void> | undefined;
    let selectedId: string | undefined;
    const list = ctx.storage.items.list.bind(ctx.storage.items);
    vi.spyOn(ctx.storage.items, "list").mockImplementation(async (filters) => {
      const page = await list(filters);
      changed ??= new Promise((resolve, reject) =>
        setImmediate(() => {
          void (async () => {
            const selected = page.data[0]!;
            selectedId = selected.id;
            await itemWrites(ctx.storage).update(selected.id, {
              type: "core.bookmark",
              properties: { url: "https://example.com/retyped" },
              version: selected.version,
              may_read_type: () => true,
            });
            expect((await ctx.storage.items.get(selected.id))?.type).toBe(
              "core.bookmark",
            );
          })().then(resolve, reject);
        }),
      );
      return page;
    });
    const response = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: credential.key,
      body: { ...action, dry_run: true },
    });
    await changed;
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(selectedId).toBeDefined();
    expect(body).not.toContain(selectedId!);
    expect(body).not.toContain("core.bookmark");
    expect(body).not.toContain('"matched"');
  });

  it("stops for a credential revoked during the committed chunk yield", async () => {
    const ids = await seed(3);
    const minted = await request(ctx.app, "POST", "/keys", {
      key: ctx.workingKey,
      body: {
        label: "chunk authority",
        source: "yield-fixture",
        type_permissions: { "core.note": "write" },
      },
    });
    expect(minted.status).toBe(201);
    const credential = (await minted.json()) as { id: string; key: string };
    const response = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: credential.key,
      body: action,
    });
    expect(response.status).toBe(202);
    const job = (await response.json()) as { id: string };
    let withdrawn: Promise<void> | undefined;
    const progress = ctx.storage.bulkActionJobs.updateProgress.bind(
      ctx.storage.bulkActionJobs,
    );
    vi.spyOn(ctx.storage.bulkActionJobs, "updateProgress").mockImplementation(
      async (...args) => {
        await progress(...args);
        withdrawn ??= new Promise((resolve, reject) =>
          setImmediate(() => {
            void request(ctx.app, "DELETE", `/keys/${credential.id}`, {
              key: ctx.workingKey,
            })
              .then((revoked) => {
                expect(revoked.status).toBe(200);
              })
              .then(resolve, reject);
          }),
        );
      },
    );
    const worker = new BulkActionWorker({ storage: ctx.storage, chunkSize: 1 });
    expect(await worker.runOnce()).toBe(true);
    await withdrawn;
    const row = await ctx.storage.bulkActionJobs.getById(job.id);
    expect(row?.status).toBe("failed");
    expect(row?.processed_count).toBe(1);
    expect(row?.succeeded_count).toBe(1);
    const rows = await ctx.storage.items.getMany(ids);
    expect(
      [...rows.values()].filter((item) => item.tier === "feed"),
    ).toHaveLength(1);
  });

  it("keeps the queued selection frozen when a later chunk yield admits another match", async () => {
    const ids = await seed(3);
    const response = await request(ctx.app, "POST", "/items/bulk-actions", {
      key: ctx.workingKey,
      body: action,
    });
    expect(response.status).toBe(202);
    const job = (await response.json()) as { id: string };
    let inserted: Promise<string> | undefined;
    const progress = ctx.storage.bulkActionJobs.updateProgress.bind(
      ctx.storage.bulkActionJobs,
    );
    vi.spyOn(ctx.storage.bulkActionJobs, "updateProgress").mockImplementation(
      async (...args) => {
        await progress(...args);
        inserted ??= new Promise((resolve, reject) =>
          setImmediate(() => {
            void itemWrites(ctx.storage)
              .create({
                type: "core.note",
                properties: { body: "latermatch" },
                source: "yield-fixture",
                source_id: "later",
              })
              .then((item) => {
                resolve(item.id);
              }, reject);
          }),
        );
      },
    );
    const worker = new BulkActionWorker({ storage: ctx.storage, chunkSize: 1 });
    expect(await worker.runOnce()).toBe(true);
    const later = await inserted;
    expect(later).toBeDefined();
    const row = await ctx.storage.bulkActionJobs.getById(job.id);
    expect(row?.status).toBe("completed");
    expect(row?.processed_count).toBe(3);
    expect(row?.succeeded_count).toBe(3);
    expect(JSON.parse(row!.matched_ids) as string[]).toEqual(
      expect.arrayContaining(ids),
    );
    expect((await ctx.storage.items.get(later!))?.tier).toBe("library");
  });
});
