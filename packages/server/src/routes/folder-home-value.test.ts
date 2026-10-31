import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  createTestContext,
  request,
  type TestContext,
  cleanupTestContext,
} from "../test-utils.js";
import { pageLinks } from "../pages/reading.js";
import * as logger from "../middleware/logger.js";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await cleanupTestContext(ctx);
});

async function ownerHome(): Promise<string> {
  const response = await ctx.app.request("/", {
    headers: { cookie: ctx.owner.cookie, accept: "text/html" },
  });
  expect(response.status).toBe(200);
  return response.text();
}

function folderHomeValue(html: string): string {
  const links = pageLinks(html);
  return (
    links.filter((link) => link.href === "/auth/owner/folders").at(-1)?.text ??
    ""
  );
}

it("shows active folder totals on Home and does not guess when counting fails", async () => {
  expect(folderHomeValue(await ownerHome())).toMatch(/Folders.*None/);

  const ids: string[] = [];
  for (const title of ["One", "Two"]) {
    const response = await request(ctx.app, "POST", "/folders", {
      key: ctx.workingKey,
      body: { title },
    });
    expect(response.status).toBe(201);
    ids.push(((await response.json()) as { item: { id: string } }).item.id);
  }
  expect(folderHomeValue(await ownerHome())).toMatch(/Folders.*2 folders/);

  const revoked = await request(ctx.app, "POST", `/folders/${ids[1]!}/revoke`, {
    key: ctx.workingKey,
  });
  expect(revoked.status).toBe(200);
  expect(folderHomeValue(await ownerHome())).toMatch(/Folders.*1 folder/);

  vi.spyOn(logger, "log").mockImplementation(() => undefined);
  const stats = ctx.storage.items.stats.bind(ctx.storage.items);
  const failed = vi
    .spyOn(ctx.storage.items, "stats")
    .mockImplementation((filters, by) =>
      filters.types?.includes("system.folder")
        ? Promise.reject(new Error("unavailable"))
        : stats(filters, by),
    );
  const failedHome = await ownerHome();
  expect(folderHomeValue(failedHome)).toBe(
    "Folders Folders kept in step with Marfa, and their reported copies Unknown",
  );
  expect(failed).toHaveBeenCalledWith({
    types: ["system.folder"],
    states: ["active"],
  });
  failed.mockRestore();
  vi.restoreAllMocks();
});
