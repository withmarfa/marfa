import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { controlRequest } from "../../utils/control-request.js";

let server: FreshServer;
beforeAll(async () => {
  server = await bootFreshServer("item-summaries");
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
interface Summary {
  id: string;
  name: string;
  source: string;
  created_at: string;
}
interface Page {
  data: Summary[];
  next_cursor: string | null;
}

it("names every built-in and custom type with bounded plain text and fallback fields", async () => {
  const upload = await fetch(`${server.apiUrl}/blobs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${server.workingKey}`,
      "content-type": "text/plain",
    },
    body: "file witness",
  });
  expect(upload.status).toBe(201);
  const { hash } = (await upload.json()) as { hash: string };
  const fields: Record<string, string> = {
    "core.bookmark": "title",
    "core.entity": "name",
    "core.entity.person": "name",
    "core.entity.place": "name",
    "core.event": "title",
    "core.file": "title",
    "core.file.audio": "title",
    "core.file.image": "title",
    "core.file.video": "title",
    "core.highlight": "text",
    "core.media": "title",
    "core.media.album": "title",
    "core.media.article": "title",
    "core.media.book": "title",
    "core.media.episode": "title",
    "core.media.film": "title",
    "core.media.series": "title",
    "core.media.song": "title",
    "core.message": "body",
    "core.note": "title",
    "core.task": "title",
  };
  for (const [type, field] of Object.entries(fields)) {
    const properties: Record<string, unknown> = {
      [field]: "  Visible\tname\nprivate second line",
    };
    if (type === "core.note" || type === "core.media.article")
      properties.body = "private body";
    if (type === "core.message") properties.from = "sender";
    if (type.startsWith("core.file"))
      Object.assign(properties, { blob_ref: hash, mime_type: "text/plain" });
    const made = await key("/items", { type, properties });
    expect(made.status, `${type}: ${await made.text()}`).toBe(201);
    const result = await owner(`/items/summaries?type=${type}`);
    expect(result.status).toBe(200);
    expect(((await result.json()) as Page).data[0]?.name, type).toBe(
      "Visible name",
    );
  }
  const registered = await key("/types", {
    id: "user.named",
    fields: {
      heading: { type: "string" },
      body: { type: "string" },
      filename: { type: "string" },
      url: { type: "string" },
    },
    display_hints: { title_field: "heading", body_field: "body" },
  });
  expect(registered.status).toBe(201);
  for (const [properties, expected] of [
    [{ heading: " Custom name ", body: "Private" }, "Custom name"],
    [{ heading: "\r\n\t", body: "\n First line \r\nPrivate" }, "First line"],
    [{ filename: " document.pdf " }, "document.pdf"],
    [{ url: "https://example.test/" }, "https://example.test/"],
    [{}, "Untitled"],
    [{ heading: "😀".repeat(121) }, "😀".repeat(119) + "…"],
  ] as const) {
    const made = await key("/items", { type: "user.named", properties });
    expect(made.status).toBe(201);
    const { item } = (await made.json()) as { item: { id: string } };
    const result = await owner("/items/summaries?type=user.named");
    expect(
      ((await result.json()) as Page).data.find((row) => row.id === item.id)
        ?.name,
    ).toBe(expected);
  }
});

