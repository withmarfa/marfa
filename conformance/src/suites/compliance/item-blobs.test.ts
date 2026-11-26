import { createHash, randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  getClientFromEnv,
  getManagementClient,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "item-blobs",
  ));
});

/** Items other keys of this file wrote, removed through the key that wrote each. */
const elsewhere: Array<[MarfaClient, string]> = [];

afterAll(async () => {
  for (const [by, id] of elsewhere) {
    await by.deleteItem(id);
    await by.purgeItem(id);
  }
  await cleanup(ctx);
});

let minted = 0;

async function keyed(
  typePermissions: Record<string, string>,
  by: MarfaClient = client,
): Promise<MarfaClient> {
  minted += 1;
  const res = await by.createKey({
    label: `item-blobs-${String(minted)}`,
    source: `${ctx.source}-${String(minted)}`,
    type_permissions: typePermissions,
  });
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
  trackKey(ctx, res.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: res.data.key });
}

async function upload(by: MarfaClient = client): Promise<string> {
  const res = await by.uploadBlob(
    new TextEncoder().encode(`item-blobs ${randomUUID()}`),
    "text/plain",
  );
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  return res.data.hash;
}

function absent(): string {
  return `sha256:${createHash("sha256").update(randomUUID()).digest("hex")}`;
}

async function file(
  hash: string,
  title: string | null = "a file",
  by: MarfaClient = client,
  type = "core.file",
): Promise<string> {
  const properties: Record<string, string> = {
    blob_ref: hash,
    mime_type: "text/plain",
  };
  if (title !== null) properties.title = title;
  const made = await by.createItem({ type, properties });
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  if (by === client) trackItem(ctx, made.data.item.id);
  else elsewhere.push([by, made.data.item.id]);
  return made.data.item.id;
}

async function idsFor(
  hash: string,
  as: MarfaClient = client,
): Promise<string[]> {
  const res = await as.findItemsByBlob([hash]);
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return (res.data.data[0]?.items ?? []).map((item) => item.id).sort();
}

