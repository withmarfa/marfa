import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createTestContext,
  request,
  cleanupTestContext,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await cleanupTestContext(ctx);
});
it("accepts and reads a folder-copy report", async () => {
  const made = await request(ctx.app, "POST", "/folders", {
    key: ctx.workingKey,
    body: { title: "Health" },
  });
  const { item } = (await made.json()) as { item: { id: string } };
  const res = await request(ctx.app, "PUT", `/folders/${item.id}/status`, {
    key: ctx.workingKey,
    body: {
      folder_store_id: "copy-a",
      sequence: 1,
      last_success_at: null,
      pending_uploads: 2,
      pending_downloads: 0,
      paused_removals: 0,
      first_sync_waiting: false,
      problems: [],
    },
  });
  expect(res.status).toBe(200);
  expect(
    (
      await request(ctx.app, "GET", `/folders/${item.id}/status`, {
        key: ctx.workingKey,
      })
    ).status,
  ).toBe(200);
});
