import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type {
  AncestorUnavailableResponse,
  ConflictResponse,
  MarfaVersion,
  TestContext,
} from "../../client/types.js";
import {
  createTestContext,
  cleanup,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let noteReader: MarfaClient;
let taskReader: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

/** A value only the snapshots written while the row was a task hold. */
let taskMark: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "version-reach",
  ));
  taskMark = `written-while-a-task-${ctx.runId}`;
  // Claims this file's source, so its natural keys resolve the same rows.
  const minted = await client.createKey({
    label: `${ctx.source}-notes`,
    source: `${ctx.source}-notes`,
    sources: [ctx.source],
    type_permissions: { "core.note": "write" },
  });
  expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
  trackKey(ctx, minted.data.id);
  noteReader = new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
  const tasks = await client.createKey({
    label: `${ctx.source}-tasks`,
    source: `${ctx.source}-tasks`,
    sources: [ctx.source],
    type_permissions: { "core.task": "read" },
  });
  expect(tasks.ok, JSON.stringify(tasks.error)).toBe(true);
  trackKey(ctx, tasks.data.id);
  taskReader = new MarfaClient({ baseUrl: apiUrl, apiKey: tasks.data.key });
});

afterAll(async () => {
  await cleanup(ctx);
});

/**
 * A row created as a task holding `taskMark`, edited once as a task, moved
 * into `core.note` and edited once as a note: versions 1 and 2 are task
 * snapshots and version 3 a note snapshot, and the row is at 4.
 */
