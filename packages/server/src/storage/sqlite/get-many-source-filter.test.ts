import { afterEach, expect, it } from "vitest";
import { createTestContext } from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";
import { itemWrites } from "../item-writes.js";

let ctx: TestContext;
afterEach(async () => {
  await ctx.cleanup();
});

it("keeps keyed reads bounded at the bulk cap and applies source filtering only when requested", async () => {
  ctx = await createTestContext();
  const ids = Array.from(
    { length: 50_000 },
    (_, i) => `01900000-0000-7000-8000-${i.toString(16).padStart(12, "0")}`,
  );
  const approved = await itemWrites(ctx.storage).create({
    id: ids[100],
    type: "core.note",
    source: "approved",
    properties: { body: "approved" },
  });
  const hidden = await itemWrites(ctx.storage).create({
    id: ids[40_000],
    type: "core.note",
    source: "other",
    properties: { body: "hidden" },
  });
  const uncovered = await itemWrites(ctx.storage).create({
    id: ids[49_998],
    type: "core.bookmark",
    source: "other",
    properties: { url: "https://example.com/uncovered" },
  });
  const trashed = await itemWrites(ctx.storage).create({
    id: ids[49_999],
    type: "core.note",
    source: "approved",
    properties: { body: "trashed" },
  });
  await itemWrites(ctx.storage).delete(trashed.id);
  const duplicateIds = [...ids, approved.id];
  expect(
    [...(await ctx.storage.items.getMany(duplicateIds)).keys()].sort(),
  ).toEqual([approved.id, hidden.id, uncovered.id].sort());
  const filter = { types: ["core.note"], sources: ["approved"] };
  expect(
    [
      ...(
        await ctx.storage.items.getMany(duplicateIds, { source_filter: filter })
      ).keys(),
    ].sort(),
  ).toEqual([approved.id, uncovered.id].sort());
  expect(
    [
      ...(
        await ctx.storage.items.getMany(duplicateIds, {
          includeTrashed: true,
          source_filter: filter,
        })
      ).keys(),
    ].sort(),
  ).toEqual([approved.id, uncovered.id, trashed.id].sort());
  expect(
    [
      ...(
        await ctx.storage.items.getMany(duplicateIds, { includeTrashed: true })
      ).keys(),
    ].sort(),
  ).toEqual([approved.id, hidden.id, uncovered.id, trashed.id].sort());
});
