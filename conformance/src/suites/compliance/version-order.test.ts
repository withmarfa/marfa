import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type { ApiResponse, TestContext } from "../../client/types.js";
import {
  createTestContext,
  cleanup,
  trackItem,
  trackKey,
} from "../../utils/setup.js";

let client: MarfaClient;
let noteReader: MarfaClient;
let noteWriter: MarfaClient;
let taskWriter: MarfaClient;
let nowhere: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

const UNKNOWN_ID = "00000000-0000-7000-8000-000000000000";

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "version-order",
  ));
  const readOnly = await client.createKey({
    label: `${ctx.source}-readers`,
    source: `${ctx.source}-readers`,
    sources: [ctx.source],
    type_permissions: { "core.note": "read" },
  });
  expect(readOnly.ok, JSON.stringify(readOnly.error)).toBe(true);
  trackKey(ctx, readOnly.data.id);
  noteReader = new MarfaClient({ baseUrl: apiUrl, apiKey: readOnly.data.key });
  const writesNotes = await client.createKey({
    label: `${ctx.source}-note-writers`,
    source: `${ctx.source}-note-writers`,
    sources: [ctx.source],
    type_permissions: { "core.note": "write" },
  });
  expect(writesNotes.ok, JSON.stringify(writesNotes.error)).toBe(true);
  trackKey(ctx, writesNotes.data.id);
  noteWriter = new MarfaClient({
    baseUrl: apiUrl,
    apiKey: writesNotes.data.key,
  });
  const writesTasks = await client.createKey({
    label: `${ctx.source}-task-writers`,
    source: `${ctx.source}-task-writers`,
    sources: [ctx.source],
    type_permissions: { "core.task": "write" },
  });
  expect(writesTasks.ok, JSON.stringify(writesTasks.error)).toBe(true);
  trackKey(ctx, writesTasks.data.id);
  taskWriter = new MarfaClient({
    baseUrl: apiUrl,
    apiKey: writesTasks.data.key,
  });
  const none = await client.createKey({
    label: `${ctx.source}-nowhere`,
    source: `${ctx.source}-nowhere`,
    permissions: [],
    type_permissions: { "*": "none" },
  });
  expect(none.ok, JSON.stringify(none.error)).toBe(true);
  trackKey(ctx, none.data.id);
  nowhere = new MarfaClient({ baseUrl: apiUrl, apiKey: none.data.key });
});

afterAll(async () => {
  await cleanup(ctx);
});

