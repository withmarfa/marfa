/**
 * What a refused write tells a client holding it, so the client can keep the
 * write rather than drop it: a refusal caused by a grant the key lacks names
 * the grant, a write to an item in the bin says the item is there, and a
 * delete can name the version it read.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "write-refusal-details",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function keyWith(
  label: string,
  maps: {
    type_permissions: Record<string, string>;
    edge_permissions?: Record<string, string>;
    extension_permissions?: Record<string, string>;
  },
): Promise<MarfaClient> {
  const minted = await client.createKey({
    label: `${ctx.source}-${label}`,
    source: `${ctx.source}-${label}`,
    edge_permissions: {},
    extension_permissions: {},
    ...maps,
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  trackKey(ctx, minted.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
}

async function note(body: string): Promise<{ id: string; version: number }> {
  const res = await client.createItem({
    type: "core.note",
    source: ctx.source,
    properties: { body },
  });
  expect(res.status, JSON.stringify(res.error)).toBe(201);
  trackItem(ctx, res.data.item.id);
  return res.data.item;
}

describe("a refusal caused by a missing grant names it", () => {
  it("names the type, edge type or extension namespace and the level the key lacks", async () => {
    const reader = await keyWith("reader", {
      type_permissions: { "core.note": "read" },
    });
    const writer = await keyWith("writer", {
      type_permissions: { "core.note": "write" },
    });
    const target = await note("grant target");

    const create = await reader.createItem({
      type: "core.note",
      properties: { body: "refused" },
    });
    expect(create.status).toBe(403);
    expect(create.error?.error.code).toBe("type_not_permitted");
    expect(create.error?.error.details?.grant).toEqual({
      kind: "type",
      name: "core.note",
      level: "write",
    });

    const unheld = await reader.createItem({
      type: "core.task",
      properties: { title: "refused" },
    });
    expect(unheld.status).toBe(403);
    expect(unheld.error?.error.details?.grant).toEqual({
      kind: "type",
      name: "core.task",
      level: "write",
    });

    const edge = await writer.createEdge({
      source_id: target.id,
      target_id: target.id,
      edge_type: "references",
    });
    expect(edge.status).toBe(403);
    expect(edge.error?.error.code).toBe("edge_permission_denied");
    expect(edge.error?.error.details?.grant).toEqual({
      kind: "edge_type",
      name: "references",
      level: "write",
    });

    const extension = await writer.setItemExtension(target.id, "notes-app", {
      pinned: true,
    });
    expect(extension.status).toBe(403);
    expect(extension.error?.error.code).toBe("forbidden");
    expect(extension.error?.error.details?.grant).toEqual({
      kind: "extension",
      name: "notes-app",
      level: "write",
    });

    const tagged = await reader.updateMetadata(target.id, { tags: ["x"] });
    expect(tagged.status).toBe(403);
    expect(tagged.error?.error.details?.grant).toEqual({
      kind: "type",
      name: "core.note",
      level: "write",
    });

    // On the bulk door the grant rides with the entry's refusal.
    const entry = { type: "core.note", properties: { body: "refused" } };
    const atomic = await reader.bulkItems({ atomic: true, items: [entry] });
    expect(atomic.status).toBe(403);
    expect(atomic.error?.error.code).toBe("bulk_atomic_rollback");
    expect(
      (atomic.error?.error.details?.details as { grant?: unknown }).grant,
    ).toEqual({ kind: "type", name: "core.note", level: "write" });
    const loose = await reader.bulkItems({ atomic: false, items: [entry] });
    expect(loose.status).toBe(200);
    expect(loose.data.results[0]?.error?.details?.grant).toEqual({
      kind: "type",
      name: "core.note",
      level: "write",
    });

    const folder = await writer.createFolder({ title: "refused" });
    expect(folder.status).toBe(403);
    expect(folder.error?.error.details?.grant).toEqual({
      kind: "type",
      name: "system.folder",
      level: "write",
    });
  });

  it("names no grant where no grant would open the door", async () => {
    // The reserved namespace is fenced off from every key, whatever its map
    // grants, so the refusal names no grant to restore.
    const wide = await keyWith("wide", { type_permissions: { "*": "write" } });
    const fenced = await wide.createItem({
      type: "system.connection",
      properties: { kind: "app", status: "active" },
    });
    expect(fenced.status).toBe(403);
    expect(fenced.error?.error.code).toBe("type_not_permitted");
    expect(fenced.error?.error.details?.grant).toBeUndefined();

    // A row the key may not read is not a refusal at all: it is missing.
    const blind = await keyWith("blind", {
      type_permissions: { "core.task": "write" },
    });
    const target = await note("unreadable");
    const patched = await blind.updateItem(target.id, {
      properties: { body: "x" },
      version: target.version,
    });
    expect(patched.status).toBe(404);
    expect(patched.error?.error.details).toBeUndefined();
  });
});

describe("a write to an item in the bin says so", () => {
  it("answers 404 with details.trashed to a key that may read the type, and nothing to one that may not", async () => {
    const { id, version } = await note("binned");
    // The witness: the same write lands while the item is live.
    const live = await client.updateMetadata(id, { tags: ["live"] });
    expect(live.status).toBe(200);
    expect((await client.deleteItem(id)).status).toBe(200);

    const patched = await client.updateItem(id, {
      properties: { body: "edited offline" },
      version: version + 1,
    });
    expect(patched.status).toBe(404);
    expect(patched.error?.error.code).toBe("item_not_found");
    expect(patched.error?.error.details).toEqual({ trashed: true });

    const again = await client.deleteItem(id);
    expect(again.status).toBe(404);
    expect(again.error?.error.details).toEqual({ trashed: true });

    for (const write of [
      () => client.updateMetadata(id, { tags: ["late"] }),
      () => client.replaceMetadata(id, { tags: ["late"] }),
      () => client.addTags(id, ["late"]),
      () => client.removeTag(id, "live"),
      () => client.setItemExtension(id, "notes-app", { late: true }),
    ]) {
      const refused = await write();
      expect(refused.status).toBe(404);
      expect(refused.error?.error.details).toEqual({ trashed: true });
    }

    const read = await client.getItem(id);
    expect(read.status).toBe(404);
    expect(read.error?.error.details).toBeUndefined();

    const blind = await keyWith("blind-bin", {
      type_permissions: { "core.task": "write" },
    });
    const hidden = await blind.updateItem(id, {
      properties: { body: "x" },
      version,
    });
    expect(hidden.status).toBe(404);
    expect(hidden.error?.error.details).toBeUndefined();
  });
});

describe("a delete may name the version it read", () => {
  it("refuses a stale one as a stale write carrying nothing to merge, and trashes nothing", async () => {
    const { id, version } = await note("conditional delete");
    const moved = await client.updateItem(id, {
      properties: { body: "moved on" },
      version,
    });
    expect(moved.status).toBe(200);

    const stale = await client.deleteItem(id, { version });
    expect(stale.status).toBe(409);
    expect(stale.error?.error.code).toBe("version_conflict");
    const body = stale.error as unknown as {
      error: { status: number };
      current: { version: number; properties: Record<string, unknown> };
      ancestor?: unknown;
    };
    expect(body.error.status).toBe(409);
    expect(body.current.version).toBe(version + 1);
    expect(body.current.properties.body).toBe("moved on");
    expect(body.ancestor).toBeUndefined();
    expect((await client.getItem(id)).status).toBe(200);

    const current = await client.deleteItem(id, { version: version + 1 });
    expect(current.status, JSON.stringify(current.error)).toBe(200);
    expect((await client.getItem(id)).status).toBe(404);
  });

  it("deletes unconditionally where no version is named", async () => {
    const { id } = await note("unconditional delete");
    expect(
      (await client.updateItem(id, { properties: { body: "x" }, version: 1 }))
        .status,
    ).toBe(200);
    expect((await client.deleteItem(id)).status).toBe(200);
  });
});
