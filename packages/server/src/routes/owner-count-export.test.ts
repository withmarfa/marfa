import { gunzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { itemWrites } from "../storage/item-writes.js";
import {
  createTestContext,
  mintWorkingKey,
  seedOauthBearer,
  type TestContext,
} from "../test-utils.js";

const contexts: TestContext[] = [];
async function context() {
  const ctx = await createTestContext();
  contexts.push(ctx);
  return ctx;
}
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.cleanup()));
});

it("lets the owner count every state and export metadata without minting a key", async () => {
  const ctx = await context();
  const first = await itemWrites(ctx.storage).create({
    writer: null,
    type: "core.note",
    properties: { body: "active" },
    tags: ["kept"],
  });
  await itemWrites(ctx.storage).create({
    writer: null,
    type: "core.bookmark",
    properties: { url: "https://example.test" },
    state: "archived",
  });
  await itemWrites(ctx.storage).create({
    writer: null,
    type: "core.note",
    properties: { body: "trash" },
    state: "trashed",
  });
  await itemWrites(ctx.storage).create({
    writer: null,
    type: "system.folder",
    properties: { title: "folder" },
  });
  await ctx.storage.metadata.setExtension(
    first.id,
    "private.example",
    { retained: true },
    null,
  );
  const before = await ctx.storage.keys.list();
  const counted = await ctx.ownerRequest("/items/stats?by=type");
  expect(counted.status).toBe(200);
  expect(await counted.json()).toEqual({ "core.note": 2, "core.bookmark": 1 });
  const all = await ctx.ownerRequest("/items/stats?include=system&by=type");
  expect((await all.json()) as object).toMatchObject({ "system.folder": 1 });
  const exported = await ctx.ownerRequest("/export?type=core.note");
  expect(exported.status).toBe(200);
  const records = (await exported.text())
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          item: { id: string };
          metadata: { extensions: object };
        },
    );
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    item: { id: first.id },
    metadata: { extensions: { "private.example": { retained: true } } },
  });
  expect(await ctx.storage.keys.list()).toEqual(before);
  const audit = (await ctx.storage.audit.list({ action: "export.run" })).data;
  expect(audit).toHaveLength(1);
  const session = await ctx.auth.getSession(
    new Headers({ cookie: ctx.owner.cookie }),
    { readOnly: true },
  );
  expect(session).not.toBeNull();
  expect(audit[0]?.key_id).toBe(`owner:${session!.session.id}`);
});

