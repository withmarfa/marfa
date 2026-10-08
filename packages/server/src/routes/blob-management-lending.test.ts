import { gunzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { BulkActionWorker } from "../bulk-actions/index.js";
import { hashApiKey } from "../middleware/auth.js";
import {
  createTestContext,
  mintWorkingKey,
  request,
  runBulkActionAsync,
  seedOauthBearer,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";

let ctx: TestContext;
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx.cleanup();
});
async function unreferenced() {
  const upload = await ctx.app.request("/blobs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.managementKey}`,
      "Content-Type": "text/plain",
    },
    body: "unreferenced management test",
  });
  expect(upload.status).toBe(201);
  return ((await upload.json()) as { hash: string }).hash;
}
async function reader() {
  return mintWorkingKey(ctx, {
    permissions: [],
    type_permissions: { "core.note": "read" },
  });
}
async function status(hash: string, key: string) {
  return (await request(ctx.app, "GET", `/blobs/${hash}`, { key })).status;
}

it.each(["direct", "bulk"] as const)(
  "credits an OAuth blobs.manage reader when its %s write adds a blob reference",
  async (door) => {
    ctx = await createTestContext();
    const hash = await unreferenced();
    const ordinary = await reader();
    const { token } = await seedOauthBearer(ctx, [
      "blobs.manage",
      "core.note:write",
    ]);
    expect(await status(hash, token)).toBe(200);
    expect(await status(hash, ordinary)).toBe(404);
    const created = await request(ctx.app, "POST", "/items", {
      key: token,
      body: {
        type: "core.note",
        properties: {
          body: door === "direct" ? `![file](${hash})` : "before bulk",
        },
        tags: ["management-proof"],
      },
    });
    expect(created.status).toBe(201);
    if (door === "bulk") {
      const completed = await runBulkActionAsync(
        ctx,
        {
          action: "update_properties",
          filter: { type: "core.note", tags: ["management-proof"] },
          patch: { body: `![file](${hash})` },
        },
        token,
      );
      expect(completed.initialStatus).toBe(202);
      expect(completed.result?.succeeded).toBe(1);
    }
    expect(await status(hash, ordinary)).toBe(200);
  },
);

it("does not lend an unreferenced blob from ordinary OAuth write permission", async () => {
  ctx = await createTestContext();
  const hash = await unreferenced();
  const ordinary = await reader();
  const { token } = await seedOauthBearer(ctx, ["core.note:write"]);
  expect(await status(hash, ctx.managementKey)).toBe(200);
  const created = await request(ctx.app, "POST", "/items", {
    key: token,
    body: { type: "core.note", properties: { body: `![file](${hash})` } },
  });
  expect(created.status).toBe(201);
  expect(await status(hash, token)).toBe(404);
  expect(await status(hash, ordinary)).toBe(404);
});

it("uses the key's current blob permission when a queued bulk write begins", async () => {
  ctx = await createTestContext();
  const hash = await unreferenced();
  const ordinary = await reader();
  const key = await mintWorkingKey(ctx, {
    permissions: ["blobs.manage"],
    type_permissions: { "core.note": "write" },
  });
  const stored = await ctx.storage.keys.validate(
    hashApiKey(key, TEST_API_KEY_SALT),
  );
  expect(stored).not.toBeNull();
  expect(await status(hash, key)).toBe(200);
  expect(
    (
      await request(ctx.app, "POST", "/items", {
        key,
        body: {
          type: "core.note",
          properties: { body: "before bulk" },
          tags: ["narrowed-blob-proof"],
        },
      })
    ).status,
  ).toBe(201);
  const queued = await request(ctx.app, "POST", "/items/bulk-actions", {
    key,
    body: {
      action: "update_properties",
      filter: { type: "core.note", tags: ["narrowed-blob-proof"] },
      patch: { body: `![file](${hash})` },
    },
  });
  expect(queued.status).toBe(202);
  const id = ((await queued.json()) as { id: string }).id;
  expect(
    (
      await ctx.ownerRequest(`/keys/${stored!.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permissions: [] }),
      })
    ).status,
  ).toBe(200);
  const worker = new BulkActionWorker({
    storage: ctx.storage,
    chunkSize: 1,
    pollIntervalMs: 1,
  });
  expect(await worker.runOnce()).toBe(true);
  const completed = await request(
    ctx.app,
    "GET",
    `/items/bulk-actions/jobs/${id}`,
    { key },
  );
  expect(completed.status).toBe(200);
  expect(
    ((await completed.json()) as { result: { succeeded: number } }).result
      .succeeded,
  ).toBe(1);
  expect(await status(hash, ordinary)).toBe(404);
});

it("exports referenced bytes an app can read through blobs.manage without lending them to ordinary readers", async () => {
  ctx = await createTestContext();
  const hash = await unreferenced();
  const ordinary = await reader();
  const { token } = await seedOauthBearer(ctx, [
    "blobs.manage",
    "core.note:read",
  ]);
  expect(
    (
      await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: { type: "core.note", properties: { body: `![file](${hash})` } },
      })
    ).status,
  ).toBe(201);
  expect(await status(hash, ordinary)).toBe(404);
  const archive = await request(
    ctx.app,
    "GET",
    "/export?format=archive&type=core.note",
    { key: token },
  );
  expect(archive.status).toBe(200);
  expect(
    gunzipSync(Buffer.from(await archive.arrayBuffer())).includes(
      Buffer.from("unreferenced management test"),
    ),
  ).toBe(true);
  const ordinaryArchive = await request(
    ctx.app,
    "GET",
    "/export?format=archive&type=core.note",
    { key: ordinary },
  );
  expect(ordinaryArchive.status).toBe(200);
  expect(
    gunzipSync(Buffer.from(await ordinaryArchive.arrayBuffer())).includes(
      Buffer.from("unreferenced management test"),
    ),
  ).toBe(false);
  expect(await status(hash, ordinary)).toBe(404);
});
