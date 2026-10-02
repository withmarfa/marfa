import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
let ctx: TestContext;

/** A value only the snapshots written while the row was a task hold. */
let taskMark: string;

beforeAll(async () => {
  let apiUrl: string;
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