it("keeps a bearer narrow even when the owner cookie is present", async () => {
  const ctx = await context();
  await itemWrites(ctx.storage).create({
    writer: null,
    type: "core.note",
    properties: { body: "note" },
  });
  await itemWrites(ctx.storage).create({
    writer: null,
    type: "core.bookmark",
    properties: { url: "https://example.test" },
  });
  const key = await mintWorkingKey(ctx, {
    type_permissions: { "core.note": "read" },
    edge_permissions: {},
    extension_permissions: {},
    permissions: [],
  });
  const oauth = (await seedOauthBearer(ctx, ["core.note:read"])).token;
  for (const bearer of [key, oauth]) {
    const counted = await ctx.ownerRequest("/items/stats?by=type", {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(counted.status).toBe(200);
    expect(await counted.json()).toEqual({ "core.note": 1 });
    const exported = await ctx.ownerRequest("/export?type=core.bookmark", {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(exported.status).toBe(403);
    for (const format of ["ndjson", "archive"]) {
      const selected = await ctx.ownerRequest(`/export?format=${format}`, {
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(selected.status).toBe(200);
      const bytes = Buffer.from(await selected.arrayBuffer());
      const text =
        format === "archive" ? gunzipSync(bytes).toString() : bytes.toString();
      expect(text).toContain('"type":"core.note"');
      expect(text).not.toContain('"type":"core.bookmark"');
    }
    expect(
      (
        await ctx.ownerRequest(
          "/items/stats?filter=edge[references]%20eq%20%22any%22",
          {
            headers: { authorization: `Bearer ${bearer}` },
          },
        )
      ).status,
    ).toBe(403);
  }
  for (const path of ["/items/stats", "/export", "/export?format=archive"]) {
    for (const authorization of [
      "Bearer invalid",
      "Bearer ",
      "Basic invalid",
      "",
    ]) {
      const bad = await ctx.ownerRequest(path, { headers: { authorization } });
      expect(bad.status, authorization).toBe(401);
    }
  }
});

it("lets a live owner browser export an archive", async () => {
  const ctx = await context();
  const result = await ctx.ownerRequest("/export?format=archive");
  expect(result.status).toBe(200);
  await result.arrayBuffer();
});

async function sql(
  ctx: TestContext,
  statement: string,
  params: unknown[] = [],
) {
  return (
    ctx.storage as typeof ctx.storage & {
      __sqliteRun: (statement: string, params: unknown[]) => Promise<unknown>;
    }
  ).__sqliteRun(statement, params);
}

it("keeps listing filters and relationship terms on owner counts", async () => {
  const ctx = await context();
  const note = await itemWrites(ctx.storage).create({
    writer: null,
    type: "core.note",
    properties: { body: "matching" },
    source: "visible",
    tier: "feed",
    tags: ["chosen"],
  });
  const target = await itemWrites(ctx.storage).create({
    writer: null,
    type: "core.bookmark",
    properties: { url: "https://example.test" },
    source: "visible",
  });
  await ctx.storage.edges.createRaw({
    source_id: note.id,
    target_id: target.id,
    edge_type: "references",
  });
  for (const query of [
    "tags=chosen",
    "tier=feed",
    "filter=properties.body%20eq%20%22matching%22",
    `edge[references]=${target.id}`,
    `filter=edge[references]%20eq%20%22${target.id}%22`,
    "type=core.note&state=active",
  ]) {
    const result = await ctx.ownerRequest(`/items/stats?${query}`);
    expect(result.status, query).toBe(200);
    expect(await result.json(), query).toEqual({ active: 1 });
  }
  const backref = await ctx.ownerRequest(
    `/items/stats?backref[references]=${note.id}`,
  );
  expect(await backref.json()).toEqual({ active: 1 });
  for (const path of ["/items/stats?type=core.*", "/export?type=core.*"]) {
    const result = await ctx.ownerRequest(path);
    expect(result.status).toBe(200);
    await result.body?.cancel();
  }
  for (const query of [
    "type=user.missing",
    "type=*",
    "state=missing",
    "occurred_after=invalid",
    "edge[references]=",
    "filter=edge[references]%20eq",
    "filter=properties.body%20eq%201e999",
  ]) {
    const result = await ctx.ownerRequest(`/items/stats?${query}`);
    expect(result.status, query).toBe(400);
  }
  for (const query of [
    "type=user.missing",
    "type=*",
    "state=missing",
    "occurred_after=invalid",
    "source=",
    "filter=properties.body%20eq%20%22matching%22",
  ]) {
    for (const format of ["ndjson", "archive"]) {
      const result = await ctx.ownerRequest(
        `/export?format=${format}&${query}`,
      );
      expect(result.status, `${format}: ${query}`).toBe(400);
    }
  }
  expect(
    await (await ctx.ownerRequest("/items/stats?tags=absent")).json(),
  ).toEqual({});
  expect(await (await ctx.ownerRequest("/export?source=absent")).text()).toBe(
    "",
  );
});

it("applies instance source filtering to owner counts and both export formats", async () => {
  const ctx = await context();
  for (const source of ["visible", "hidden"]) {
    await itemWrites(ctx.storage).create({
      writer: null,
      type: "core.note",
      properties: { body: source },
      source,
    });
  }
  const before = await ctx.ownerRequest("/items/stats");
  expect(await before.json()).toEqual({ active: 2 });
  const config = await ctx.ownerRequest("/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enforcement: {
        source_filter: { types: ["core.note"], sources: ["visible"] },
      },
    }),
  });
  expect(config.status).toBe(200);
  expect(await (await ctx.ownerRequest("/items/stats")).json()).toEqual({
    active: 1,
  });
  const exported = await ctx.ownerRequest("/export");
  expect(exported.status).toBe(200);
  const lines = (await exported.text()).trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!) as object).toMatchObject({
    item: { source: "visible" },
  });
  const archived = await ctx.ownerRequest("/export?format=archive");
  expect(archived.status).toBe(200);
  const restored = await context();
  const restore = await restored.ownerRequest("/restore", {
    method: "POST",
    headers: { "content-type": "application/gzip" },
    body: Buffer.from(await archived.arrayBuffer()),
  });
  expect(restore.status).toBe(200);
  expect(
    (await restored.storage.items.list({})).data.map((item) => item.source),
  ).toEqual(["visible"]);
});

