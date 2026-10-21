import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  createTestContext,
  request,
  seedOauthBearer,
  type TestContext,
} from "../test-utils.js";
import { readAttention } from "../attention.js";
import type { ConsoleHealth } from "./console-health.js";
import { endsSoon } from "../pages/key-time.js";
let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.cleanup();
});
afterEach(() => {
  vi.restoreAllMocks();
});
const healthy: ConsoleHealth = {
  read: () =>
    Promise.resolve({
      status: "ok",
      components: { database: { status: "ok" } },
    }),
  jobs: () => Promise.resolve([]),
  objectStore: () => Promise.resolve(null),
};
it("returns an empty inventory when all is well and refuses ordinary credentials", async () => {
  const response = await ctx.ownerRequest("/attention");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: [] });
  for (const key of [
    ctx.workingKey,
    ctx.managementKey,
    (await seedOauthBearer(ctx, ["config.manage", "instance.read"])).token,
  ])
    expect((await request(ctx.app, "GET", "/attention", { key })).status).toBe(
      403,
    );
  expect((await ctx.app.request("/attention")).status).toBe(401);
  expect((await ctx.ownerRequest("/attention?unknown=1")).status).toBe(400);
});
it("keeps known health and key concerns when jobs fail or time out", async () => {
  const key = await ctx.ownerRequest("/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      label: "Ending",
      source: "attention",
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    }),
  });
  expect(key.status).toBe(201);
  const { id } = (await key.json()) as { id: string };
  const health = {
    ...healthy,
    read: () =>
      Promise.resolve({
        status: "down" as const,
        components: { database: { status: "down" as const } },
      }),
    jobs: () => Promise.reject(new Error("unavailable")),
  };
  const failed = await readAttention(ctx.storage, health);
  expect(failed).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "health", reference: "database" }),
      expect.objectContaining({ kind: "key", reference: id }),
      expect.objectContaining({
        kind: "unavailable",
        reference: "Housekeeping",
      }),
    ]),
  );
  const pending = readAttention(ctx.storage, {
    ...health,
    jobs: () => new Promise(() => undefined),
  });
  expect(await pending).toEqual(failed);
  const spy = vi
    .spyOn(ctx.housekeeping, "list")
    .mockRejectedValue(new Error("jobs unavailable"));
  const home = await (
    await ctx.ownerRequest("/", { headers: { accept: "text/html" } })
  ).text();
  expect(home).toContain("Housekeeping");
  expect(home).toContain("Key Ending ends");
  spy.mockRestore();
  await ctx.ownerRequest(`/keys/${id}`, { method: "DELETE" });
});
it("reports quiet connectors and preserves a folder concern beside another failed folder read", async () => {
  const old = new Date(Date.now() - 2 * 86400000).toISOString();
  const connectors = vi
    .spyOn(ctx.storage.connectors, "list")
    .mockResolvedValue([
      {
        id: "quiet",
        key_id: "key",
        source: "source",
        name: "Quiet",
        description: null,
        problems: {},
        last_heartbeat_at: old,
        last_run: null,
        registered_at: old,
        updated_at: old,
        hold_expires_at: null,
      },
    ]);
  const folderIds: string[] = [];
  for (const title of ["Broken", "Concern"]) {
    const made = await request(ctx.app, "POST", "/folders", {
      key: ctx.workingKey,
      body: { title },
    });
    folderIds.push(((await made.json()) as { item: { id: string } }).item.id);
  }
  const report = await request(
    ctx.app,
    "PUT",
    `/folders/${folderIds[1]!}/status`,
    {
      key: ctx.workingKey,
      body: {
        folder_store_id: "copy",
        sequence: 1,
        last_success_at: null,
        pending_uploads: 0,
        pending_downloads: 0,
        paused_removals: 1,
        first_sync_waiting: false,
        problems: [],
      },
    },
  );
  expect(report.status).toBe(200);
  const original = ctx.storage.folderStatus.list.bind(ctx.storage.folderStatus);
  const reports = vi
    .spyOn(ctx.storage.folderStatus, "list")
    .mockImplementation((id) =>
      id === folderIds[0]
        ? Promise.reject(new Error("unavailable"))
        : original(id),
    );
  const concerns = await readAttention(ctx.storage, healthy);
  expect(concerns).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "connector", reference: "quiet" }),
      expect.objectContaining({ kind: "folder", reference: folderIds[1] }),
      expect.objectContaining({ kind: "unavailable", reference: folderIds[0] }),
    ]),
  );
  const cleared = await request(
    ctx.app,
    "PUT",
    `/folders/${folderIds[1]!}/status`,
    {
      key: ctx.workingKey,
      body: {
        folder_store_id: "copy",
        sequence: 2,
        last_success_at: null,
        pending_uploads: 0,
        pending_downloads: 0,
        paused_removals: 0,
        first_sync_waiting: false,
        problems: [{ code: "conflict", count: 0 }],
      },
    },
  );
  expect(cleared.status).toBe(200);
  expect(
    (await readAttention(ctx.storage, healthy)).some(
      (item) => item.kind === "folder" && item.reference === folderIds[1],
    ),
  ).toBe(false);
  reports.mockRestore();
  connectors.mockRestore();
});
it("includes exactly seven days but excludes expired and later keys", () => {
  const now = Date.parse("2026-10-21T23:59:00.000Z"),
    week = 7 * 86400000;
  expect(endsSoon(now + week, now)).toBe(true);
  expect(endsSoon(now + week + 1, now)).toBe(false);
  expect(endsSoon(now, now)).toBe(false);
});

it.each(["failure", "timeout"])(
  "reports every unavailable source after %s",
  async (mode) => {
    const fail = (): Promise<never> =>
      mode === "failure"
        ? Promise.reject(new Error("unavailable"))
        : new Promise(() => undefined);
    vi.spyOn(ctx.storage.keys, "list").mockImplementation(fail);
    vi.spyOn(ctx.storage.connectors, "list").mockImplementation(fail);
    vi.spyOn(ctx.storage.items, "list").mockImplementation(fail);
    const concerns = await readAttention(ctx.storage, {
      read: fail,
      jobs: fail,
      objectStore: fail,
    });
    expect(concerns.map((item) => [item.kind, item.reference])).toEqual([
      ["unavailable", "Health"],
      ["unavailable", "Object store"],
      ["unavailable", "Housekeeping"],
      ["unavailable", "Connectors"],
      ["unavailable", "Folders"],
      ["unavailable", "API keys"],
    ]);
  },
);
