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
  trackRegisteredTypes,
} from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
/** The provisioning key, whose type registrations `cleanup` removes. */
let provisioner: MarfaClient;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "item-blobs",
  ));
  provisioner = getClientFromEnv().client;
  trackRegisteredTypes(ctx, provisioner);
});

/** Items other keys of this file wrote, removed through the key that wrote each. */
const elsewhere: Array<[MarfaClient, string]> = [];

afterAll(async () => {
  const left: string[] = [];
  for (const [by, id] of elsewhere) {
    await by.deleteItem(id);
    const purged = await by.purgeItem(id);
    if (!purged.ok && purged.status !== 404) left.push(id);
  }
  await cleanup(ctx);
  expect(left, "items other keys wrote were purged").toEqual([]);
});

let minted = 0;

/** A part of a name no earlier attempt of a test on this server used. */
function fresh(): string {
  return randomUUID().replaceAll("-", "").slice(0, 8);
}

async function keyed(
  typePermissions: Record<string, string>,
  by: MarfaClient = client,
  extra: Record<string, unknown> = {},
): Promise<{ client: MarfaClient; key: string; source: string }> {
  minted += 1;
  const source = `${ctx.source}-${String(minted)}`;
  const writes = Object.values(typePermissions).includes("write");
  const res = await by.createKey({
    label: `item-blobs-${String(minted)}`,
    source,
    type_permissions: typePermissions,
    ...(writes && { permissions: ["items.purge"] }),
    ...extra,
  } as never);
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
  trackKey(ctx, res.data.id);
  return {
    client: new MarfaClient({ baseUrl: apiUrl, apiKey: res.data.key }),
    key: res.data.key,
    source,
  };
}

