/**
 * The preconditions a purge may carry (`items.md` 28 and 33): the version
 * the caller read on `POST /items/{id}/purge`, and the ids a dry run
 * returned on a bulk purge. A purge cannot be undone, so a change made after
 * the person confirmed is refused or left alone, never destroyed unseen.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type {
  TestContext,
  BulkActionInput,
  BulkActionJob,
  BulkActionResponse,
} from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext(
    "compliance",
    "purge-preconditions",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function trashedNote(tag: string): Promise<string> {
  const r = await client.createItem(
    createNote({ source: ctx.source, tags: [tag] }),
  );
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  expect((await client.deleteItem(r.data.item.id)).ok).toBe(true);
  return r.data.item.id;
}

async function trashedIds(tag: string): Promise<string[]> {
  const list = await client.listItems({ state: "trashed", tags: [tag] });
  expect(list.ok).toBe(true);
  return list.data.data.map((item) => item.id);
}

async function runToCompletion(
  input: BulkActionInput,
): Promise<BulkActionResponse> {
  const res = await client.bulkAction(input);
  expect(res.status, JSON.stringify(res.error)).toBe(202);
  const final = await client.pollBulkActionToTerminal(
    (res.data as BulkActionJob).id,
  );
  expect(final.status).toBe("completed");
  return final.result!;
}

describe("POST /items/{id}/purge with version", () => {
  it("refuses a stale version with version_conflict, and the row survives", async () => {
    const tag = `purge-stale-${ctx.runId}`;
    const r = await client.createItem(
      createNote({ source: ctx.source, tags: [tag] }),
    );
    expect(r.ok).toBe(true);
    const id = r.data.item.id;
    trackItem(ctx, id);
    const moved = await client.updateItem(id, {
      properties: { title: "changed after it was read" },
      version: 1,
    });
    expect(moved.data.item.version).toBe(2);
    expect((await client.deleteItem(id)).ok).toBe(true);

    const stale = await client.purgeItem(id, { version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.error?.error.code).toBe("version_conflict");
    await expectMatchesSchema("POST", "/items/{id}/purge", 409, stale.error);
    const body = stale.error as unknown as {
      error: { status: number };
      current: { id: string; version: number };
    };
    expect(body.error.status).toBe(409);
    expect(body.current).toMatchObject({ id, version: 2 });
    expect(await trashedIds(tag)).toEqual([id]);

    const current = await client.purgeItem(id, { version: 2 });
    expect(current.status).toBe(200);
    expect(await trashedIds(tag)).toEqual([]);
  });

  it("purges at the version read before the trash, which trashing does not move", async () => {
    const tag = `purge-trash-version-${ctx.runId}`;
    const id = await trashedNote(tag);
    const listed = await client.listItems({ state: "trashed", tags: [tag] });
    expect(listed.data.data[0]?.version).toBe(1);

    const purged = await client.purgeItem(id, { version: 1 });
    expect(purged.status).toBe(200);
    expect(await trashedIds(tag)).toEqual([]);
  });
});

describe("POST /items/bulk-actions purge with expected_ids", () => {
  it("does not purge a row trashed after the dry run", async () => {
    const tag = `purge-expected-${ctx.runId}`;
    const seen = [await trashedNote(tag), await trashedNote(tag)];
    const filter = { tags: [tag], state: "trashed" as const };

    const dry = await client.bulkAction({
      action: "purge",
      confirm: "PURGE",
      filter,
      dry_run: true,
    });
    const dryIds = (dry.data as BulkActionResponse).ids ?? [];
    expect(dryIds.slice().sort()).toEqual(seen.slice().sort());

    const late = await trashedNote(tag);
    // The witness: the filter now reaches the late row.
    expect(await trashedIds(tag)).toContain(late);

    const result = await runToCompletion({
      action: "purge",
      confirm: "PURGE",
      filter,
      expected_ids: dryIds,
    });
    expect(result.matched).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(await trashedIds(tag)).toEqual([late]);
  });

  it("does not purge a listed id the filter no longer matches", async () => {
    const tag = `purge-expected-unmatched-${ctx.runId}`;
    const inside = await trashedNote(tag);
    const otherTag = `purge-expected-elsewhere-${ctx.runId}`;
    const outside = await trashedNote(otherTag);

    const dry = await client.bulkAction({
      action: "purge",
      confirm: "PURGE",
      filter: { tags: [tag], state: "trashed" },
      expected_ids: [inside, outside],
      dry_run: true,
    });
    expect(dry.status).toBe(200);
    expect((dry.data as BulkActionResponse).ids).toEqual([inside]);

    const result = await runToCompletion({
      action: "purge",
      confirm: "PURGE",
      filter: { tags: [tag], state: "trashed" },
      expected_ids: [inside, outside],
    });
    expect(result.matched).toBe(1);
    expect(await trashedIds(tag)).toEqual([]);
    expect(await trashedIds(otherTag)).toEqual([outside]);
  });

  it("refuses an empty expected_ids, and purges nothing", async () => {
    const tag = `purge-expected-empty-${ctx.runId}`;
    const id = await trashedNote(tag);
    const res = await client.bulkAction({
      action: "purge",
      confirm: "PURGE",
      filter: { tags: [tag], state: "trashed" },
      expected_ids: [],
    });
    expect(res.status).toBe(400);
    expect(res.error?.error.code).toBe("validation_error");
    expect(await trashedIds(tag)).toEqual([id]);
  });

  it("caps the rows the purge takes, not the filter's whole match", async () => {
    const tag = `purge-expected-cap-${ctx.runId}`;
    const listed = await trashedNote(tag);
    const others = [await trashedNote(tag), await trashedNote(tag)];
    const filter = { tags: [tag], state: "trashed" as const };

    // The witness: the filter alone is over the cap.
    const unnarrowed = await client.bulkAction({
      action: "purge",
      confirm: "PURGE",
      filter,
      max_items: 1,
      dry_run: true,
    });
    expect(unnarrowed.status).toBe(400);
    expect(unnarrowed.error?.error.code).toBe("bulk_cap_exceeded");

    const result = await runToCompletion({
      action: "purge",
      confirm: "PURGE",
      filter,
      max_items: 1,
      expected_ids: [listed],
    });
    expect(result.succeeded).toBe(1);
    expect((await trashedIds(tag)).sort()).toEqual(others.slice().sort());
  });

  it("refuses expected_ids on an action other than purge", async () => {
    const tag = `purge-expected-transition-${ctx.runId}`;
    const id = await trashedNote(tag);
    const res = await client.bulkAction({
      action: "transition",
      state: "active",
      filter: { tags: [tag], state: "trashed" },
      // Off-type on purpose: the client offers the field on purge alone,
      // and the point is that the wire refuses it elsewhere.
      ...({ expected_ids: [id] } as object),
    });
    expect(res.status).toBe(400);
    expect(res.error?.error.code).toBe("validation_error");
    expect(await trashedIds(tag)).toEqual([id]);
  });
});
