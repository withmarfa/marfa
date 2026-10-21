import { afterEach, expect, it, vi } from "vitest";
import { createTestContext, request, type TestContext } from "../test-utils.js";
import { writeItem } from "../storage/item-write.js";
import { itemWrites } from "../storage/item-writes.js";
let ctx: TestContext;
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx.cleanup();
});
async function note(title: string) {
  const r = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: {
      type: "core.note",
      properties: { title, body: "private-body-witness" },
    },
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { item: { id: string; version: number } }).item;
}
async function act(id: string, action: string, version = 1) {
  return ctx.ownerRequest(
    `/items/summaries/${id}/${action}?version=${String(version)}`,
    { method: "POST" },
  );
}
it("trashes and restores through the canonical cascade and never returns content, including stale responses", async () => {
  ctx = await createTestContext();
  const root = await note("Root");
  const child = await note("Child");
  expect(
    (
      await request(ctx.app, "POST", "/edges", {
        key: ctx.workingKey,
        body: {
          source_id: root.id,
          target_id: child.id,
          edge_type: "parent-of",
        },
      })
    ).status,
  ).toBe(201);
  const alreadyTrashed = await note("Already trashed");
  expect(
    (
      await request(ctx.app, "POST", "/edges", {
        key: ctx.workingKey,
        body: {
          source_id: root.id,
          target_id: alreadyTrashed.id,
          edge_type: "parent-of",
        },
      })
    ).status,
  ).toBe(201);
  expect((await act(alreadyTrashed.id, "trash")).status).toBe(200);
  const witness = await request(ctx.app, "GET", `/items/${root.id}`, {
    key: ctx.workingKey,
  });
  expect(await witness.text()).toContain("private-body-witness");
  const stale = await act(root.id, "trash", 2);
  expect(stale.status).toBe(409);
  expect(await stale.text()).not.toContain("private-body-witness");
  const trash = await act(root.id, "trash");
  expect(trash.status).toBe(200);
  expect(await trash.text()).not.toContain("private-body-witness");
  expect((await ctx.storage.items.getIncludingTrashed(child.id))?.state).toBe(
    "trashed",
  );
  const list = await ctx.ownerRequest("/trash?limit=1");
  expect(list.status).toBe(200);
  const page = (await list.json()) as {
    data: { trashed_by: { kind: string }; trashed_at: string }[];
    next_cursor: string;
  };
  expect(page.data[0]?.trashed_by.kind).toBe("browser");
  expect(page.data[0]?.trashed_at).toBeTruthy();
  expect(page.next_cursor).toBeTruthy();
  expect(JSON.stringify(page)).not.toContain("private-body-witness");
  const restored = await act(root.id, "restore");
  expect(restored.status).toBe(200);
  expect(await restored.text()).not.toContain("private-body-witness");
  expect((await ctx.storage.items.get(child.id))?.state).toBe("active");
  expect(
    (await ctx.storage.items.getIncludingTrashed(alreadyTrashed.id))?.state,
  ).toBe("trashed");
  expect((await ctx.ownerRequest("/trash")).status).toBe(200);
  expect(
    (await request(ctx.app, "GET", "/trash", { key: ctx.workingKey })).status,
  ).toBe(403);
});
it("preserves a row restored after selection and reports a failed purge alongside committed purges", async () => {
  ctx = await createTestContext();
  const restored = await note("Restore");
  const failed = await note("Fail");
  const gone = await note("Gone");
  for (const n of [restored, failed, gone])
    expect((await act(n.id, "trash")).status).toBe(200);
  const snapshot = ctx.storage.runInReadSnapshot.bind(ctx.storage);
  let selected = false;
  vi.spyOn(ctx.storage, "runInReadSnapshot").mockImplementation(
    async (fn, opts) => {
      const result = await snapshot(fn, opts);
      if (!selected) {
        selected = true;
        await writeItem(
          ctx.storage,
          { kind: "platform", by: null },
          { op: "restore", id: restored.id },
        );
      }
      return result;
    },
  );
  const store = itemWrites(ctx.storage);
  const purge = store.purge.bind(store);
  vi.spyOn(store, "purge").mockImplementation(async (id, opts) => {
    if (id === failed.id) throw new Error("private-body-witness failure");
    await purge(id, opts);
  });
  const result = await ctx.ownerRequest("/trash/empty", { method: "POST" });
  expect(result.status).toBe(200);
  const body = (await result.json()) as {
    purged: number;
    failures: { id: string; details?: unknown }[];
  };
  expect(body.purged).toBe(1);
  expect(body.failures.map((x) => x.id)).toContain(failed.id);
  expect(
    body.failures.find((x) => x.id === failed.id)?.details,
  ).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain("private-body-witness");
  expect(await ctx.storage.items.get(restored.id)).not.toBeNull();
  expect(await ctx.storage.items.getIncludingTrashed(failed.id)).not.toBeNull();
  expect(await ctx.storage.items.getIncludingTrashed(gone.id)).toBeNull();
});

it("keeps the actor after later metadata writes, clears it on restore, and records no historical guess", async () => {
  ctx = await createTestContext();
  const item = await note("Attribution");
  expect(
    (
      await request(ctx.app, "DELETE", `/items/${item.id}`, {
        key: ctx.workingKey,
      })
    ).status,
  ).toBe(200);
  const before = (await ctx.storage.items.trashDetailsOf([item.id])).get(
    item.id,
  );
  expect(before?.trashed_by?.kind).toBe("key");
  await ctx.storage.metadata.setExtension(
    item.id,
    "private.example",
    { text: "private-body-witness" },
    null,
  );
  expect(
    (await ctx.storage.items.trashDetailsOf([item.id])).get(item.id),
  ).toEqual(before);
  expect((await act(item.id, "restore")).status).toBe(200);
  expect(
    (await ctx.storage.items.trashDetailsOf([item.id])).get(item.id),
  ).toEqual({ trashed_at: null, trashed_by: null });
  await writeItem(
    ctx.storage,
    { kind: "platform", by: null },
    { op: "delete", id: item.id },
  );
  expect(
    (await ctx.storage.items.trashDetailsOf([item.id])).get(item.id)
      ?.trashed_by,
  ).toBeNull();
});
it("removes only unused custom types and refuses built-ins, trash and dependencies", async () => {
  ctx = await createTestContext();
  for (const id of [
    "user.empty",
    "user.held",
    "user.parent",
    "user.dependent",
  ]) {
    const made = await request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: {
        id,
        fields: { title: { type: "string" } },
        ...(id === "user.dependent" ? { parent: "user.parent" } : {}),
      },
    });
    expect(made.status).toBe(201);
  }
  const made = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: {
      type: "user.held",
      state: "trashed",
      properties: { title: "held" },
    },
  });
  expect(made.status).toBe(201);
  for (const id of ["user.held", "user.parent"]) {
    const page = await ctx.ownerRequest(`/auth/owner/types/${id}`);
    expect(await page.text()).toContain('aria-disabled="true"');
    expect(
      (await ctx.ownerRequest(`/types/${id}`, { method: "DELETE" })).status,
    ).toBe(409);
  }
  expect(
    (await ctx.ownerRequest("/types/core.note", { method: "DELETE" })).status,
  ).toBe(403);
  expect(
    (await ctx.ownerRequest("/types/user.empty", { method: "DELETE" })).status,
  ).toBe(200);
});
