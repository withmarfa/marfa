import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  causeMessages,
  createTestContext,
  request,
  type TestContext,
} from "../test-utils.js";
import {
  resolveLiveCredential,
  type LiveCredential,
} from "../auth/live-credential.js";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";
import { runChunk } from "./runner.js";
import type { BulkActionInput } from "./types.js";

let ctx: TestContext;
let credential: LiveCredential;
beforeEach(async () => {
  ctx = await createTestContext();
  const current = await request(ctx.app, "GET", "/keys/current", {
    key: ctx.workingKey,
  });
  const resolved = await resolveLiveCredential(
    ctx.storage,
    ((await current.json()) as { id: string }).id,
    { tokenOutlivesExpiry: true },
  );
  if (!resolved) throw new Error("fixture credential did not resolve");
  credential = resolved;
  initEventLog(ctx.storage.eventLog);
});
afterEach(async () => {
  vi.restoreAllMocks();
  __resetEventLogForTests();
  await ctx.cleanup();
});

const actions: BulkActionInput[] = [
  { action: "transition", state: "archived" },
  { action: "purge", confirm: "PURGE" },
  { action: "update_tags", add: ["changed"] },
  { action: "update_tier", tier: "feed" },
  { action: "update_properties", patch: { body: "changed" } },
  {
    action: "update_occurred_at",
    occurred_at: new Date(Date.now() - 1000).toISOString(),
  },
];

async function fixture(input: BulkActionInput, refusal: "ABORT" | "ROLLBACK") {
  const ids: string[] = [];
  for (const body of ["before", "refused", "after"]) {
    const response = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body } },
    });
    expect(response.status).toBe(201);
    const id = ((await response.json()) as { item: { id: string } }).item.id;
    ids.push(id);
    if (input.action === "purge")
      expect(
        (
          await request(ctx.app, "DELETE", `/items/${id}`, {
            key: ctx.workingKey,
          })
        ).status,
      ).toBe(200);
  }
  const tags = input.action === "update_tags";
  const operation = input.action === "purge" ? "DELETE" : "UPDATE";
  await (
    ctx.storage as unknown as {
      __sqliteRun(sql: string, args: unknown[]): Promise<unknown>;
    }
  ).__sqliteRun(
    `CREATE TRIGGER row_refusal BEFORE ${operation} ON ${tags ? "metadata" : "items"} WHEN OLD.${tags ? "item_id" : "id"} = '${ids[1]!}' BEGIN SELECT RAISE(${refusal}, 'original native refusal'); END`,
    [],
  );
  const before = await Promise.all(
    ids.map((id) => ctx.storage.items.getIncludingTrashed(id)),
  );
  const start = (await ctx.storage.eventLog.getMaxId()) ?? 0n;
  return { ids, before, start };
}

describe("every bulk runner arm distinguishes row refusal from transaction loss", () => {
  it.each(actions)("continues after ABORT for $action", async (input) => {
    const { ids, before, start } = await fixture(input, "ABORT");
    const outcome = await runChunk({
      storage: ctx.storage,
      credential,
      ids,
      input,
    });
    expect(outcome.succeeded).toEqual([ids[0], ids[2]]);
    expect(outcome.errors.map((entry) => entry.id)).toEqual([ids[1]]);
    expect(outcome.errors[0]!.message).toBe(
      "Database operation failed (SQLITE_CONSTRAINT_TRIGGER)",
    );
    expect(await ctx.storage.items.getIncludingTrashed(ids[1]!)).toEqual(
      before[1],
    );
    const events = await ctx.storage.eventLog.getAfter(start, 20);
    expect(events.map((event) => event.item_id)).toEqual([ids[0], ids[2]]);
  });
  it.each(actions)(
    "stops after ROLLBACK for $action with its original cause",
    async (input) => {
      const { ids, before, start } = await fixture(input, "ROLLBACK");
      const read = vi.spyOn(ctx.storage.items, "getIncludingTrashed");
      let thrown: unknown;
      try {
        await runChunk({ storage: ctx.storage, credential, ids, input });
      } catch (error) {
        thrown = error;
      }
      expect(causeMessages(thrown).join("\n")).toContain(
        "original native refusal",
      );
      expect(read.mock.calls.map(([id]) => id)).toContain(ids[1]);
      expect(read.mock.calls.map(([id]) => id)).not.toContain(ids[2]);
      expect(
        await Promise.all(
          ids.map((id) => ctx.storage.items.getIncludingTrashed(id)),
        ),
      ).toEqual(before);
      expect(await ctx.storage.eventLog.getAfter(start, 20)).toEqual([]);
    },
  );
});
