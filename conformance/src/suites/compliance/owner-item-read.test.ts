import { afterAll, beforeAll, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { controlRequest } from "../../utils/control-request.js";

let server: FreshServer;
let itemId: string;
let archivedId: string;
let trashedId: string;
const source = "unwritten-owner-item-filter";
beforeAll(async () => {
  server = await bootFreshServer("owner-item-read");
  for (const [type, state, properties] of [
    ["core.note", "active", { body: "kept" }],
    ["core.bookmark", "archived", { url: "https://example.test/" }],
    ["core.note", "trashed", { body: "binned" }],
  ] as const) {
    const result = await fetch(`${server.apiUrl}/items`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.workingKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ type, state, properties }),
    });
    expect(result.status).toBe(201);
    const row = (await result.json()) as { item: { id: string } };
    if (state === "active") itemId = row.item.id;
    if (state === "archived") archivedId = row.item.id;
    if (state === "trashed") trashedId = row.item.id;
  }
}, 2 * FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function owner(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", server.ownerCookie);
  headers.set("origin", new URL(server.apiUrl).origin);
  return fetch(`${server.apiUrl}${path}`, { ...init, headers });
}

it("admits the owner to filtered counts and both exports without creating a key", async () => {
  const before = (await (await owner("/keys")).json()) as unknown;
  const counted = await owner("/items/stats?by=type");
  expect(counted.status).toBe(200);
  expect(await counted.json()).toMatchObject({
    "core.note": 2,
    "core.bookmark": 1,
  });
  const state = await owner("/items/stats?type=core.note&state=trashed");
  expect(await state.json()).toEqual({ trashed: 1 });
  const exported = await owner("/export");
  expect(exported.status).toBe(200);
  const ids = (await exported.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { item?: { id: string } })
    .flatMap((row) => (row.item ? [row.item.id] : []));
  expect(ids).toContain(itemId);
  expect(ids).toContain(archivedId);
  expect(ids).not.toContain(trashedId);
  const all = await owner("/export?state=any");
  expect(await all.text()).toContain(trashedId);
  const archive = await owner("/export?format=archive");
  expect(archive.status).toBe(200);
  expect(archive.headers.get("content-type")).toBe("application/gzip");
  const restored = await owner("/restore", {
    method: "POST",
    headers: { "content-type": "application/gzip" },
    body: await archive.arrayBuffer(),
  });
  expect(restored.status).toBe(200);
  expect((await restored.json()) as object).toMatchObject({ duplicates: 2 });
  expect(await (await owner("/keys")).json()).toEqual(before);
});

it("keeps other content doors and private socket reads closed with credential witnesses", async () => {
  for (const path of [
    "/items",
    `/items/${itemId}`,
    "/edges",
    "/search?q=kept",
    `/items/${itemId}/metadata`,
    `/items/${itemId}/versions`,
  ]) {
    const witness = await fetch(`${server.apiUrl}${path}`, {
      headers: { authorization: `Bearer ${server.workingKey}` },
    });
    expect(witness.status, path).toBe(200);
    await witness.arrayBuffer();
    expect((await owner(path)).status, path).toBe(401);
  }
  for (const path of ["/items/stats", "/export"]) {
    const admitted = await owner(path);
    expect(admitted.status).toBe(200);
    await admitted.arrayBuffer();
    expect((await controlRequest(server.controlSocket, path)).status).toBe(401);
  }
});

it("refuses an invalid bearer with an owner cookie and attributes owner exports", async () => {
  for (const path of ["/items/stats", "/export", "/export?format=archive"]) {
    expect((await fetch(`${server.apiUrl}${path}`)).status).toBe(401);
    expect(
      (await owner(path, { headers: { authorization: "Bearer invalid" } }))
        .status,
    ).toBe(401);
  }
  const audit = await owner("/audit?action=export.run");
  expect(audit.status).toBe(200);
  const rows = ((await audit.json()) as { data: { key_id?: string }[] }).data;
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((row) => row.key_id?.startsWith("owner:"))).toBe(true);
});

it("refuses undeclared and invalid filters and accepts an empty selection", async () => {
  for (const path of [
    "/items/stats?state=invalid",
    "/items/stats?edge[references]=",
    "/export?occurred_after=invalid",
    "/export?format=archive&type=*",
  ]) {
    expect((await owner(path)).status, path).toBe(400);
  }
  expect(await (await owner(`/export?source=${source}`)).text()).toBe("");
});

it("keeps instance source filtering on owner counts and both exports", async () => {
  const before = await owner("/items/stats?type=core.note");
  expect(await before.json()).toEqual({ active: 1, trashed: 1 });
  const configured = await owner("/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enforcement: {
        source_filter: { types: ["core.note"], sources: [source] },
      },
    }),
  });
  expect(configured.status).toBe(200);
  expect(await (await owner("/items/stats?type=core.note")).json()).toEqual({});
  expect(await (await owner("/export?type=core.note&state=any")).text()).toBe(
    "",
  );
  const archive = await owner(
    "/export?type=core.note&state=any&format=archive",
  );
  expect(archive.status).toBe(200);
  const restored = await owner("/restore", {
    method: "POST",
    headers: { "content-type": "application/gzip" },
    body: await archive.arrayBuffer(),
  });
  expect(restored.status).toBe(200);
  expect((await restored.json()) as object).toMatchObject({
    imported: 0,
    duplicates: 0,
  });
});

it("refuses the ended browser session on counts and exports", async () => {
  const ended = await owner("/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(ended.status).toBe(200);
  for (const path of ["/items/stats", "/export", "/export?format=archive"])
    expect((await owner(path)).status).toBe(401);
});