async function movedRow(): Promise<{ id: string; sourceId: string }> {
  const sourceId = `moved-${Math.random().toString(36).slice(2)}`;
  const created = await client.createItem({
    type: "core.task",
    source: ctx.source,
    source_id: sourceId,
    properties: { title: taskMark },
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  const id = created.data.item.id;
  trackItem(ctx, id);
  for (const change of [
    { properties: { title: "still a task" }, version: 1 },
    {
      type: "core.note",
      retype: true,
      properties: { title: "now a note", body: "a note body" },
      version: 2,
    },
    { properties: { title: "a note, edited" }, version: 3 },
  ]) {
    const res = await client.updateItem(id, change);
    expect(res.status, JSON.stringify(res.error)).toBe(200);
  }
  return { id, sourceId };
}

/** A stale write naming the first task snapshot, colliding on the title. */
const STALE = { properties: { title: "mine" }, version: 1 };

describe("version history answers only the snapshots a key may read", () => {
  it("names the type each snapshot was written under", async () => {
    const { id } = await movedRow();
    const history = await client.getVersions(id);
    expect(history.status).toBe(200);
    await expectMatchesSchema("GET", "/items/{id}/versions", 200, history.data);
    expect(history.data.data.map((v) => [v.version, v.type])).toEqual([
      [1, "core.task"],
      [2, "core.task"],
      [3, "core.note"],
    ]);
  });

  it("leaves out of the history the snapshots of a type the key may not read", async () => {
    const { id } = await movedRow();
    // The witness: a key reading both types is answered the task snapshot.
    const both = await client.getVersions(id);
    expect(JSON.stringify(both.data)).toContain(taskMark);

    const notes = await noteReader.getVersions(id);
    expect(notes.status).toBe(200);
    expect(notes.data.data.map((v: MarfaVersion) => v.version)).toEqual([3]);
    expect(JSON.stringify(notes.data)).not.toContain(taskMark);
  });

  it("leaves them out of the history the item read carries", async () => {
    const { id } = await movedRow();
    const both = await client.getItemWithVersions(id);
    expect(both.status).toBe(200);
    expect(JSON.stringify(both.data.versions)).toContain(taskMark);

    const notes = await noteReader.getItemWithVersions(id);
    expect(notes.status).toBe(200);
    expect(notes.data.versions.data.map((v) => v.type)).toEqual(["core.note"]);
    expect(JSON.stringify(notes.data)).not.toContain(taskMark);
  });

  it("pages the history and fills a page past what the key may not read", async () => {
    const { id } = await movedRow();
    const first = await client.getVersions(id, { limit: 2 });
    expect(first.data.data.map((v) => v.version)).toEqual([1, 2]);
    expect(first.data.next_cursor).not.toBeNull();
    const rest = await client.getVersions(id, {
      limit: 2,
      cursor: first.data.next_cursor ?? "",
    });
    expect(rest.data.data.map((v) => v.version)).toEqual([3]);
    expect(rest.data.next_cursor).toBeNull();

    const notes = await noteReader.getVersions(id, { limit: 1 });
    expect(notes.data.data.map((v) => v.version)).toEqual([3]);
    expect(notes.data.next_cursor).toBeNull();
  });

  it("answers 404 for the history of an item in the bin, and the history again once it is restored", async () => {
    const created = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "binned history" },
    });
    expect(created.status).toBe(201);
    const id = created.data.item.id;
    trackItem(ctx, id);
    expect(
      (await client.updateItem(id, { properties: { title: "t" }, version: 1 }))
        .status,
    ).toBe(200);
    const live = await client.getVersions(id);
    expect(live.data.data.map((v) => v.version)).toEqual([1]);

    expect((await client.deleteItem(id)).ok).toBe(true);
    const binned = await client.getVersions(id);
    expect(binned.status).toBe(404);
    expect(binned.error?.error.code).toBe("item_not_found");

    expect((await client.restoreItem(id)).ok).toBe(true);
    const restored = await client.getVersions(id);
    expect(restored.data.data.map((v) => v.version)).toEqual([1]);
  });

  it("answers 404 for the history of an item of a type the key may not read", async () => {
    const task = await client.createItem({
      type: "core.task",
      source: ctx.source,
      properties: { title: taskMark },
    });
    expect(task.status).toBe(201);
    trackItem(ctx, task.data.item.id);
    // The witness: a key reading the type is answered the history.
    expect((await client.getVersions(task.data.item.id)).status).toBe(200);

    const refused = await noteReader.getVersions(task.data.item.id);
    expect(refused.status).toBe(404);
    expect(refused.error?.error.code).toBe("item_not_found");
    expect(JSON.stringify(refused.error)).not.toContain(taskMark);
  });

  it("answers 403 type_not_permitted to a key whose type map reaches no type, before it looks the item up", async () => {
    const note = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "reached by no type" },
    });
    expect(note.status).toBe(201);
    trackItem(ctx, note.data.item.id);
    const minted = await client.createKey({
      label: `${ctx.source}-nowhere`,
      source: `${ctx.source}-nowhere`,
      permissions: [],
      type_permissions: { "*": "none" },
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    const nowhere = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });

    // The witness: a key that reaches the type is answered, and an id no
    // item holds is a 404 to it.
    expect((await client.getVersions(note.data.item.id)).status).toBe(200);
    const unknown = "00000000-0000-7000-8000-000000000000";
    expect((await client.getVersions(unknown)).status).toBe(404);

    for (const id of [note.data.item.id, unknown]) {
      const refused = await nowhere.getVersions(id);
      expect(refused.status, id).toBe(403);
      expect(refused.error?.error.code, id).toBe("type_not_permitted");
    }
  });

  it("answers 400 validation_error to the X-Marfa-Read-View header on a history", async () => {
    const created = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { body: "read view header" },
    });
    expect(created.status).toBe(201);
    trackItem(ctx, created.data.item.id);
    const path = `/items/${created.data.item.id}/versions`;
    // The witness: the same request without the header is answered.
    expect((await client.rawRequest(path)).status).toBe(200);

    const refused = await client.rawRequest(path, {
      headers: { "X-Marfa-Read-View": "a".repeat(64) },
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(refused.headers.get("X-Marfa-Read-View")).toBeNull();
  });

  it("answers a stale update naming an unreadable snapshot ancestor_unavailable", async () => {
    const { id } = await movedRow();
    const both = await client.updateItem(id, STALE);
    expect(both.status).toBe(409);
    const conflict = both.error as unknown as ConflictResponse;
    expect(conflict.error.code).toBe("version_conflict");
    expect(conflict.ancestor.type).toBe("core.task");
    expect(conflict.ancestor.properties.title).toBe(taskMark);

    const { id: other } = await movedRow();
    const notes = await noteReader.updateItem(other, STALE);
    expect(notes.status).toBe(409);
    const refusal = notes.error as unknown as AncestorUnavailableResponse;
    expect(refusal.error.code).toBe("ancestor_unavailable");
    expect(refusal.requested_version).toBe(1);
    expect(JSON.stringify(refusal)).not.toContain(taskMark);
  });

  it("does not merge a stale update against a snapshot the key may not read", async () => {
    // Collides with nothing, so a key reading the snapshot merges it.
    const merging = { properties: { notes: "added" }, version: 1 };
    const { id } = await movedRow();
    const both = await client.updateItem(id, merging);
    expect(both.status, JSON.stringify(both.error)).toBe(200);

    const { id: other } = await movedRow();
    const notes = await noteReader.updateItem(other, merging);
    expect(notes.status).toBe(409);
    expect(notes.error?.error.code).toBe("ancestor_unavailable");
    const after = await client.getItem(other);
    expect(after.data.item.version).toBe(4);
  });

  it("answers a conditional create naming an unreadable snapshot ancestor_unavailable", async () => {
    const write = (sourceId: string) => ({
      type: "core.note",
      source: ctx.source,
      source_id: sourceId,
      ...STALE,
    });
    const { sourceId } = await movedRow();
    const both = await client.createItem(write(sourceId));
    expect(both.status).toBe(409);
    expect(JSON.stringify(both.error)).toContain(taskMark);

    const { sourceId: other } = await movedRow();
    const notes = await noteReader.createItem(write(other));
    expect(notes.status).toBe(409);
    expect(notes.error?.error.code).toBe("ancestor_unavailable");
    expect(JSON.stringify(notes.error)).not.toContain(taskMark);
  });

  it("answers a bulk entry naming an unreadable snapshot ancestor_unavailable", async () => {
    const codeFor = async (
      writer: MarfaClient,
    ): Promise<string | undefined> => {
      const { sourceId } = await movedRow();
      const res = await writer.bulkItems({
        atomic: false,
        items: [
          {
            type: "core.note",
            source: ctx.source,
            source_id: sourceId,
            ...STALE,
          },
        ],
      });
      expect(res.status, JSON.stringify(res.error)).toBe(200);
      return res.data.results[0]?.error?.code;
    };
    expect(await codeFor(client)).toBe("version_conflict");
    expect(await codeFor(noteReader)).toBe("ancestor_unavailable");
  });
});