/** A note at version 1 whose title and body are its own. */
async function note(
  properties: Record<string, unknown> = { title: "first", body: "first body" },
): Promise<string> {
  const created = await client.createItem({
    type: "core.note",
    source: ctx.source,
    properties,
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  trackItem(ctx, created.data.item.id);
  return created.data.item.id;
}

/**
 * A note at version 2 holding one snapshot. Version 1 held the title
 * "first" and the body "first body"; the row's body has since moved on, so
 * a write naming version 1 that sets the body collides.
 */
async function movedOn(): Promise<string> {
  const id = await note();
  const moved = await client.updateItem(id, {
    properties: { body: "second body" },
    version: 1,
  });
  expect(moved.status, JSON.stringify(moved.error)).toBe(200);
  return id;
}

/**
 * `movedOn` with a natural key, so a create naming that key lands on it. The
 * row is at version 2; version 1 held "first body" and the row now holds
 * "second body".
 */
async function keyedMovedOn(): Promise<{ id: string; sourceId: string }> {
  const sourceId = `keyed-${uuidv7()}`;
  const created = await client.createItem({
    type: "core.note",
    source: ctx.source,
    source_id: sourceId,
    properties: { title: "first", body: "first body" },
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  const id = created.data.item.id;
  trackItem(ctx, id);
  const moved = await client.updateItem(id, {
    properties: { body: "second body" },
    version: 1,
  });
  expect(moved.status, JSON.stringify(moved.error)).toBe(200);
  return { id, sourceId };
}

const post = (
  body: Record<string, unknown>,
  by: MarfaClient = client,
): Promise<ApiResponse<unknown>> =>
  by.rawRequest<unknown>("/items", { method: "POST", body });

const versionsOf = async (id: string): Promise<number[]> => {
  const history = await client.getVersions(id);
  expect(history.status, JSON.stringify(history.error)).toBe(200);
  return history.data.data.map((v) => v.version);
};

const patch = (
  id: string,
  body: Record<string, unknown>,
  query = "",
  by: MarfaClient = client,
): Promise<ApiResponse<unknown>> =>
  by.rawRequest<unknown>(`/items/${id}${query}`, { method: "PATCH", body });

function expectRefusal(
  answer: ApiResponse<unknown>,
  status: number,
  code: string,
  label = "",
): void {
  expect(answer.status, `${label} ${JSON.stringify(answer.error)}`).toBe(
    status,
  );
  expect(answer.error?.error.code, label).toBe(code);
}

describe("a write that is not an update leaves the version where it was", () => {
  it("leaves the item at its version and its history empty after a tag write, a metadata replacement and an extension write", async () => {
    const id = await note();
    const before = (await client.getItem(id)).data.item;
    expect(before.version).toBe(1);

    const tagged = await client.addTags(id, [`order-${ctx.runId}`]);
    expect(tagged.status, JSON.stringify(tagged.error)).toBe(200);
    expect(tagged.data.metadata.tags).toEqual([`order-${ctx.runId}`]);
    expect((await client.getItem(id)).data.item.version).toBe(1);

    const replaced = await client.replaceMetadata(id, {
      tags: [`order-${ctx.runId}`, "second"],
    });
    expect(replaced.status, JSON.stringify(replaced.error)).toBe(200);
    expect(replaced.data.metadata.tags).toEqual([
      `order-${ctx.runId}`,
      "second",
    ]);
    expect((await client.getItem(id)).data.item.version).toBe(1);

    const extended = await client.setItemExtension(id, "order.test", { n: 1 });
    expect(extended.status, JSON.stringify(extended.error)).toBe(200);
    expect(extended.data.extensions["order.test"]).toEqual({ n: 1 });

    const after = (await client.getItem(id)).data.item;
    expect(after.version).toBe(1);
    expect(after.properties).toEqual(before.properties);
    expect(await versionsOf(id)).toEqual([]);

    // The witness: the writes landed, and a write naming the version the
    // item was read at is still current, where a moved version would answer
    // a conflict.
    const updated = await client.updateItem(id, {
      properties: { title: "after the tags" },
      version: 1,
    });
    expect(updated.status, JSON.stringify(updated.error)).toBe(200);
    expect(updated.data.item.version).toBe(2);
    expect(await versionsOf(id)).toEqual([1]);
  });
});

describe("a refused update leaves the history as it was", () => {
  it("leaves it after an update refused invalid_properties at the row's version, and writes a snapshot for the same update once valid", async () => {
    const id = await movedOn();
    expect(await versionsOf(id)).toEqual([1]);

    const refused = await patch(id, { properties: { body: 5 }, version: 2 });
    expectRefusal(refused, 400, "invalid_properties");
    expect(await versionsOf(id)).toEqual([1]);
    const row = (await client.getItem(id)).data.item;
    expect(row.version).toBe(2);
    expect(row.properties.body).toBe("second body");

    const accepted = await patch(id, {
      properties: { body: "third body" },
      version: 2,
    });
    expect(accepted.status, JSON.stringify(accepted.error)).toBe(200);
    expect(await versionsOf(id)).toEqual([1, 2]);
  });

  it("leaves it after a stale update refused version_conflict, and writes a snapshot for a stale update that merges", async () => {
    const id = await movedOn();
    expect(await versionsOf(id)).toEqual([1]);

    const refused = await patch(id, {
      properties: { body: "my body" },
      version: 1,
    });
    expectRefusal(refused, 409, "version_conflict");
    expect(await versionsOf(id)).toEqual([1]);
    const row = (await client.getItem(id)).data.item;
    expect(row.version).toBe(2);
    expect(row.properties.body).toBe("second body");

    const merged = await patch(id, {
      properties: { title: "my title" },
      version: 1,
    });
    expect(merged.status, JSON.stringify(merged.error)).toBe(200);
    expect(await versionsOf(id)).toEqual([1, 2]);
  });
});

describe("a create takes no conflict parameter", () => {
  it("refuses conflict=auto on POST /items as an undeclared parameter and writes nothing", async () => {
    const sourceId = `no-conflict-${ctx.runId}`;
    const body = {
      type: "core.note",
      source: ctx.source,
      source_id: sourceId,
      properties: { body: "a create asking to be resolved" },
    };

    const refused = await client.rawRequest<unknown>("/items?conflict=auto", {
      method: "POST",
      body,
    });
    expectRefusal(refused, 400, "validation_error");
    expect(refused.error?.error.details?.unknown_parameters).toEqual([
      "conflict",
    ]);
    const none = await client.lookupItems({
      type: "core.note",
      source: ctx.source,
      source_ids: [sourceId],
    });
    expect(none.status, JSON.stringify(none.error)).toBe(200);
    expect(none.data.data).toEqual([]);

    // The witness: the same body without the parameter creates the item.
    const created = await client.rawRequest<{ item: { id: string } }>(
      "/items",
      { method: "POST", body },
    );
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    trackItem(ctx, created.data.item.id);
    const found = await client.lookupItems({
      type: "core.note",
      source: ctx.source,
      source_ids: [sourceId],
    });
    expect(found.data.data.map((item) => item.id)).toEqual([
      created.data.item.id,
    ]);
  });
});

describe("a bulk create", () => {
  it("creates each item at version 1", async () => {
    const ids = [uuidv7(), uuidv7()];
    const res = await client.bulkItems({
      atomic: false,
      items: ids.map((id, index) => ({
        id,
        type: "core.note",
        source: ctx.source,
        properties: { body: `bulk ${String(index)}` },
      })),
    });
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    expect(res.data.results.map((r) => r.outcome)).toEqual([
      "created",
      "created",
    ]);
    for (const id of ids) {
      trackItem(ctx, id);
      const row = await client.getItem(id);
      expect(row.data.item.version).toBe(1);
      expect(await versionsOf(id)).toEqual([]);
    }
  });
});

describe("the policies a type lists and the policies it answers", () => {
  it("lists the version_policy and merge_policy a type declares, and answers the resolved ones for the type itself", async () => {
    const parent = `user.order-parent-${ctx.runId}`;
    const child = `user.order-child-${ctx.runId}`;
    const bare = `user.order-bare-${ctx.runId}`;
    const register = async (schema: object) => {
      const r = await client.registerType(
        schema as Parameters<MarfaClient["registerType"]>[0],
      );
      expect(r.status, JSON.stringify(r.error)).toBe(201);
    };
    await register({
      id: parent,
      fields: { title: { type: "string" }, body: { type: "string" } },
      version_policy: { recent_days: 7, max_versions: 100 },
      merge_policy: { fields: { body: "keep_both_copies" } },
    });
    await register({
      id: child,
      parent,
      fields: {},
      version_policy: { max_versions: 5 },
      merge_policy: { default: "last_writer_wins" },
    });
    await register({ id: bare, parent, fields: {} });

    const listed = await client.listTypes();
    expect(listed.status).toBe(200);
    type Declared = {
      id: string;
      version_policy?: unknown;
      merge_policy?: unknown;
    };
    const find = (id: string) =>
      (listed.data.data as unknown as Declared[]).find((t) => t.id === id);

    // As declared: the child names only what it names, and a type that
    // names nothing carries no policy.
    expect(find(parent)?.version_policy).toEqual({
      recent_days: 7,
      max_versions: 100,
    });
    expect(find(parent)?.merge_policy).toEqual({
      fields: { body: "keep_both_copies" },
    });
    expect(find(child)?.version_policy).toEqual({ max_versions: 5 });
    expect(find(child)?.merge_policy).toEqual({ default: "last_writer_wins" });
    expect(find(bare)).toBeDefined();
    expect(find(bare)).not.toHaveProperty("version_policy");
    expect(find(bare)).not.toHaveProperty("merge_policy");

    // Resolved: the chain walked, the child's fields over the parent's.
    const read = async (id: string) =>
      (await client.getType(id)).data as unknown as Declared;
    expect((await read(child)).version_policy).toEqual({
      recent_days: 7,
      max_versions: 5,
    });
    expect((await read(child)).merge_policy).toEqual({
      fields: { body: "keep_both_copies" },
      default: "last_writer_wins",
    });
    expect((await read(bare)).version_policy).toEqual({
      recent_days: 7,
      max_versions: 100,
    });
    expect((await read(bare)).merge_policy).toEqual({
      fields: { body: "keep_both_copies" },
    });
  });
});

describe("the order PATCH /items/{id} asks its refusals in", () => {
  it("asks for the version before an undeclared body key", async () => {
    const id = await note();
    const body = { properties: { title: "x" }, force_snapshot: true };
    expectRefusal(await patch(id, body), 400, "missing_required_field");
    // The witness: the key is refused once the version is named.
    expectRefusal(
      await patch(id, { ...body, version: 1 }),
      400,
      "validation_error",
    );
    expect(await versionsOf(id)).toEqual([]);
  });

  it("asks for the version before the id", async () => {
    const id = await note();
    const body = { properties: { title: "x" } };
    const missing = await patch("not-an-id", body);
    expectRefusal(missing, 400, "missing_required_field");
    expect(missing.error?.error.details?.field).toBe("version");
    // The witnesses: the id is refused once the version is named, and the
    // same body is taken for a real id.
    expectRefusal(
      await patch("not-an-id", { ...body, version: 1 }),
      400,
      "invalid_id",
    );
    expect((await patch(id, { ...body, version: 1 })).status).toBe(200);
  });

  it("asks for the version before whether the update names anything to change", async () => {
    const id = await note();
    expectRefusal(await patch(id, {}), 400, "missing_required_field");
    // The witness: with the version named, nothing to change is refused.
    const nothing = await patch(id, { version: 1 });
    expectRefusal(nothing, 400, "validation_error");
    expect(nothing.error?.error.message).toMatch(/at least one of/i);
  });

  it("asks whether the id is well formed before whether the update names anything to change", async () => {
    const id = await note();
    expectRefusal(await patch("not-an-id", { version: 1 }), 400, "invalid_id");
    // The witness: for a real id the same body is refused for naming nothing.
    expectRefusal(await patch(id, { version: 1 }), 400, "validation_error");
  });

  it("asks whether the update names anything to change before it looks the item up", async () => {
    expectRefusal(
      await patch(UNKNOWN_ID, { version: 1 }),
      400,
      "validation_error",
    );
    // The witness: with something to change, the missing item is the answer.
    expectRefusal(
      await patch(UNKNOWN_ID, { properties: { title: "x" }, version: 1 }),
      404,
      "item_not_found",
    );
  });

  it("asks whether occurred_at is a time before it looks the item up", async () => {
    const body = { occurred_at: "yesterday", version: 1 };
    expectRefusal(await patch(UNKNOWN_ID, body), 400, "validation_error");
    expectRefusal(
      await patch(UNKNOWN_ID, { ...body, occurred_at: "2020-01-01T00:00:00Z" }),
      404,
      "item_not_found",
    );
  });

  it("asks whether the update names anything to change before the version", async () => {
    const id = await movedOn();
    expectRefusal(await patch(id, { version: 999 }), 400, "validation_error");
    // The witness: with something to change, the same version is refused
    // for having no snapshot.
    expectRefusal(
      await patch(id, { properties: { title: "x" }, version: 999 }),
      409,
      "ancestor_unavailable",
    );
  });

  it("looks the item up before it asks the version", async () => {
    const id = await movedOn();
    const body = { properties: { title: "x" }, version: 999 };
    expectRefusal(await patch(UNKNOWN_ID, body), 404, "item_not_found");
    // The witness: the same write to a real item is refused on its version.
    expectRefusal(await patch(id, body), 409, "ancestor_unavailable");
  });

  it("asks whether the key may write the item's type before it asks the version", async () => {
    const id = await movedOn();
    const body = { properties: { title: "x" }, version: 999 };
    expectRefusal(
      await patch(id, body, "", noteReader),
      403,
      "type_not_permitted",
    );
    // The witness: a key that may write the type is refused on the version.
    expectRefusal(await patch(id, body), 409, "ancestor_unavailable");
  });

  it("asks whether the type named is the item's before it asks the version", async () => {
    const id = await movedOn();
    const body = {
      type: "core.task",
      properties: { title: "x" },
      version: 999,
    };
    const mismatch = await patch(id, body);
    expectRefusal(mismatch, 409, "type_mismatch");
    // The witness: naming the item's own type, the version is the refusal.
    expectRefusal(
      await patch(id, { ...body, type: "core.note" }),
      409,
      "ancestor_unavailable",
    );
  });

  it("asks whether a type to move to is registered before it asks the version", async () => {
    const id = await movedOn();
    const body = {
      type: `user.not-registered-${ctx.runId}`,
      retype: true,
      properties: { title: "x" },
      version: 999,
    };
    expectRefusal(await patch(id, body), 400, "unknown_type");
    // The witness: moving to a registered type, the version is the refusal.
    expectRefusal(
      await patch(id, { ...body, type: "core.task" }),
      409,
      "ancestor_unavailable",
    );
  });

  it("asks whether a snapshot exists before it looks for a collision", async () => {
    const id = await movedOn();
    const colliding = { properties: { body: "my body" } };
    // The witness: naming the retained version, the write collides.
    expectRefusal(
      await patch(id, { ...colliding, version: 1 }),
      409,
      "version_conflict",
    );
    // Naming a version no snapshot covers, the same write is refused for
    // that, whatever the collision would have been.
    for (const version of [0, 3]) {
      expectRefusal(
        await patch(id, { ...colliding, version }),
        409,
        "ancestor_unavailable",
        `version ${String(version)}`,
      );
    }
  });

  it("asks whether a snapshot exists before it judges the properties", async () => {
    const id = await movedOn();
    const invalid = { properties: { title: 5 } };
    // The witness: naming the retained version, nothing collides on the
    // title and the properties are judged.
    expectRefusal(
      await patch(id, { ...invalid, version: 1 }),
      400,
      "invalid_properties",
    );
    expectRefusal(
      await patch(id, { ...invalid, version: 999 }),
      409,
      "ancestor_unavailable",
    );
  });

  it("asks for a collision before it judges the properties, without conflict=auto", async () => {
    const id = await movedOn();
    // Collides on the body, which is also the wrong shape.
    const both = { properties: { body: 5 }, version: 1 };
    expectRefusal(await patch(id, both), 409, "version_conflict");
    // The witness: with nothing colliding, the same shape is judged.
    expectRefusal(
      await patch(id, { properties: { title: 5 }, version: 1 }),
      400,
      "invalid_properties",
    );
    expect(await versionsOf(id)).toEqual([1]);
  });

  it("asks whether conflict is a mode before it asks for the version", async () => {
    const id = await note();
    const body = { properties: { title: "x" } };
    const refused = await patch(id, body, "?conflict=bogus");
    expectRefusal(refused, 400, "validation_error");
    expect(
      refused.error?.error.details?.errors,
      JSON.stringify(refused.error),
    ).toEqual([expect.objectContaining({ path: "conflict" })]);
    // The witness: a mode that exists leaves the version to be asked for.
    expectRefusal(
      await patch(id, body, "?conflict=auto"),
      400,
      "missing_required_field",
    );
    expect(await versionsOf(id)).toEqual([]);
  });

  it("answers unknown_type for an item whose type a forced delete removed before it asks the version, stale or current", async () => {
    const live = `user.order-live-${ctx.runId}`;
    const gone = `user.order-gone-${ctx.runId}`;
    for (const type of [live, gone]) {
      const registered = await client.registerType({
        id: type,
        fields: { title: { type: "string" }, body: { type: "string" } },
      });
      expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    }
    // Two rows of one shape: version 2 now, and version 1 held "first body".
    const twin = async (type: string): Promise<string> => {
      const created = await client.createItem({
        type,
        source: ctx.source,
        properties: { title: "first", body: "first body" },
      });
      expect(created.status, JSON.stringify(created.error)).toBe(201);
      trackItem(ctx, created.data.item.id);
      const moved = await client.updateItem(created.data.item.id, {
        properties: { body: "second body" },
        version: 1,
      });
      expect(moved.status, JSON.stringify(moved.error)).toBe(200);
      return created.data.item.id;
    };
    const liveId = await twin(live);
    const goneId = await twin(gone);
    const removed = await client.deleteType(gone, true);
    expect(removed.status, JSON.stringify(removed.error)).toBe(200);

    const collides = { properties: { body: "my body" } };
    const writes: Array<[string, Record<string, unknown>, number, string]> = [
      ["a stale version that collides", collides, 1, "version_conflict"],
      ["a version no snapshot covers", collides, 999, "ancestor_unavailable"],
    ];
    for (const [label, write, version, code] of writes) {
      // The witness: a row of a registered type is answered on its version.
      expectRefusal(
        await patch(liveId, { ...write, version }),
        409,
        code,
        label,
      );
      const refused = await patch(goneId, { ...write, version });
      expectRefusal(refused, 400, "unknown_type", label);
      expect(refused.error?.error.details?.type, label).toBe(gone);
    }

    // At the current version the row of a registered type takes the write.
    const current = { properties: { body: "third body" }, version: 2 };
    expect((await patch(liveId, current)).status).toBe(200);
    expectRefusal(await patch(goneId, current), 400, "unknown_type", "current");
    expect(await versionsOf(goneId)).toEqual([1]);
    const row = (await client.getItem(goneId)).data.item;
    expect(row.version).toBe(2);
    expect(row.properties.body).toBe("second body");
  });

  it("answers a snapshot the key may not read as ancestor_unavailable before it looks for a collision", async () => {
    const id = await note();
    // Snapshots 1 and 2 are a note's, 3 and 4 a task's, and the row is a
    // note again at version 5.
    const writes = [
      { properties: { title: "a note" }, version: 1 },
      {
        type: "core.task",
        retype: true,
        properties: { title: "now a task" },
        version: 2,
      },
      { properties: { title: "a task" }, version: 3 },
      {
        type: "core.note",
        retype: true,
        properties: { title: "a note again", body: "body" },
        version: 4,
      },
    ];
    for (const write of writes) {
      const res = await client.updateItem(id, write);
      expect(res.status, JSON.stringify(res.error)).toBe(200);
    }
    const history = await client.getVersions(id);
    expect(history.data.data.map((v) => [v.version, v.type])).toEqual([
      [1, "core.note"],
      [2, "core.note"],
      [3, "core.task"],
      [4, "core.task"],
    ]);

    // Version 3 is a task's snapshot, and the write collides with it on the
    // title.
    const colliding = { properties: { title: "my title" }, version: 3 };
    expectRefusal(
      await patch(id, colliding, "", noteWriter),
      409,
      "ancestor_unavailable",
    );
    // The witnesses: a key that may read the task's snapshot is told of the
    // collision, and so is the key that may not when it names a snapshot of
    // a type it reads, so the refusal above is about the type.
    expectRefusal(await patch(id, colliding), 409, "version_conflict");
    expectRefusal(
      await patch(id, { ...colliding, version: 2 }, "", noteWriter),
      409,
      "version_conflict",
    );
  });
});

describe("the order GET /items/{id}/versions asks its refusals in", () => {
  it("asks whether the key reaches any type before it names an undeclared parameter", async () => {
    const id = await note();
    const path = `/items/${id}/versions?limitt=2`;
    // The witness: a key that reaches a type is refused the parameter.
    const named = await client.rawRequest<unknown>(path);
    expectRefusal(named, 400, "validation_error");
    expect(named.error?.error.details?.unknown_parameters).toEqual(["limitt"]);

    const refused = await nowhere.rawRequest<unknown>(path);
    expectRefusal(refused, 403, "type_not_permitted");
  });

  it("asks whether limit is valid before whether the id is well formed", async () => {
    const id = await note();
    // The witnesses: a good limit leaves the bad id to be refused, and a
    // bad limit is refused for a good id.
    expectRefusal(
      await client.rawRequest<unknown>("/items/not-an-id/versions?limit=10"),
      400,
      "invalid_id",
    );
    expectRefusal(
      await client.rawRequest<unknown>(`/items/${id}/versions?limit=0`),
      400,
      "validation_error",
    );
    expectRefusal(
      await client.rawRequest<unknown>("/items/not-an-id/versions?limit=0"),
      400,
      "validation_error",
    );
  });

  it("asks whether the id is well formed before it looks the item up", async () => {
    const id = await note();
    // The witness: the same id in lower case is the item's own.
    expect((await client.getVersions(id)).status).toBe(200);
    expectRefusal(
      await client.getVersions(id.toUpperCase()),
      400,
      "invalid_id",
    );
    // A well-formed id no item holds is the lookup's answer.
    expectRefusal(await client.getVersions(UNKNOWN_ID), 404, "item_not_found");
  });
});

describe("the last page of a version history", () => {
  it("answers next_cursor null when the snapshots fill the page exactly, and a cursor one snapshot short", async () => {
    const id = await note();
    for (const version of [1, 2, 3]) {
      const res = await client.updateItem(id, {
        properties: { title: `snapshot ${String(version)}` },
        version,
      });
      expect(res.status, JSON.stringify(res.error)).toBe(200);
    }

    const short = await client.getVersions(id, { limit: 2 });
    expect(short.data.data.map((v) => v.version)).toEqual([1, 2]);
    expect(short.data.next_cursor).not.toBeNull();
    const rest = await client.getVersions(id, {
      limit: 2,
      cursor: short.data.next_cursor ?? "",
    });
    expect(rest.data.data.map((v) => v.version)).toEqual([3]);
    expect(rest.data.next_cursor).toBeNull();

    const exact = await client.getVersions(id, { limit: 3 });
    expect(exact.data.data.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(exact.data.next_cursor).toBeNull();
  });

  it("answers next_cursor null when the page fills with the readable snapshots and only ones the key may not read follow", async () => {
    const id = await note();
    // Snapshots 1 and 2 are a note's, 3 and 4 a task's, and the row is a
    // note again.
    const writes = [
      { properties: { title: "a note" }, version: 1 },
      {
        type: "core.task",
        retype: true,
        properties: { title: "now a task" },
        version: 2,
      },
      { properties: { title: "a task" }, version: 3 },
      {
        type: "core.note",
        retype: true,
        properties: { title: "a note again", body: "body" },
        version: 4,
      },
    ];
    for (const write of writes) {
      const res = await client.updateItem(id, write);
      expect(res.status, JSON.stringify(res.error)).toBe(200);
    }
    const both = await client.getVersions(id);
    expect(both.data.data.map((v) => [v.version, v.type])).toEqual([
      [1, "core.note"],
      [2, "core.note"],
      [3, "core.task"],
      [4, "core.task"],
    ]);

    // The witness: one short of the readable snapshots carries a cursor.
    const short = await noteReader.getVersions(id, { limit: 1 });
    expect(short.data.data.map((v) => v.version)).toEqual([1]);
    expect(short.data.next_cursor).not.toBeNull();

    const exact = await noteReader.getVersions(id, { limit: 2 });
    expect(exact.data.data.map((v) => v.version)).toEqual([1, 2]);
    expect(exact.data.next_cursor).toBeNull();
  });
});

describe("the order POST /items asks its refusals in when it lands on an item and names a version", () => {
  const entry = (sourceId: string, extra: Record<string, unknown> = {}) => ({
    type: "core.note",
    source: ctx.source,
    source_id: sourceId,
    properties: { title: "x" },
    ...extra,
  });

  it("asks whether the key may read the item its natural key resolves before whether the id is the item's", async () => {
    const { id, sourceId } = await keyedMovedOn();
    const other = uuidv7();
    const body = entry(sourceId, {
      type: "core.task",
      id: other,
      version: 999,
    });
    // The witness for the key itself: it may write the type it names, so a
    // create under a natural key nothing holds is taken.
    const free = await post(
      entry(`free-${uuidv7()}`, { type: "core.task" }),
      taskWriter,
    );
    expect(free.status, JSON.stringify(free.error)).toBe(201);
    trackItem(ctx, (free.data as { item: { id: string } }).item.id);
    expectRefusal(await post(body, taskWriter), 403, "type_not_permitted");
    // The witness: a key that may read the note is refused the id.
    const mismatch = await post({ ...body, type: "core.note" });
    expectRefusal(mismatch, 400, "validation_error");
    expect(mismatch.error?.error.details).toMatchObject({
      field: "id",
      requested_id: other,
      existing_id: id,
    });
  });

  it("asks whether the id is the one the natural key resolves before whether the type is the item's", async () => {
    const { id, sourceId } = await keyedMovedOn();
    const other = uuidv7();
    const body = entry(sourceId, { type: "core.task", version: 999 });
    const mismatch = await post({ ...body, id: other });
    expectRefusal(mismatch, 400, "validation_error");
    expect(mismatch.error?.error.details?.field).toBe("id");
    // The witness: with no id named, the type is refused.
    const wrongType = await post(body);
    expectRefusal(wrongType, 409, "type_mismatch");
    expect(wrongType.error?.error.details).toMatchObject({ item_id: id });
  });

  it("asks whether the type is the item's before it asks the version", async () => {
    const { sourceId } = await keyedMovedOn();
    const body = entry(sourceId, { type: "core.task", version: 999 });
    expectRefusal(await post(body), 409, "type_mismatch");
    // The witness: naming the item's own type, the version is the refusal.
    expectRefusal(
      await post({ ...body, type: "core.note" }),
      409,
      "ancestor_unavailable",
    );
  });

  it("asks whether a snapshot exists before it looks for a collision", async () => {
    const { id, sourceId } = await keyedMovedOn();
    const colliding = entry(sourceId, { properties: { body: "my body" } });
    // The witness: naming the retained version, the write collides.
    expectRefusal(
      await post({ ...colliding, version: 1 }),
      409,
      "version_conflict",
    );
    for (const version of [0, 3, 999]) {
      expectRefusal(
        await post({ ...colliding, version }),
        409,
        "ancestor_unavailable",
        `version ${String(version)}`,
      );
    }
    const row = (await client.getItem(id)).data.item;
    expect(row.version).toBe(2);
    expect(row.properties.body).toBe("second body");
    expect(await versionsOf(id)).toEqual([1]);
  });
});

describe("a bulk upsert entry that names a stale version", () => {
  const upsert = (
    sourceId: string,
    properties: Record<string, unknown>,
    version: number,
  ) => ({
    type: "core.note",
    source: ctx.source,
    source_id: sourceId,
    properties,
    version,
  });

  it("merges an entry that collides on nothing, and refuses one that collides as errored with its code and message", async () => {
    const merging = await keyedMovedOn();
    const colliding = await keyedMovedOn();
    const res = await client.bulkItems({
      atomic: false,
      items: [
        upsert(merging.sourceId, { title: "my title" }, 1),
        upsert(colliding.sourceId, { body: "my body" }, 1),
      ],
    });
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    expect(res.data.counts).toEqual({
      created: 0,
      updated: 1,
      skipped: 0,
      errored: 1,
    });
    const [merged, refused] = res.data.results;
    expect(merged).toEqual({ index: 0, outcome: "updated", id: merging.id });
    expect(refused?.index).toBe(1);
    expect(refused?.outcome).toBe("errored");
    expect(refused?.id).toBe(colliding.id);
    expect(refused?.error?.code).toBe("version_conflict");
    expect(Object.keys(refused?.error ?? {}).sort()).toEqual([
      "code",
      "message",
    ]);
    expect(refused?.error?.message).toEqual(expect.any(String));

    const mergedRow = (await client.getItem(merging.id)).data.item;
    expect(mergedRow.version).toBe(3);
    expect(mergedRow.properties).toMatchObject({
      title: "my title",
      body: "second body",
    });
    const refusedRow = (await client.getItem(colliding.id)).data.item;
    expect(refusedRow.version).toBe(2);
    expect(refusedRow.properties.body).toBe("second body");

    // The witness: the refused entry's write is taken at the version its row
    // is at, so the refusal is about the stale version.
    const current = await client.bulkItems({
      atomic: false,
      items: [upsert(colliding.sourceId, { body: "my body" }, 2)],
    });
    expect(current.data.results.map((r) => r.outcome)).toEqual(["updated"]);
  });

  it("rolls the whole batch back under atomic true when one entry collides", async () => {
    const merging = await keyedMovedOn();
    const colliding = await keyedMovedOn();
    const items = [
      upsert(merging.sourceId, { title: "my title" }, 1),
      upsert(colliding.sourceId, { body: "my body" }, 1),
    ];
    const refused = await client.bulkItems({ atomic: true, items });
    expectRefusal(refused, 409, "bulk_atomic_rollback");
    expect(refused.error?.error.details?.index).toBe(1);
    expect(refused.error?.error.details?.code).toBe("version_conflict");
    expect(Object.keys(refused.error?.error.details ?? {}).sort()).toEqual([
      "code",
      "index",
      "message",
    ]);
    for (const { id } of [merging, colliding]) {
      const row = (await client.getItem(id)).data.item;
      expect(row.version, id).toBe(2);
      expect(row.properties.title, id).toBe("first");
      expect(await versionsOf(id), id).toEqual([1]);
    }

    // The witness: without the colliding entry the batch commits.
    const committed = await client.bulkItems({
      atomic: true,
      items: items.slice(0, 1),
    });
    expect(committed.status, JSON.stringify(committed.error)).toBe(200);
    expect(committed.data.results.map((r) => r.outcome)).toEqual(["updated"]);
    expect((await client.getItem(merging.id)).data.item.version).toBe(3);
  });
});
