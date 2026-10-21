import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
let server: FreshServer;
beforeAll(async () => {
  server = await bootFreshServer("owner-trash");
  vi.stubEnv("MARFA_API_URL", server.apiUrl);
}, 2 * FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  await server?.stop();
  vi.unstubAllEnvs();
}, 2 * FRESH_SERVER_TIMEOUT_MS);
function owner(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", server.ownerCookie);
  headers.set("origin", new URL(server.apiUrl).origin);
  return fetch(`${server.apiUrl}${path}`, { ...init, headers });
}
function key(path: string, body?: unknown) {
  return fetch(`${server.apiUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${server.workingKey}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function note(title: string) {
  const r = await key("/items", {
    type: "core.note",
    properties: { title, body: "private-trash-body" },
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { item: { id: string; version: number } }).item;
}
const act = (id: string, action: string, version = 1) =>
  owner(`/items/summaries/${id}/${action}?version=${String(version)}`, {
    method: "POST",
  });
it("lists and changes trash as summaries, with exact versions and cascade restore", async () => {
  const root = await note("Parent");
  const child = await note("Child");
  expect(
    (
      await key("/edges", {
        source_id: root.id,
        target_id: child.id,
        edge_type: "parent-of",
      })
    ).status,
  ).toBe(201);
  expect(await (await key(`/items/${root.id}`)).text()).toContain(
    "private-trash-body",
  );
  const stale = await act(root.id, "trash", 2);
  expect(stale.status).toBe(409);
  expect(await stale.text()).not.toContain("private-trash-body");
  const moved = await act(root.id, "trash");
  expect(moved.status).toBe(200);
  await expectMatchesSchema(
    "POST",
    "/items/summaries/{id}/trash",
    200,
    await moved.json(),
  );
  const first = await owner("/trash?limit=1");
  expect(first.status).toBe(200);
  const body = (await first.json()) as {
    data: { id: string; trashed_by: { kind: string }; trashed_at: string }[];
    next_cursor: string;
    retention_days: number;
  };
  await expectMatchesSchema("GET", "/trash", 200, body);
  expect(body.data[0]?.trashed_by.kind).toBe("browser");
  expect(body.data[0]?.trashed_at).toBeTruthy();
  expect(body.retention_days).toBeGreaterThan(0);
  expect(JSON.stringify(body)).not.toContain("private-trash-body");
  expect(
    (
      await owner(
        `/trash?cursor=${encodeURIComponent(body.next_cursor)}&limit=1`,
      )
    ).status,
  ).toBe(200);
  expect((await key("/trash")).status).toBe(403);
  expect((await owner("/trash?cursor=invalid")).status).toBe(400);
  for (const action of ["trash", "restore", "purge"]) {
    expect((await act("invalid", action)).status).toBe(400);
    expect(
      (await act("01900000-0000-7000-8000-000000000001", action)).status,
    ).toBe(404);
    const rejected = await act(root.id, action, 2);
    expect(rejected.status).toBe(409);
    expect(await rejected.text()).not.toContain("private-trash-body");
  }
  const restored = await act(root.id, "restore");
  expect(restored.status).toBe(200);
  const restoredBody = await restored.json();
  await expectMatchesSchema(
    "POST",
    "/items/summaries/{id}/restore",
    200,
    restoredBody,
  );
  expect(JSON.stringify(restoredBody)).not.toContain("private-trash-body");
  expect((await key(`/items/${child.id}`)).status).toBe(200);
  expect((await act(root.id, "purge")).status).toBe(400);
  expect((await act(root.id, "trash")).status).toBe(200);
  const purged = await act(root.id, "purge");
  expect(purged.status).toBe(200);
  await expectMatchesSchema(
    "POST",
    "/items/summaries/{id}/purge",
    200,
    await purged.json(),
  );
  const empty = await owner("/trash/empty", { method: "POST" });
  expect(empty.status).toBe(200);
  const emptyBody = await empty.json();
  await expectMatchesSchema("POST", "/trash/empty", 200, emptyBody);
  expect(emptyBody).toMatchObject({
    purged: 1,
    failures: [],
    next_cursor: null,
  });
  expect((await key(`/items/${child.id}`)).status).toBe(404);
});
it("preserves deletion identity and time through an archive and clears them on restoration", async () => {
  const item = await note("Archive witness");
  expect((await act(item.id, "trash")).status).toBe(200);
  const before = (await (await owner("/trash")).json()) as { data: unknown[] };
  const archive = await owner(
    "/export?format=archive&type=core.note&state=any",
  );
  expect(archive.status).toBe(200);
  const bytes = await archive.arrayBuffer();
  expect((await act(item.id, "purge")).status).toBe(200);
  const restore = await owner("/restore", {
    method: "POST",
    headers: { "content-type": "application/gzip" },
    body: bytes,
  });
  expect(restore.status).toBe(200);
  const after = (await (await owner("/trash")).json()) as { data: unknown[] };
  expect(after.data).toEqual(before.data);
  expect((await act(item.id, "restore")).status).toBe(200);
  expect(
    ((await (await owner("/trash")).json()) as { data: unknown[] }).data,
  ).toEqual([]);
});

it("lets the owner remove only unused custom types", async () => {
  for (const id of [
    "user.empty",
    "user.held",
    "user.parent",
    "user.dependent",
  ]) {
    const result = await key("/types", {
      id,
      fields: { title: { type: "string" } },
      ...(id === "user.dependent" ? { parent: "user.parent" } : {}),
    });
    expect(result.status).toBe(201);
  }
  expect(
    (
      await key("/items", {
        type: "user.held",
        state: "trashed",
        properties: { title: "Held" },
      })
    ).status,
  ).toBe(201);
  expect((await owner("/types/user.held", { method: "DELETE" })).status).toBe(
    409,
  );
  expect(
    (await owner("/types/user.held?force=true", { method: "DELETE" })).status,
  ).toBe(403);
  expect((await owner("/types/user.parent", { method: "DELETE" })).status).toBe(
    409,
  );
  expect((await owner("/types/core.note", { method: "DELETE" })).status).toBe(
    403,
  );
  expect((await owner("/types/user.empty", { method: "DELETE" })).status).toBe(
    200,
  );
});
