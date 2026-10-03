import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestContext, request, type TestContext } from "../test-utils.js";
import { BulkActionWorker } from "./worker.js";
import { sqliteRequestContext } from "../storage/sqlite/request-context.js";
import { writeInstanceConfig } from "../storage/instance-config.js";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
  initEventLog(ctx.storage.eventLog);
});
afterEach(async () => {
  vi.restoreAllMocks();
  __resetEventLogForTests();
  await ctx.cleanup();
});
function gate() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const changes = [
  "unchanged",
  "allowed override",
  "write narrowing",
  "read narrowing",
  "source override narrowing",
  "instance source narrowing",
  "revoked",
] as const;
describe("a bulk chunk asks authority after its pending writer turn", () => {
  it.each(changes)(
    "observes %s committed by the preceding writer",
    async (change) => {
      const minted = await request(ctx.app, "POST", "/keys", {
        key: ctx.workingKey,
        body: {
          label: "chunk authority",
          source: "chunk-source",
          type_permissions: { "core.note": "write" },
        },
      });
      expect(minted.status).toBe(201);
      const credential = (await minted.json()) as { id: string; key: string };
      const created = await request(ctx.app, "POST", "/items", {
        key: credential.key,
        body: { type: "core.note", properties: { body: "before" } },
      });
      expect(created.status).toBe(201);
      const id = ((await created.json()) as { item: { id: string } }).item.id;
      const queued = await request(ctx.app, "POST", "/items/bulk-actions", {
        key: credential.key,
        body: {
          action: "update_tier",
          tier: "feed",
          filter: { source: "chunk-source" },
        },
      });
      expect(queued.status).toBe(202);
      const job = (await queued.json()) as { id: string };
      const before = await ctx.storage.items.get(id);
      const cursor = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
      const held = gate(),
        release = gate(),
        chunkWaiting = gate();
      const transaction = ctx.storage.runInTransaction.bind(ctx.storage);
      let roots = 0;
      vi.spyOn(ctx.storage, "runInTransaction").mockImplementation(
        async (fn, options) => {
          if (!sqliteRequestContext.getStore() && ++roots === 2)
            chunkWaiting.resolve();
          return transaction(fn, options);
        },
      );
      const claim = ctx.storage.bulkActionJobs.claimNext.bind(
        ctx.storage.bulkActionJobs,
      );
      let preceding: Promise<void> | undefined;
      vi.spyOn(ctx.storage.bulkActionJobs, "claimNext").mockImplementation(
        async (...args) => {
          const row = await claim(...args);
          preceding = ctx.storage.runInTransaction(async () => {
            held.resolve();
            await release.promise;
            if (change === "revoked")
              expect(
                (
                  await request(ctx.app, "DELETE", `/keys/${credential.id}`, {
                    key: ctx.workingKey,
                  })
                ).status,
              ).toBe(200);
            else if (change === "instance source narrowing")
              await writeInstanceConfig(ctx.storage.settings, {
                enforcement: {
                  source_filter: {
                    types: ["core.note"],
                    sources: ["other-source"],
                  },
                },
              });
            else if (change !== "unchanged") {
              const patch =
                change === "write narrowing"
                  ? { type_permissions: { "core.note": "read" } }
                  : change === "read narrowing"
                    ? { type_permissions: {} }
                    : {
                        enforcement_override: {
                          source_filter: {
                            types: ["core.note"],
                            sources: [
                              change === "allowed override"
                                ? "chunk-source"
                                : "other-source",
                            ],
                          },
                        },
                      };
              expect(
                (
                  await request(ctx.app, "PATCH", `/keys/${credential.id}`, {
                    key: ctx.workingKey,
                    body: patch,
                  })
                ).status,
              ).toBe(200);
            }
          });
          await held.promise;
          return row;
        },
      );
      const run = new BulkActionWorker({
        storage: ctx.storage,
        chunkSize: 1,
      }).runOnce();
      try {
        await chunkWaiting.promise;
        release.resolve();
        await preceding;
        expect(await run).toBe(true);
      } finally {
        release.resolve();
        await preceding;
      }
      const done = await ctx.storage.bulkActionJobs.getById(job.id);
      const positive = change === "unchanged" || change === "allowed override";
      expect(done).toMatchObject({
        status: change === "revoked" ? "failed" : "completed",
        succeeded_count: positive ? 1 : 0,
        processed_count: change === "revoked" ? 0 : 1,
      });
      if (!positive && change !== "revoked")
        expect(JSON.parse(done!.result!)).toMatchObject({
          errors: [
            {
              id,
              code:
                change === "write narrowing"
                  ? "type_not_permitted"
                  : "item_not_found",
            },
          ],
        });
      expect((await ctx.storage.items.get(id))?.tier).toBe(
        positive ? "feed" : before?.tier,
      );
      expect((await ctx.storage.items.get(id))?.version).toBe(
        before!.version + (positive ? 1 : 0),
      );
      expect(await ctx.storage.eventLog.getAfter(cursor, 20)).toHaveLength(
        positive ? 1 : 0,
      );
    },
  );
});