it("admits an older live session without recent authentication and refuses expired, revoked and foreign sessions", async () => {
  const ctx = await context();
  await sql(ctx, "UPDATE auth_session SET created_at = created_at - 600");
  const paths = ["/items/stats", "/export", "/export?format=archive"];
  for (const path of paths) {
    const result = await ctx.ownerRequest(path);
    expect(result.status, path).toBe(200);
    await result.arrayBuffer();
  }
  const foreign = await context();
  for (const path of paths) {
    expect((await ctx.app.request(path)).status).toBe(401);
    expect(
      (
        await ctx.app.request(path, {
          headers: { cookie: foreign.owner.cookie },
        })
      ).status,
    ).toBe(401);
  }
  await sql(ctx, "UPDATE auth_session SET expires_at = 1");
  for (const path of paths)
    expect((await ctx.ownerRequest(path)).status).toBe(401);
  const revoked = await context();
  const signout = await revoked.ownerRequest("/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(signout.status).toBe(200);
  for (const path of paths)
    expect((await revoked.ownerRequest(path)).status).toBe(401);
});

it("keeps other content reads closed to the owner with working credential witnesses", async () => {
  const ctx = await context();
  const item = await itemWrites(ctx.storage).create({
    writer: null,
    type: "core.note",
    properties: { body: "witness" },
  });
  const target = await itemWrites(ctx.storage).create({
    writer: null,
    type: "core.note",
    properties: { body: "target" },
  });
  const edge = await ctx.storage.edges.createRaw({
    source_id: item.id,
    target_id: target.id,
    edge_type: "references",
  });
  await ctx.storage.metadata.setExtension(
    item.id,
    "example.test",
    { witness: true },
    null,
  );
  for (const path of [
    "/items",
    `/items/${item.id}`,
    `/items/${item.id}/edges`,
    `/items/${item.id}/backrefs`,
    `/items/${item.id}/metadata`,
    `/items/${item.id}/extensions`,
    `/items/${item.id}/extensions/example.test`,
    `/items/${item.id}/versions`,
    "/edges",
    `/edges/${edge.id}`,
    "/metadata/tags",
    "/search?q=witness",
    "/occurrences?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z",
  ]) {
    const witness = await ctx.app.request(path, {
      headers: { authorization: `Bearer ${ctx.workingKey}` },
    });
    expect(witness.status, path).toBe(200);
    await witness.body?.cancel();
    const refused = await ctx.ownerRequest(path);
    expect(refused.status, path).toBe(401);
  }
});

it("restores owner archives with history-only blobs, extensions and cascade marks", async () => {
  const source = await context();
  const destination = await context();
  async function upload(text: string) {
    const result = await source.app.request("/blobs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${source.workingKey}`,
        "content-type": "text/plain",
      },
      body: text,
    });
    expect(result.status).toBe(201);
    return ((await result.json()) as { hash: string }).hash;
  }
  const oldHash = await upload("historical bytes");
  const currentHash = await upload("current bytes");
  const extensionHash = await upload("extension bytes");
  const created = await source.app.request("/items", {
    method: "POST",
    headers: {
      authorization: `Bearer ${source.workingKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: "core.file",
      properties: { title: "file", blob_ref: oldHash, mime_type: "text/plain" },
      tags: ["kept"],
    }),
  });
  expect(created.status).toBe(201);
  const file = (
    (await created.json()) as { item: { id: string; version: number } }
  ).item;
  const updated = await source.app.request(`/items/${file.id}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${source.workingKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      version: file.version,
      properties: {
        title: "file",
        blob_ref: currentHash,
        mime_type: "text/plain",
      },
    }),
  });
  expect(updated.status).toBe(200);
  await source.storage.metadata.setExtension(
    file.id,
    "private.example",
    { blob: extensionHash },
    null,
  );
  const root = await itemWrites(source.storage).create({
    writer: null,
    type: "core.task",
    properties: { title: "root" },
  });
  const related = await source.app.request("/edges", {
    method: "POST",
    headers: {
      authorization: `Bearer ${source.workingKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      source_id: root.id,
      target_id: file.id,
      edge_type: "parent-of",
    }),
  });
  expect(related.status).toBe(201);
  expect(
    (
      await source.app.request(`/items/${root.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${source.workingKey}` },
      })
    ).status,
  ).toBe(200);
  const lines = (await (await source.ownerRequest("/export?state=any")).text())
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as { item?: { id: string }; metadata?: object },
    );
  expect(lines.find((line) => line.item?.id === file.id)).toMatchObject({
    item: { trashed_by_cascade: true, trashed_with: root.id },
    metadata: {
      tags: ["kept"],
      extensions: { "private.example": { blob: extensionHash } },
    },
  });
  const archived = await source.ownerRequest(
    "/export?format=archive&state=any",
  );
  expect(archived.status).toBe(200);
  const restored = await destination.ownerRequest("/restore", {
    method: "POST",
    headers: { "content-type": "application/gzip" },
    body: Buffer.from(await archived.arrayBuffer()),
  });
  expect(restored.status, await restored.clone().text()).toBe(200);
  expect(await destination.storage.items.getIncludingTrashed(file.id)).toEqual(
    await source.storage.items.getIncludingTrashed(file.id),
  );
  expect(await destination.storage.metadata.get(file.id)).toEqual(
    await source.storage.metadata.get(file.id),
  );
  const originalHistory = await source.storage.versions.list(file.id, {
    reads: () => true,
    limit: 200,
  });
  expect(originalHistory.data.length).toBeGreaterThan(0);
  expect(
    await destination.storage.versions.list(file.id, {
      reads: () => true,
      limit: 200,
    }),
  ).toEqual(originalHistory);
  for (const [hash, text] of [
    [oldHash, "historical bytes"],
    [currentHash, "current bytes"],
    [extensionHash, "extension bytes"],
  ]) {
    const blob = await destination.blobs.disk.get(hash!);
    expect(blob).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of blob!.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe(text);
  }
});