interface Refusal {
  error: { code: string; details?: Record<string, unknown> };
}

/** A note holding `snapshots` snapshots, each of a title naming its version. */
async function longHistory(snapshots: number): Promise<string> {
  const created = await client.createItem({
    type: "core.note",
    source: ctx.source,
    properties: { title: "history 1", body: "a long history" },
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  const id = created.data.item.id;
  trackItem(ctx, id);
  for (let version = 1; version <= snapshots; version += 1) {
    const res = await client.updateItem(id, {
      properties: { title: `history ${String(version + 1)}` },
      version,
    });
    expect(res.status, `version ${String(version)}`).toBe(200);
  }
  return id;
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("the page of a version history", () => {
  let longId: Promise<string> | undefined;
  /** Two hundred and one snapshots, one more than the largest page. */
  const long = (): Promise<string> => (longId ??= longHistory(201));

  it("holds a page to 1 to 200 snapshots and fills it to 50 where it names no limit", async () => {
    const id = await long();

    const fallback = await client.getVersions(id);
    expect(fallback.status).toBe(200);
    expect(fallback.data.data.map((v) => v.version)).toEqual(range(1, 50));
    expect(fallback.data.next_cursor).not.toBeNull();

    const one = await client.getVersions(id, { limit: 1 });
    expect(one.status).toBe(200);
    expect(one.data.data.map((v) => v.version)).toEqual([1]);
    expect(one.data.next_cursor).not.toBeNull();

    const largest = await client.getVersions(id, { limit: 200 });
    expect(largest.status).toBe(200);
    expect(largest.data.data.map((v) => v.version)).toEqual(range(1, 200));
    expect(largest.data.next_cursor).not.toBeNull();
    const last = await client.getVersions(id, {
      limit: 200,
      cursor: largest.data.next_cursor ?? "",
    });
    expect(last.data.data.map((v) => v.version)).toEqual([201]);
    expect(last.data.next_cursor).toBeNull();

    for (const limit of ["0", "201", "-1", "1.5", "many", ""]) {
      const refused = await client.rawRequest<unknown>(
        `/items/${id}/versions?limit=${limit}`,
      );
      expect(refused.status, `limit ${limit}`).toBe(400);
      expect(refused.error?.error.code, `limit ${limit}`).toBe(
        "validation_error",
      );
    }
  });

  it("carries the first 50 snapshots on the item read and lets the listing continue from its next_cursor", async () => {
    const id = await long();
    const read = await client.getItemWithVersions(id);
    expect(read.status).toBe(200);
    expect(read.data.versions.data.map((v) => v.version)).toEqual(range(1, 50));
    expect(read.data.versions.next_cursor).not.toBeNull();

    const rest = await client.getVersions(id, {
      limit: 200,
      cursor: read.data.versions.next_cursor ?? "",
    });
    expect(rest.status).toBe(200);
    expect(rest.data.data.map((v) => v.version)).toEqual(range(51, 201));
    expect(rest.data.next_cursor).toBeNull();
  });

  it("refuses a cursor that is malformed or that another listing issued, and takes one the door issued for another item", async () => {
    const { id } = await movedRow();
    const { id: other } = await movedRow();
    const issued = await client.getVersions(id, { limit: 1 });
    expect(issued.data.next_cursor).not.toBeNull();
    const cursor = issued.data.next_cursor ?? "";

    // The witness: the cursor the door issued continues its own listing.
    const continued = await client.getVersions(id, { limit: 1, cursor });
    expect(continued.data.data.map((v) => v.version)).toEqual([2]);

    const listed = await client.listItems({ source: ctx.source, limit: 1 });
    expect(listed.data.next_cursor).not.toBeNull();
    for (const bad of [
      "not-a-cursor",
      "%%%",
      "e30",
      listed.data.next_cursor ?? "",
    ]) {
      const refused = await client.rawRequest<unknown>(
        `/items/${id}/versions?cursor=${encodeURIComponent(bad)}`,
      );
      expect(refused.status, bad).toBe(400);
      expect(refused.error?.error.code, bad).toBe("validation_error");
    }

    // Asked after the item is found, so a bad cursor on an unknown item is
    // the answer for the unknown item.
    const unknown = await client.rawRequest<unknown>(
      `/items/00000000-0000-7000-8000-000000000000/versions?cursor=not-a-cursor`,
    );
    expect(unknown.status).toBe(404);
    expect(unknown.error?.error.code).toBe("item_not_found");

    // The cursor holds a place in a history and not the item it came from.
    const across = await client.getVersions(other, { limit: 1, cursor });
    expect(across.status).toBe(200);
    expect(across.data.data.map((v) => v.version)).toEqual([2]);
  });

  it("refuses a parameter it does not declare 400 validation_error, and names it", async () => {
    const { id } = await movedRow();
    const witness = await client.getVersions(id);
    expect(witness.status).toBe(200);
    for (const target of [id, "00000000-0000-7000-8000-000000000000"]) {
      const refused = await client.rawRequest<unknown>(
        `/items/${target}/versions?limitt=2`,
      );
      expect(refused.status, target).toBe(400);
      expect(refused.error?.error.code, target).toBe("validation_error");
      expect(refused.error?.error.details?.unknown_parameters, target).toEqual([
        "limitt",
      ]);
    }
  });
});

describe("the history of a row a key may not read now", () => {
  it("answers 404 item_not_found for a row moved into a type the key cannot read, though it read the snapshots before", async () => {
    const created = await client.createItem({
      type: "core.task",
      source: ctx.source,
      properties: { title: "a task, for now" },
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    const id = created.data.item.id;
    trackItem(ctx, id);
    const edited = await client.updateItem(id, {
      properties: { title: "a task, edited" },
      version: 1,
    });
    expect(edited.status).toBe(200);

    // The witness: the snapshot is the key's to read while the row is a task.
    const before = await taskReader.getVersions(id);
    expect(before.status).toBe(200);
    expect(before.data.data.map((v) => [v.version, v.type])).toEqual([
      [1, "core.task"],
    ]);

    const moved = await client.updateItem(id, {
      type: "core.note",
      retype: true,
      properties: { title: "now a note", body: "a note body" },
      version: 2,
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);

    const after = await taskReader.getVersions(id);
    expect(after.status).toBe(404);
    expect(after.error?.error.code).toBe("item_not_found");
    const both = await client.getVersions(id);
    expect(both.data.data.map((v) => [v.version, v.type])).toEqual([
      [1, "core.task"],
      [2, "core.task"],
    ]);
  });

  it("answers 404 item_not_found for a row in the bin, and its whole history again once it is restored", async () => {
    const id = await longHistory(2);
    const before = await client.getVersions(id);
    expect(before.data.data.map((v) => v.version)).toEqual([1, 2]);

    expect((await client.deleteItem(id)).ok).toBe(true);
    const trashed = await client.getVersions(id);
    expect(trashed.status).toBe(404);
    expect(trashed.error?.error.code).toBe("item_not_found");

    expect((await client.restoreItem(id)).ok).toBe(true);
    const after = await client.getVersions(id);
    expect(after.data.data.map((v) => v.version)).toEqual([1, 2]);
  });
});

describe("a snapshot holds the row's own fields as they were", () => {
  it("names the tier, occurred_at and source_id each snapshot held, beside its type", async () => {
    const first = {
      tier: "library" as const,
      occurred_at: "2026-01-02T03:04:05.000Z",
      source_id: `snapshot-first-${ctx.runId}`,
    };
    const second = {
      tier: "feed" as const,
      occurred_at: "2026-02-03T04:05:06.000Z",
      source_id: `snapshot-second-${ctx.runId}`,
    };
    const created = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { title: "first fields", body: "a body" },
      ...first,
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    const id = created.data.item.id;
    trackItem(ctx, id);
    expect(created.data.item).toMatchObject(first);

    const moved = await client.updateItem(id, { ...second, version: 1 });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);
    expect(moved.data.item).toMatchObject(second);
    const edited = await client.updateItem(id, {
      properties: { title: "second fields" },
      version: 2,
    });
    expect(edited.status).toBe(200);

    const history = await client.getVersions(id);
    expect(history.status).toBe(200);
    await expectMatchesSchema("GET", "/items/{id}/versions", 200, history.data);
    expect(
      history.data.data.map((v) => ({
        version: v.version,
        type: v.type,
        tier: v.tier,
        occurred_at: v.occurred_at,
        source_id: v.source_id,
      })),
    ).toEqual([
      { version: 1, type: "core.note", ...first },
      { version: 2, type: "core.note", ...second },
    ]);
  });
});

describe("a write held to the reach of the snapshot it names", () => {
  /** A write that collides with nothing, so a key reading the snapshot merges it. */
  const MERGING = { properties: { notes: "added" }, version: 1 };

  const create = (sourceId: string) => ({
    type: "core.note",
    source: ctx.source,
    source_id: sourceId,
    ...MERGING,
  });

  it("leaves the row as it was when a conditional create names a snapshot the key may not read, and merges for one that may", async () => {
    const { sourceId } = await movedRow();
    const both = await client.createItem(create(sourceId));
    expect(both.status, JSON.stringify(both.error)).toBe(200);

    const { id: other, sourceId: otherSource } = await movedRow();
    const notes = await noteReader.createItem(create(otherSource));
    expect(notes.status).toBe(409);
    expect((notes.error as unknown as Refusal).error.code).toBe(
      "ancestor_unavailable",
    );
    const after = await client.getItem(other);
    expect(after.data.item.version).toBe(4);
    expect(after.data.item.properties).not.toHaveProperty("notes");
    expect(after.data.item.properties.title).toBe("a note, edited");
  });

  it("rolls a bulk page back when an entry names a snapshot the key may not read, as an atomic page does, and leaves the row as it was", async () => {
    const fresh = uuidv7();
    const entries = (sourceId: string) => [
      {
        id: fresh,
        type: "core.note",
        source: ctx.source,
        source_id: `fresh-${sourceId}`,
        properties: { title: "the entry beside it", body: "its body" },
      },
      create(sourceId),
    ];

    // The witness: a key reading the snapshot lands the merge on the same page.
    const { sourceId: readable } = await movedRow();
    const merged = await client.bulkItems({
      atomic: true,
      items: entries(readable),
    });
    expect(merged.status, JSON.stringify(merged.error)).toBe(200);
    expect(merged.data.results.map((r) => r.outcome)).toEqual([
      "created",
      "updated",
    ]);
    trackItem(ctx, fresh);

    const { id, sourceId } = await movedRow();
    const rolled = await noteReader.bulkItems({
      atomic: true,
      items: entries(sourceId).map((entry, index) =>
        index === 0 ? { ...entry, id: uuidv7() } : entry,
      ),
    });
    expect(rolled.status).toBe(409);
    expect(rolled.error?.error.code).toBe("bulk_atomic_rollback");
    expect(rolled.error?.error.details).toMatchObject({
      code: "ancestor_unavailable",
      index: 1,
    });
    expect(JSON.stringify(rolled.error)).not.toContain(taskMark);

    const after = await client.getItem(id);
    expect(after.data.item.version).toBe(4);
    expect(after.data.item.properties).not.toHaveProperty("notes");
  });

  it("leaves the row as it was when a non-atomic bulk entry names a snapshot the key may not read", async () => {
    const { id, sourceId } = await movedRow();
    const res = await noteReader.bulkItems({
      atomic: false,
      items: [create(sourceId)],
    });
    expect(res.status, JSON.stringify(res.error)).toBe(200);
    expect(res.data.results[0]).toMatchObject({
      outcome: "errored",
      error: { code: "ancestor_unavailable" },
    });
    const after = await client.getItem(id);
    expect(after.data.item.version).toBe(4);
    expect(after.data.item.properties).not.toHaveProperty("notes");
  });
});