it("pages name matches without leaking content or widening other owner reads", async () => {
  const before = await (await owner("/keys")).json();
  const created: string[] = [];
  for (let i = 0; i < 7; i++) {
    const made = await key("/items", {
      type: "core.note",
      properties: {
        title: i % 2 ? `Needle ${i}` : `Unmatched ${i}`,
        body: "Needle private-body-witness",
        notes: "private-notes-witness",
      },
      tags: ["private-tag-witness"],
    });
    expect(made.status).toBe(201);
    created.push(((await made.json()) as { item: { id: string } }).item.id);
  }
  const trash = await key("/items", {
    type: "core.note",
    state: "trashed",
    properties: { title: "Needle trash", body: "private trash" },
  });
  expect(trash.status).toBe(201);
  const witness = await key(`/items/${created[0]}`);
  expect(witness.status).toBe(200);
  expect(await witness.text()).toContain("private-body-witness");
  let cursor: string | null = null;
  const rows: Summary[] = [];
  do {
    const query = new URLSearchParams({
      type: "core.note",
      q: " needle ",
      limit: "2",
    });
    if (cursor) query.set("cursor", cursor);
    const response = await owner(`/items/summaries?${query}`);
    expect(response.status).toBe(200);
    const page = (await response.json()) as Page;
    await expectMatchesSchema("GET", "/items/summaries", 200, page);
    rows.push(...page.data);
    cursor = page.next_cursor;
  } while (cursor);
  expect(rows.map((row) => row.name)).toEqual([
    "Needle 5",
    "Needle 3",
    "Needle 1",
  ]);
  for (const row of rows)
    expect(Object.keys(row).sort()).toEqual([
      "created_at",
      "id",
      "name",
      "source",
    ]);
  const noHit = await owner(
    "/items/summaries?type=core.note&q=private-body-witness",
  );
  expect(await noHit.json()).toEqual({ data: [], next_cursor: null });
  for (const suffix of ["include=properties", "cursor=invalid", "limit=0"]) {
    const error = await owner(`/items/summaries?type=core.note&${suffix}`);
    expect(error.status).toBe(400);
    expect(await error.text()).not.toContain("private-body-witness");
  }
  const local = await controlRequest(
    server.controlSocket,
    "/items/summaries?type=core.note&q=Needle",
  );
  expect(local.status).toBe(200);
  expect(local.body.data).toEqual(rows);
  expect((await key("/items/summaries")).status).toBe(403);
  expect(
    (
      await owner("/items/summaries", {
        headers: { authorization: `Bearer ${server.workingKey}` },
      })
    ).status,
  ).toBe(403);
  expect((await fetch(`${server.apiUrl}/items/summaries`)).status).toBe(401);
  expect((await owner(`/items/${created[0]}`)).status).toBe(401);
  expect(await (await owner("/keys")).json()).toEqual(before);
});

it("keeps archived items, exact types and source filtering while excluding system items", async () => {
  const archived = await key("/items", {
    type: "core.note",
    state: "archived",
    properties: { body: "Archived name" },
  });
  expect(archived.status).toBe(201);
  const minted = await owner("/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      label: "System witness",
      source: "summary-system",
      type_permissions: { "system.folder": "write" },
    }),
  });
  expect(minted.status).toBe(201);
  const { key: systemKey } = (await minted.json()) as { key: string };
  const system = await fetch(`${server.apiUrl}/folders`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${systemKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ title: "System name witness" }),
  });
  expect(system.status).toBe(201);
  const { item } = (await system.json()) as { item: { id: string } };
  const witness = await fetch(`${server.apiUrl}/items/${item.id}`, {
    headers: { authorization: `Bearer ${systemKey}` },
  });
  expect(witness.status).toBe(200);
  expect(await witness.text()).toContain("System name witness");
  const archiveList = await owner("/items/summaries?type=core.note&q=Archived");
  expect(
    ((await archiveList.json()) as Page).data.map((row) => row.name),
  ).toEqual(["Archived name"]);
  const exact = await owner("/items/summaries?type=core.file");
  expect(((await exact.json()) as Page).data).toHaveLength(1);
  const hiddenSystem = await owner("/items/summaries?type=system.folder");
  expect(await hiddenSystem.json()).toEqual({ data: [], next_cursor: null });
  const narrowed = await owner("/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enforcement: {
        source_filter: {
          types: ["core.note"],
          sources: ["unwritten-summary-source"],
        },
      },
    }),
  });
  expect(narrowed.status).toBe(200);
  const hidden = await owner("/items/summaries?type=core.note");
  expect(await hidden.json()).toEqual({ data: [], next_cursor: null });
  const unaffected = await owner("/items/summaries?type=core.bookmark");
  expect(((await unaffected.json()) as Page).data).toHaveLength(1);
});
