import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  createTestContext,
  request,
  seedOauthBearer,
  type TestContext,
  cleanupTestContext,
} from "../test-utils.js";
import { FOLDER_PROBLEM_CODES } from "@withmarfa/shared";
import { visibleText } from "../pages/reading.js";
let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await cleanupTestContext(ctx);
});
const owner = (path: string, html = false) =>
  ctx.app.request(path, {
    headers: {
      cookie: ctx.owner.cookie,
      ...(html ? { accept: "text/html" } : {}),
    },
  });
it("lists active folder summaries for the owner, pages them, and refuses a key", async () => {
  expect((await owner("/folders")).status).toBe(200);
  expect(await (await owner("/folders")).json()).toEqual({
    data: [],
    next_cursor: null,
  });
  const ids: string[] = [];
  for (const title of ["  Notes <private>  ", "Other"]) {
    const res = await request(ctx.app, "POST", "/folders", {
      key: ctx.workingKey,
      body: { title, defaults: { properties: { private: "not a summary" } } },
    });
    expect(res.status).toBe(201);
    ids.push(((await res.json()) as { item: { id: string } }).item.id);
  }
  const first = (await (await owner("/folders?limit=1")).json()) as {
    data: { id: string; title: string }[];
    next_cursor: string;
  };
  expect(first.data).toHaveLength(1);
  expect(first.next_cursor).toBeTruthy();
  const second = (await (
    await owner(
      `/folders?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`,
    )
  ).json()) as { data: { id: string }[]; next_cursor: null };
  expect(second.data).toHaveLength(1);
  expect(second.data[0]?.id).not.toBe(first.data[0]?.id);
  expect(second.next_cursor).toBeNull();
  expect(JSON.stringify(first)).not.toContain("not a summary");
  expect(
    (await request(ctx.app, "GET", "/folders", { key: ctx.workingKey })).status,
  ).toBe(403);
  const delegated = await seedOauthBearer(ctx, ["system.folder:read"]);
  expect(
    (await request(ctx.app, "GET", "/folders", { key: delegated.token }))
      .status,
  ).toBe(403);
  expect((await ctx.app.request("/folders")).status).toBe(401);
  expect((await owner("/folders?extra=1")).status).toBe(400);
  expect((await owner("/folders?cursor=broken")).status).toBe(400);
  const revoked = await request(ctx.app, "POST", `/folders/${ids[1]!}/revoke`, {
    key: ctx.workingKey,
  });
  expect(revoked.status).toBe(200);
  const list = (await (await owner("/folders")).json()) as {
    data: { id: string }[];
  };
  expect(list.data.map((x) => x.id)).toEqual([ids[0]]);
  const detail = await owner(`/auth/owner/folders/${ids[0]!}`, true);
  expect(detail.status).toBe(200);
  expect(visibleText(await detail.text())).toContain("No reports yet");
  const failed = vi
    .spyOn(ctx.storage.folderStatus, "list")
    .mockRejectedValueOnce(new Error("unavailable"));
  const failedPage = await owner(`/auth/owner/folders/${ids[0]!}`, true);
  expect(visibleText(await failedPage.text())).toContain(
    "Couldn't read sync reports",
  );
  failed.mockRestore();
  expect((await owner(`/auth/owner/folders/${ids[1]!}`, true)).status).toBe(
    404,
  );
  expect(
    (
      await owner(
        "/auth/owner/folders/01920000-0000-7000-8000-000000000000",
        true,
      )
    ).status,
  ).toBe(404);
});

it("shows multiple copies, every problem, and revoked sign-in history without counting it as current", async () => {
  const made = await request(ctx.app, "POST", "/folders", {
    key: ctx.workingKey,
    body: { title: "Reports" },
  });
  const {
    item: { id },
  } = (await made.json()) as { item: { id: string } };
  const keyRes = await ctx.ownerRequest("/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      label: "  Copy <sign-in>  ",
      source: "folder-fixture",
      type_permissions: { "system.folder": "read" },
    }),
  });
  expect(keyRes.status).toBe(201);
  const key = (await keyRes.json()) as { id: string; key: string };
  const report = {
    folder_store_id: "copy-a",
    sequence: 1,
    last_success_at: "2026-01-01T12:00:00.000Z",
    pending_uploads: 4,
    pending_downloads: 3,
    paused_removals: 2,
    first_sync_waiting: true,
    problems: FOLDER_PROBLEM_CODES.map((code) => ({ code, count: 1 })),
  };
  for (const copy of ["copy-a", "copy-b"])
    expect(
      (
        await request(ctx.app, "PUT", `/folders/${id}/status`, {
          key: key.key,
          body: { ...report, folder_store_id: copy },
        })
      ).status,
    ).toBe(200);
  const current = (await (await owner(`/folders/${id}/status`)).json()) as {
    totals: { pending_uploads: number };
    sign_ins: { current: boolean; copies: unknown[] }[];
  };
  expect(current.totals.pending_uploads).toBe(8);
  expect(current.sign_ins[0]).toMatchObject({
    current: true,
    copies: [{}, {}],
  });
  const html = await (await owner(`/auth/owner/folders/${id}`, true)).text();
  const text = visibleText(html);
  for (const label of [
    "Copy copy-a",
    "Copy copy-b",
    "Conflicts",
    "Writes refused",
    "Sign-in refused",
    "Unreadable files",
    "Files held",
    "Sync unavailable",
    "Folder missing",
    "Invalid settings",
    "First sync waiting",
    "Removals paused",
    "Name (2).md",
    "Current sign-in",
  ])
    expect(text).toContain(label);
  expect(html).toContain("&lt;sign-in&gt;");
  expect(
    (await ctx.ownerRequest(`/keys/${key.id}`, { method: "DELETE" })).status,
  ).toBe(200);
  const historical = (await (
    await owner(`/folders/${id}/status`)
  ).json()) as typeof current;
  expect(historical.totals.pending_uploads).toBe(0);
  expect(historical.sign_ins[0]?.current).toBe(false);
  expect(
    visibleText(await (await owner(`/auth/owner/folders/${id}`, true)).text()),
  ).toContain("Historical sign-in");
  expect(
    visibleText(await (await owner("/auth/owner/folders", true)).text()),
  ).toContain("Historical reports only");
});