async function registered(
  id: string,
  fields: Record<string, unknown> = {
    blob_ref: { type: "string" },
    title: { type: "string" },
  },
  extra: Record<string, unknown> = {},
): Promise<void> {
  const res = await provisioner.registerType({ id, fields, ...extra } as never);
  expect(res.ok, JSON.stringify(res.error)).toBe(true);
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

    const vendor = `blobs${fresh()}`;
    const hidden = `app.${vendor}.held`;
    const shown = `user.${vendor}-held`;
    const app = (
      await keyed(
        { [`app.${vendor}.*`]: "write", [shown]: "write" },
        provisioner,
      )
    ).client;
    await registered(hidden);
    await registered(shown);
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

  it("finds an item by its blob_ref when another of its properties also names the hash", async () => {
    const hash = await upload();
    const made = await client.createItem({
      type: "core.file",
      properties: {
        blob_ref: hash,
        mime_type: "text/plain",
        title: "both",
        description: `The same bytes as ${hash}.`,
      },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackItem(ctx, made.data.item.id);
    expect(await idsFor(hash)).toEqual([made.data.item.id]);
  });

  it("reads a title from the property its type is titled by, and answers null where there is none", async () => {
    const type = `user.blobs-${fresh()}`;
    await registered(
      type,
      {
        blob_ref: { type: "string" },
        heading: { type: "string" },
        title: { type: "string" },
      },
      { display_hints: { title_field: "heading" } },
    );
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

  it("answers null for a title property that holds no text", async () => {
    const type = `user.blobs-number-${fresh()}`;
    await registered(
      type,
      { blob_ref: { type: "string" }, number: { type: "integer" } },
      { display_hints: { title_field: "number" } },
    );
    const hash = await upload();
    const made = await client.createItem({
      type,
      properties: { blob_ref: hash, number: 17 },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackItem(ctx, made.data.item.id);
    const read = await client.getItem(made.data.item.id);
    expect(read.data.item.properties.number, "the item holds 17").toBe(17);
    const res = await client.findItemsByBlob([hash]);
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    await expectMatchesSchema("POST", "/items/blobs", 200, res.data);
    expect(res.data.data[0]?.items).toEqual([
      { id: made.data.item.id, type, title: null },
    ]);
  });

  it("leaves out an item whose type the key may not read, and refuses a key that reads no type", async () => {
    const hash = await upload();
    const fileId = await file(hash);
    const type = `user.blobs-scope-${fresh()}`;
    await registered(type, { blob_ref: { type: "string" } });
    const made = await client.createItem({
      type,
      source: ctx.source,
      properties: { blob_ref: hash },
    });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    trackItem(ctx, made.data.item.id);
    expect(await idsFor(hash)).toEqual([fileId, made.data.item.id].sort());

    const fileReader = (await keyed({ "core.file": "read" })).client;
    expect(await idsFor(hash, fileReader)).toEqual([fileId]);

    const refused = await getManagementClient().findItemsByBlob([hash]);
    expect(refused.status).toBe(403);
    expect(codeOf(refused.error)).toBe("type_not_permitted");
  });

  it("answers a hash no item the key may list holds the same, whatever holds the bytes", async () => {
    const vendor = `same${fresh()}`;
    const hidden = `app.${vendor}.held`;
    const unreadable = `user.${vendor}-held`;
    const writer = (
      await keyed(
        {
          "core.file": "write",
          [`app.${vendor}.*`]: "write",
          [unreadable]: "write",
        },
        provisioner,
      )
    ).client;
    await registered(hidden);
    await registered(unreadable);
    const reader = await keyed(
      { "core.file": "read", [`app.${vendor}.*`]: "read" },
      provisioner,
    );

    const unreadableHash = await upload(writer);
    const unreadableId = await file(unreadableHash, "u", writer, unreadable);
    expect(
      await idsFor(unreadableHash, writer),
      "a key that reads the type finds it",
    ).toEqual([unreadableId]);

    const binnedHash = await upload(writer);
    const binned = await file(binnedHash, "b", writer);
    expect(
      await idsFor(binnedHash, reader.client),
      "the reader finds it active",
    ).toEqual([binned]);
    expect((await writer.deleteItem(binned)).status).toBe(200);

    const hiddenHash = await upload(writer);
    const hiddenId = await file(hiddenHash, "h", writer, hidden);
    const hiddenRead = await reader.client.getItem(hiddenId);
    expect(hiddenRead.ok, "the reader may read the hidden item itself").toBe(
      true,
    );

    const control = await rawAnswer(absent(), reader.key);
    expect(control[0]).toBe(200);
    for (const hash of [unreadableHash, binnedHash, hiddenHash]) {
      expect((await writer.headBlob(hash)).status, "the bytes are held").toBe(
        200,
      );
      expect(await rawAnswer(hash, reader.key)).toEqual(control);
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

  it("counts only the items the key may list towards the 20, so a left-out item neither takes a place nor sets more", async () => {
    const unreadable = `user.blobs-mix-${fresh()}`;
    const filtered = `user.blobs-filtered-${fresh()}`;
    await registered(unreadable);
    await registered(filtered);
    const writer = await keyed(
      { "core.file": "write", [unreadable]: "write", [filtered]: "write" },
      provisioner,
    );
    const other = await keyed(
      { "core.file": "write", [filtered]: "write" },
      provisioner,
    );
    const reader = await keyed(
      { "core.file": "read", [filtered]: "read" },
      provisioner,
      {
        enforcement_override: {
          source_filter: { types: [filtered], sources: [writer.source] },
        },
      },
    );
    const bytes = new TextEncoder().encode(`item-blobs ${randomUUID()}`);
    const sent = await writer.client.uploadBlob(bytes, "text/plain");
    expect(sent.status, JSON.stringify(sent.error)).toBe(201);
    const hash = sent.data.hash;
    const proved = await other.client.uploadBlob(bytes, "text/plain");
    expect(proved.status, JSON.stringify(proved.error)).toBe(201);

    /** Items the reader may not list: another type, another source, the bin. */
    const leftOut = async (): Promise<void> => {
      await file(hash, "type", writer.client, unreadable);
      const sourced = await other.client.createItem({
        type: filtered,
        properties: { blob_ref: hash, title: "source" },
      });
      expect(sourced.status, JSON.stringify(sourced.error)).toBe(201);
      elsewhere.push([other.client, sourced.data.item.id]);
      const binned = await file(hash, "bin", writer.client);
      expect((await writer.client.deleteItem(binned)).status).toBe(200);
    };
    const shown: string[] = [];
    for (let round = 0; round < 4; round += 1) {
      await leftOut();
      for (let at = 0; at < 5; at += 1) {
        shown.push(
          await file(
            hash,
            "shown",
            writer.client,
            at % 2 === 0 ? "core.file" : filtered,
          ),
        );
      }
    }
    await leftOut();

    const witness = await writer.client.findItemsByBlob([hash]);
    expect(witness.status, JSON.stringify(witness.error)).toBe(200);
    expect(witness.data.data[0]?.more, "the writer lists more than 20").toBe(
      true,
    );
    const otherSees = await other.client.findItemsByBlob([hash]);
    expect(
      otherSees.data.data[0]?.items.some((item) => item.title === "source"),
      "the other source's item is listed by a key without the filter",
    ).toBe(true);

    const full = await reader.client.findItemsByBlob([hash]);
    expect(full.status, JSON.stringify(full.error)).toBe(200);
    expect(full.data.data[0]?.items.map((item) => item.id)).toEqual(
      [...shown].sort(),
    );
    expect(full.data.data[0]?.more).toBe(false);

    shown.push(await file(hash, "shown", writer.client));
    const over = await reader.client.findItemsByBlob([hash]);
    expect(over.data.data[0]?.items.map((item) => item.id)).toEqual(
      [...shown].sort().slice(0, 20),
    );
    expect(over.data.data[0]?.more).toBe(true);
  });
});