/** The status and raw body a hash alone is answered with, the hash masked. */
async function rawAnswer(hash: string, key: string): Promise<[number, string]> {
  const res = await fetch(`${apiUrl}/items/blobs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ hashes: [hash] }),
  });
  return [res.status, (await res.text()).replaceAll(hash, "HASH")];
}

function codeOf(error: unknown): string | undefined {
  return (error as { error?: { code?: string } } | undefined)?.error?.code;
}

describe("POST /items/blobs", () => {
  it("answers each hash in the order named with the items that hold it", async () => {
    const one = await upload();
    const two = await upload();
    const idOne = await file(one, "one");
    const idTwo = await file(two, "two");
    const none = absent();
    const res = await client.findItemsByBlob([two, one, two, none]);
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    await expectMatchesSchema("POST", "/items/blobs", 200, res.data);
    expect(res.data.data.map((result) => result.hash)).toEqual([
      two,
      one,
      two,
      none,
    ]);
    expect(
      res.data.data.map((result) => result.items.map((item) => item.id)),
    ).toEqual([[idTwo], [idOne], [idTwo], []]);
    expect(res.data.data[0]?.items[0]).toEqual({
      id: idTwo,
      type: "core.file",
      title: "two",
    });
    expect(res.data.data.every((result) => result.more === false)).toBe(true);
  });

  it("finds an archived item, and leaves out an item in the bin and a hidden item", async () => {
    const archivedHash = await upload();
    const archived = await file(archivedHash);
    const transitioned = await client.transitionItem(archived, "archived");
    expect(transitioned.ok, JSON.stringify(transitioned.error)).toBe(true);
    expect(await idsFor(archivedHash)).toEqual([archived]);

    const binnedHash = await upload();
    const binned = await file(binnedHash);
    expect(await idsFor(binnedHash), "the witness finds it active").toEqual([
      binned,
    ]);
    expect((await client.deleteItem(binned)).status).toBe(200);
    expect(await idsFor(binnedHash)).toEqual([]);

    const vendor = `blobs${ctx.runId.replace(/[^a-z0-9]/g, "")}`;
    const hidden = `app.${vendor}.held`;
    const shown = `user.${vendor}-held`;
    const app = await keyed(
      { [`app.${vendor}.*`]: "write", [shown]: "write" },
      getClientFromEnv().client,
    );
    for (const id of [hidden, shown]) {
      const registered = await getClientFromEnv().client.registerType({
        id,
        fields: { blob_ref: { type: "string" }, title: { type: "string" } },
      });
      expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    }
    const hiddenHash = await upload(app);
    await file(hiddenHash, "hidden", app, hidden);
    const shownId = await file(hiddenHash, "shown", app, shown);
    expect(await idsFor(hiddenHash, app), "the visible twin is found").toEqual([
      shownId,
    ]);
  });

  it("leaves out an item that names the hash in another property", async () => {
    const hash = await upload();
    const note = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { title: "names it", body: `The file is ${hash}.` },
    });
    expect(note.status, JSON.stringify(note.error)).toBe(201);
    trackItem(ctx, note.data.item.id);
    const noteRead = await client.getItem(note.data.item.id);
    expect(noteRead.ok, JSON.stringify(noteRead.error)).toBe(true);
    expect(await idsFor(hash)).toEqual([]);
    const id = await file(hash);
    expect(await idsFor(hash), "the file holding it is found").toEqual([id]);
  });

  it("reads a title from the property its type is titled by, and answers null where there is none", async () => {
    const type = `user.blobs-${ctx.runId}`;
    const registered = await client.registerType({
      id: type,
      fields: {
        blob_ref: { type: "string" },
        heading: { type: "string" },
        title: { type: "string" },
      },
      display_hints: { title_field: "heading" },
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    const hash = await upload();
    const made = await client.createItem({
      type,
      source: ctx.source,
      properties: { blob_ref: hash, heading: "the heading", title: "other" },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackItem(ctx, made.data.item.id);
    const untitled = await file(hash, null);
    const res = await client.findItemsByBlob([hash]);
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    const titles = Object.fromEntries(
      (res.data.data[0]?.items ?? []).map((item) => [item.id, item.title]),
    );
    expect(titles).toEqual({
      [made.data.item.id]: "the heading",
      [untitled]: null,
    });
  });

  it("leaves out an item whose type the key may not read, and refuses a key that reads no type", async () => {
    const hash = await upload();
    const fileId = await file(hash);
    const type = `user.blobs-scope-${ctx.runId}`;
    const registered = await client.registerType({
      id: type,
      fields: { blob_ref: { type: "string" } },
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    const made = await client.createItem({
      type,
      source: ctx.source,
      properties: { blob_ref: hash },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackItem(ctx, made.data.item.id);
    expect(await idsFor(hash)).toEqual([fileId, made.data.item.id].sort());

    const fileReader = await keyed({ "core.file": "read" });
    expect(await idsFor(hash, fileReader)).toEqual([fileId]);

    const refused = await getManagementClient().findItemsByBlob([hash]);
    expect(refused.status).toBe(403);
    expect(codeOf(refused.error)).toBe("type_not_permitted");
  });

  it("answers a hash no item the key may list holds the same, whatever holds the bytes", async () => {
    const vendor = `same${ctx.runId.replace(/[^a-z0-9]/g, "")}`;
    const hidden = `app.${vendor}.held`;
    const unreadable = `user.${vendor}-held`;
    const owner = getClientFromEnv().client;
    const writer = await keyed(
      {
        "core.file": "write",
        [`app.${vendor}.*`]: "write",
        [unreadable]: "write",
      },
      owner,
    );
    for (const id of [hidden, unreadable]) {
      const registered = await owner.registerType({
        id,
        fields: { blob_ref: { type: "string" }, title: { type: "string" } },
      });
      expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    }
    const readerKey = await owner.createKey({
      label: "item-blobs-reader",
      source: `${ctx.source}-reader`,
      type_permissions: { "core.file": "read", [`app.${vendor}.*`]: "read" },
    });
    expect(readerKey.ok, JSON.stringify(readerKey.error)).toBe(true);
    trackKey(ctx, readerKey.data.id);
    const reader = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: readerKey.data.key,
    });

    const unreadableHash = await upload(writer);
    const unreadableId = await file(unreadableHash, "u", writer, unreadable);
    expect(
      await idsFor(unreadableHash, writer),
      "a key that reads the type finds it",
    ).toEqual([unreadableId]);

    const binnedHash = await upload(writer);
    const binned = await file(binnedHash, "b", writer);
    expect(
      await idsFor(binnedHash, reader),
      "the reader finds it active",
    ).toEqual([binned]);
    expect((await writer.deleteItem(binned)).status).toBe(200);

    const hiddenHash = await upload(writer);
    const hiddenId = await file(hiddenHash, "h", writer, hidden);
    const hiddenRead = await reader.getItem(hiddenId);
    expect(hiddenRead.ok, "the reader may read the hidden item itself").toBe(
      true,
    );

    const control = await rawAnswer(absent(), readerKey.data.key);
    expect(control[0]).toBe(200);
    for (const hash of [unreadableHash, binnedHash, hiddenHash]) {
      expect((await writer.headBlob(hash)).status, "the bytes are held").toBe(
        200,
      );
      expect(await rawAnswer(hash, readerKey.data.key)).toEqual(control);
    }
  });

  it("takes at most 200 hashes, and answers none for none", async () => {
    const most = await client.findItemsByBlob(
      Array.from({ length: 200 }, () => absent()),
    );
    expect(most.status, JSON.stringify(most.error)).toBe(200);
    expect(most.data.data).toHaveLength(200);

    const tooMany = await client.findItemsByBlob(
      Array.from({ length: 201 }, () => absent()),
    );
    expect(tooMany.status).toBe(400);
    expect(codeOf(tooMany.error)).toBe("validation_error");

    const empty = await client.findItemsByBlob([]);
    expect(empty.status, JSON.stringify(empty.error)).toBe(200);
    expect(empty.data.data).toEqual([]);
  });

  it("refuses a hash that is not a blob hash, and a body that is not a list of hashes", async () => {
    const good = absent();
    for (const hashes of [
      [good.toUpperCase()],
      [`sha256:${good.slice(7).toUpperCase()}`],
      [good.slice(0, -1)],
      [`${good}0`],
      [good.slice(7)],
      [`sha1:${good.slice(7)}`],
      [good, "not a hash"],
    ]) {
      const res = await client.findItemsByBlob(hashes);
      expect(res.status, JSON.stringify(hashes)).toBe(400);
      expect(codeOf(res.error)).toBe("validation_error");
    }
    for (const body of [
      { hashes: good },
      { hashes: [1] },
      { hashes: null },
      { hashes: [good], x: 1 },
    ]) {
      const res = await client.rawRequest("/items/blobs", {
        method: "POST",
        body,
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(codeOf(res.error), JSON.stringify(body)).toBe("validation_error");
    }
    const missing = await client.rawRequest("/items/blobs", {
      method: "POST",
      body: {},
    });
    expect(missing.status).toBe(400);
    expect(codeOf(missing.error)).toBe("missing_required_field");
  });

  it("lists at most 20 items for a hash and says when there are more", async () => {
    const hash = await upload();
    const ids: string[] = [];
    for (let at = 0; at < 21; at += 1) ids.push(await file(hash));
    const res = await client.findItemsByBlob([hash]);
    expect(res.status).toBe(200);
    expect(res.data.data[0]?.items.map((item) => item.id)).toEqual(
      ids.sort().slice(0, 20),
    );
    expect(res.data.data[0]?.more).toBe(true);

    const exactly = await upload();
    for (let at = 0; at < 20; at += 1) await file(exactly);
    const full = await client.findItemsByBlob([exactly]);
    expect(full.data.data[0]?.items).toHaveLength(20);
    expect(full.data.data[0]?.more).toBe(false);
  });
});
