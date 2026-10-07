/**
 * Conformance for POST /items/bulk and POST /items/bulk-actions.
 *
 * Scope is deliberately narrow: the wire shape of each endpoint — per-item
 * outcomes, the upsert and create_only modes, atomic rollback, the per-item
 * permission gate, and the async job lifecycle behind bulk actions.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type {
  TestContext,
  MarfaItem,
  MarfaMetadata,
  BulkActionInput,
  BulkActionResponse,
  BulkActionJob,
} from "../../client/types.js";
import {
  createSecondClient,
  createTestContext,
  trackItem,
  trackEdge,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import {
  createBookmark,
  createNote,
  createTask,
  generateId,
} from "../../generators/items.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { collectUntil, withStream } from "../../utils/stream.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "bulk",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

function parseNdjson(
  raw: string,
): Array<{ item: MarfaItem; metadata: MarfaMetadata }> {
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(
      (line) =>
        JSON.parse(line) as { item: MarfaItem; metadata: MarfaMetadata },
    );
}

async function createScopedClient(
  label: string,
  typePermissions: Record<string, string>,
): Promise<MarfaClient> {
  const keyResp = await client.createKey({
    label,
    source: `${ctx.source}-${label}`,
    type_permissions: typePermissions,
  });
  expect(keyResp.ok).toBe(true);
  trackKey(ctx, keyResp.data.id);

  return new MarfaClient({
    baseUrl: apiUrl,
    apiKey: keyResp.data.key,
  });
}

describe("bulk", () => {
  it("round-trips export → bulk (create_only) with a new source_id", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await client.createItem(createNote({ source: ctx.source }));
      expect(r.ok).toBe(true);
      trackItem(ctx, r.data.item.id);
    }

    const exported = await client.exportItems({ type: "core.note" });
    expect(exported.ok).toBe(true);

    const lines = parseNdjson(exported.data);
    expect(lines.length).toBeGreaterThan(0);

    const prefix = `reimported-${ctx.runId}`;
    const bulkItems = lines.slice(0, 3).map((line, i) => ({
      type: line.item.type,
      properties: line.item.properties,
      source_id: `${prefix}-${i}`,
      tags: line.metadata.tags,
    }));

    const imported = await client.bulkItems({
      items: bulkItems,
      mode: "create_only",
    });
    expect(imported.ok).toBe(true);
    await expectMatchesSchema("POST", "/items/bulk", 200, imported.data);
    expect(imported.data.counts.created).toBe(3);
    expect(imported.data.counts.updated).toBe(0);
    expect(imported.data.results).toHaveLength(3);
    for (const r of imported.data.results) {
      expect(r.outcome).toBe("created");
      expect(r.id).toBeDefined();
    }

    const list = await client.listItems({
      type: "core.note",
      tier: "all",
      limit: 100,
    });
    expect(list.ok).toBe(true);
    const reimported = list.data.data.filter((item) =>
      (item.source_id ?? "").startsWith(prefix),
    );
    expect(reimported.length).toBe(3);
    for (const item of reimported) {
      trackItem(ctx, item.id);
    }
  });

  it("takes properties_mode on an entry as PATCH takes it, stale versions included", async () => {
    const seed = async (sourceId: string): Promise<string> => {
      const created = await client.createItem(
        createNote({
          source: ctx.source,
          source_id: sourceId,
          properties: { title: "Whole", body: "Original", notes: "Set" },
        }),
      );
      expect(created.ok).toBe(true);
      trackItem(ctx, created.data.item.id);
      return created.data.item.id;
    };
    const entry = (
      sourceId: string,
      properties: Record<string, unknown>,
      extra: { properties_mode?: "merge" | "replace"; version?: number },
    ) => ({
      items: [
        {
          type: "core.note",
          source: ctx.source,
          source_id: sourceId,
          properties,
          ...extra,
        },
      ],
      atomic: false,
    });

    // The witness: without the mode, a field the entry leaves out stays.
    const merged = `bulk-mode-merge-${ctx.runId}`;
    const mergedId = await seed(merged);
    const merge = await client.bulkItems(
      entry(merged, { body: "Original" }, {}),
    );
    expect(merge.data.results[0]!.outcome).toBe("updated");
    expect((await client.getItem(mergedId)).data.item.properties).toEqual({
      title: "Whole",
      body: "Original",
      notes: "Set",
    });

    // At the current version, `replace` takes the entry's properties whole.
    const current = `bulk-mode-current-${ctx.runId}`;
    const currentId = await seed(current);
    const replaced = await client.bulkItems(
      entry(
        current,
        { body: "Original" },
        { properties_mode: "replace", version: 1 },
      ),
    );
    expect(
      replaced.data.results[0]!.outcome,
      JSON.stringify(replaced.data),
    ).toBe("updated");
    expect((await client.getItem(currentId)).data.item.properties).toEqual({
      body: "Original",
    });

    // And refuses one that drops a field the type requires.
    const dropped = await client.bulkItems(
      entry(
        current,
        { title: "No body" },
        { properties_mode: "replace", version: 2 },
      ),
    );
    expect(dropped.data.results[0]!.outcome).toBe("errored");
    expect(dropped.data.results[0]!.error?.code).toBe("invalid_properties");

    // Stale, it clears a field nobody changed since.
    const untouched = `bulk-mode-untouched-${ctx.runId}`;
    const untouchedId = await seed(untouched);
    const moved = await client.updateItem(untouchedId, {
      properties: { title: "Server title" },
      version: 1,
    });
    expect(moved.ok).toBe(true);
    const cleared = await client.bulkItems(
      entry(
        untouched,
        { title: "Whole", body: "Original" },
        { properties_mode: "replace", version: 1 },
      ),
    );
    expect(cleared.data.results[0]!.outcome, JSON.stringify(cleared.data)).toBe(
      "updated",
    );
    expect((await client.getItem(untouchedId)).data.item.properties).toEqual({
      title: "Server title",
      body: "Original",
    });

    // And collides on one the other writer changed since, a field the type
    // requires among them, as `PATCH` answers it.
    const changed = `bulk-mode-changed-${ctx.runId}`;
    const changedId = await seed(changed);
    const other = await client.updateItem(changedId, {
      properties: { body: "Changed since" },
      version: 1,
    });
    expect(other.ok).toBe(true);
    const collided = await client.bulkItems(
      entry(
        changed,
        { title: "Whole" },
        { properties_mode: "replace", version: 1 },
      ),
    );
    expect(collided.data.results[0]!.outcome).toBe("errored");
    expect(collided.data.results[0]!.error?.code).toBe("version_conflict");
    expect((await client.getItem(changedId)).data.item.properties.body).toBe(
      "Changed since",
    );
  });

  it("upsert mode updates an existing (source, source_id) row in place", async () => {
    const sourceId = `upsert-${ctx.runId}`;
    const first = await client.bulkItems({
      items: [
        {
          type: "core.note",
          properties: { title: "initial", body: "v1" },
          source_id: sourceId,
        },
      ],
    });
    expect(first.ok).toBe(true);
    expect(first.data.counts.created).toBe(1);
    const originalId = first.data.results[0]!.id!;
    trackItem(ctx, originalId);

    const second = await client.bulkItems({
      items: [
        {
          type: "core.note",
          properties: { title: "initial", body: "v2" },
          source_id: sourceId,
        },
      ],
      mode: "upsert",
    });
    expect(second.ok).toBe(true);
    expect(second.data.counts.updated).toBe(1);
    expect(second.data.counts.created).toBe(0);
    expect(second.data.results[0]!.id).toBe(originalId);

    const getRes = await client.getItem(originalId);
    expect(getRes.ok).toBe(true);
    expect((getRes.data.item.properties as { body: string }).body).toBe("v2");
  });

  it("atomic rollback on invalid type returns 400 and leaves no rows", async () => {
    const tag = `atomic-${ctx.runId}`;
    const res = await client.bulkItems({
      items: [
        {
          type: "core.note",
          properties: { title: "good" },
          tags: [tag],
          source_id: `${tag}-good`,
        },
        {
          type: "NOT a valid type",
          properties: { title: "bad" },
          tags: [tag],
          source_id: `${tag}-bad`,
        },
      ],
      atomic: true,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.error?.error.code).toBe("bulk_atomic_rollback");

    const list = await client.listItems({ tags: [tag], tier: "all" });
    expect(list.ok).toBe(true);
    expect(list.data.data).toHaveLength(0);
  });

  it("gates bulk writes per item type, and on nothing else", async () => {
    // A key may bulk-write any type it holds write on. Bulk authorizes per
    // item rather than per caller, so nothing about the credential beyond its
    // type map is consulted. A key with write on all types succeeds.
    const writer = await createScopedClient("bulk-writer", { "*": "write" });
    const ok = await writer.bulkItems({
      items: [
        {
          type: "core.note",
          properties: { title: "permitted", body: "permitted body" },
        },
      ],
    });
    expect(ok.ok).toBe(true);
    expect(ok.data.counts.created).toBe(1);
    trackItem(ctx, ok.data.results[0]!.id!);

    // A key lacking write on core.note is denied at the per-item gate.
    // In atomic mode the batch rolls back with the inner type_not_permitted.
    const denied = await createScopedClient("bulk-denied", {
      "core.bookmark": "write",
    });
    const rejected = await denied.bulkItems({
      items: [
        {
          type: "core.note",
          properties: { title: "denied", body: "denied body" },
        },
      ],
    });
    expect(rejected.ok).toBe(false);
    // `403`, because the batch was refused for a permission the caller
    // does not hold. A client sorts refusals by status before it reads a
    // code, and a `400` filed this under "fix the request" — which is the
    // one thing the caller cannot do about it.
    expect(rejected.status).toBe(403);
    expect(rejected.error?.error.code).toBe("bulk_atomic_rollback");
    expect(rejected.error?.error.details?.code).toBe("type_not_permitted");

    // The rollback is still a rollback. A status that changed and a page
    // that landed would be worse than either.
    // Read as the owner, because the denied key may not read notes and is
    // refused the listing itself.
    const refused = await denied.listItems({ type: "core.note", limit: 5 });
    expect(refused.status).toBe(403);
    const listed = await client.listItems({
      type: "core.note",
      source: `${ctx.source}-bulk-denied`,
      limit: 5,
    });
    expect(listed.ok).toBe(true);
    expect(listed.data.data).toHaveLength(0);
  });

  it("leaves a state alone on an entry that resolves a row rather than creating one", async () => {
    // The update path never reads `state`, so an entry carrying one that
    // its type's lifecycle could not have created is a field the write it
    // describes is going to ignore. Refusing it would roll a page back
    // over nothing, which is what a create-time check moved too early
    // does: `state` is checked where an entry can only be a create.
    const sourceId = `bulk-state-upsert-${ctx.runId}`;
    const seed = await client.bulkItems({
      items: [
        {
          type: "core.note",
          source_id: sourceId,
          properties: { body: "seeded" },
        },
      ],
    });
    expect(seed.ok).toBe(true);
    trackItem(ctx, seed.data.results[0]!.id!);

    const upsert = await client.bulkItems({
      items: [
        {
          type: "core.note",
          source_id: sourceId,
          state: "revoked",
          properties: { body: "updated" },
        },
      ],
      mode: "upsert",
    });
    expect(
      upsert.ok,
      `an upsert was rolled back over a state its write ignores: ${JSON.stringify(upsert.error)}`,
    ).toBe(true);
    expect(upsert.data.counts.updated).toBe(1);

    // The witness. The same state on an entry that can only be a create —
    // no id, no natural key — is still refused, so the check moved rather
    // than went.
    const created = await client.bulkItems({
      items: [
        { type: "core.note", state: "revoked", properties: { body: "new" } },
      ],
    });
    expect(created.ok).toBe(false);
    expect(created.error?.error.details?.code).toBe("validation_error");
  });

  it("answers a rollback at the status of the refusal inside it", async () => {
    // A page refused over its own body stays at 400, the witness that the
    // status follows the inner refusal rather than being moved off 400 for
    // every rollback.
    const rejected = await client.bulkItems({
      items: [
        {
          type: "acme.not-registered",
          properties: { title: "unknown type" },
        },
      ],
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.status).toBe(400);
    expect(rejected.error?.error.code).toBe("bulk_atomic_rollback");
    expect(rejected.error?.error.details?.code).toBe("unknown_type");

    // A missing row is 404: an entry linking to an item nothing holds.
    const missingTarget = await client.bulkItems({
      items: [
        {
          type: "core.note",
          properties: { title: "links to nothing", body: "body" },
          edges: { about: ["00000000-0000-7000-8000-000000000000"] },
        },
      ],
    });
    expect(missingTarget.status).toBe(404);
    expect(missingTarget.error?.error.code).toBe("bulk_atomic_rollback");
    expect(missingTarget.error?.error.details?.code).toBe("item_not_found");

    // A row that moved on is 409: an entry based on a version since
    // overtaken.
    const sourceId = `bulk-rollback-status-${ctx.runId}`;
    const seeded = await client.createItem(
      createNote({ source: ctx.source, source_id: sourceId }),
    );
    expect(seeded.ok).toBe(true);
    trackItem(ctx, seeded.data.item.id);
    const stale = seeded.data.item.version;
    const moved = await client.updateItem(seeded.data.item.id, {
      properties: { title: "moved on" },
      version: stale,
    });
    expect(moved.ok).toBe(true);
    const overtaken = await client.bulkItems({
      items: [
        {
          type: "core.note",
          source: ctx.source,
          source_id: sourceId,
          properties: { title: "from a stale writer" },
          version: stale,
        },
      ],
    });
    expect(overtaken.status).toBe(409);
    expect(overtaken.error?.error.code).toBe("bulk_atomic_rollback");
    expect(overtaken.error?.error.details?.code).toBe("version_conflict");
  });

  it("create_only skips a repeated (source, source_id) as duplicate_source", async () => {
    const sourceId = `create-only-${ctx.runId}`;
    const entry = {
      type: "core.note",
      properties: { title: "create_only", body: "first" },
      source_id: sourceId,
    };

    const first = await client.bulkItems({
      items: [entry],
      mode: "create_only",
    });
    expect(first.ok).toBe(true);
    expect(first.data.counts.created).toBe(1);
    const originalId = first.data.results[0]!.id!;
    trackItem(ctx, originalId);

    const second = await client.bulkItems({
      items: [
        { ...entry, properties: { title: "create_only", body: "second" } },
      ],
      mode: "create_only",
    });
    expect(second.ok).toBe(true);
    expect(second.data.counts.skipped).toBe(1);
    expect(second.data.counts.created).toBe(0);
    expect(second.data.counts.updated).toBe(0);
    expect(second.data.results).toHaveLength(1);
    expect(second.data.results[0]!.outcome).toBe("skipped");
    expect(second.data.results[0]!.reason).toBe("duplicate_source");
    expect(second.data.results[0]!.id).toBe(originalId);

    const stored = await client.getItem(originalId);
    expect(stored.ok).toBe(true);
    expect((stored.data.item.properties as { body: string }).body).toBe(
      "first",
    );
  });

  it("create_only skips an entry naming a held id as duplicate_id, live or in the bin, and writes nothing", async () => {
    const seeded = await client.createItem(
      createNote({ source: ctx.source, source_id: `by-id-${ctx.runId}` }),
    );
    expect(seeded.ok).toBe(true);
    const live = seeded.data.item;
    trackItem(ctx, live.id);
    const binned = await client.createItem(createNote({ source: ctx.source }));
    expect(binned.ok).toBe(true);
    trackItem(ctx, binned.data.item.id);
    expect((await client.deleteItem(binned.data.item.id)).ok).toBe(true);

    const result = await client.bulkItems({
      mode: "create_only",
      items: [
        {
          id: live.id,
          type: "core.note",
          properties: { title: "overwrites", body: "overwrites" },
        },
        {
          id: binned.data.item.id,
          type: "core.note",
          properties: { title: "overwrites", body: "overwrites" },
        },
        // The natural key resolves a row first, so the id beside it is not
        // asked about.
        {
          id: binned.data.item.id,
          type: "core.note",
          source: ctx.source,
          source_id: `by-id-${ctx.runId}`,
          properties: { title: "overwrites", body: "overwrites" },
        },
        // The witness: an id nothing holds is created, so the skips above are
        // the id's and not a door that skips everything.
        {
          type: "core.note",
          source: ctx.source,
          properties: { title: "new", body: "new" },
        },
      ],
    });
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    expect(result.data.counts).toMatchObject({
      skipped: 3,
      created: 1,
      updated: 0,
      errored: 0,
    });
    const [onLive, onBinned, onKey, onNew] = result.data.results;
    expect(onLive).toMatchObject({
      outcome: "skipped",
      reason: "duplicate_id",
      id: live.id,
    });
    expect(onBinned).toMatchObject({
      outcome: "skipped",
      reason: "duplicate_id",
      id: binned.data.item.id,
    });
    expect(onKey).toMatchObject({
      outcome: "skipped",
      reason: "duplicate_source",
      id: live.id,
    });
    // A reason belongs to a skip: the entry that was written carries none.
    expect(onNew?.outcome).toBe("created");
    expect(onNew).not.toHaveProperty("reason");
    trackItem(ctx, onNew!.id!);

    const kept = await client.getItem(live.id);
    expect(kept.ok).toBe(true);
    expect(kept.data.item.version).toBe(live.version);
    expect(kept.data.item.properties).toEqual(live.properties);

    // Neither an update nor an errored entry carries one.
    const written = await client.bulkItems({
      atomic: false,
      items: [
        {
          type: "core.note",
          source: ctx.source,
          source_id: `by-id-${ctx.runId}`,
          properties: { title: "updated", body: "updated" },
        },
        { type: "no.such.type", properties: { title: "x" } },
      ],
    });
    expect(written.ok, JSON.stringify(written.error)).toBe(true);
    expect(written.data.results.map((entry) => entry.outcome)).toEqual([
      "updated",
      "errored",
    ]);
    for (const entry of written.data.results) {
      expect(entry).not.toHaveProperty("reason");
    }
  });

  it("acknowledges an upsert entry naming the id of an item in the bin, and refuses one of another type", async () => {
    const created = await client.createItem(
      createNote({ source: ctx.source, properties: { body: "binned" } }),
    );
    expect(created.status).toBe(201);
    const id = created.data.item.id;
    trackItem(ctx, id);
    expect((await client.deleteItem(id)).ok).toBe(true);

    // The witness: the single create acknowledges the same id.
    const single = await client.createItem(
      createNote({ id, source: ctx.source, properties: { body: "again" } }),
    );
    expect(single.status, JSON.stringify(single.error)).toBe(200);
    expect(single.data.acknowledged).toBe(true);

    const upserted = await client.bulkItems({
      items: [createNote({ id, properties: { body: "again" } })],
    });
    expect(upserted.status, JSON.stringify(upserted.error)).toBe(200);
    expect(upserted.data.results[0]).toMatchObject({
      outcome: "skipped",
      id,
      reason: "trashed",
    });

    const otherType = await client.bulkItems({
      items: [{ id, type: "core.task", properties: { title: "again" } }],
      atomic: false,
    });
    expect(otherType.status).toBe(200);
    expect(otherType.data.results[0]).toMatchObject({
      outcome: "errored",
      error: { code: "id_reused" },
    });

    const binned = await client.listItems({
      state: "trashed",
      source: ctx.source,
      limit: 100,
    });
    const row = binned.data.data.find((item) => item.id === id);
    expect(row?.properties.body).toBe("binned");
  });

  it("reads a natural key over trashed rows, as the single create does", async () => {
    const sourceId = `trashed-${ctx.runId}`;
    const created = await client.createItem({
      type: "core.note",
      properties: { title: "trashed", body: "before the bin" },
      source_id: sourceId,
    });
    expect(created.status, JSON.stringify(created.error)).toBe(201);
    const id = created.data.item.id;
    trackItem(ctx, id);
    expect((await client.deleteItem(id)).ok).toBe(true);
    const binnedRow = async () => {
      const binned = await client.listItems({
        state: "trashed",
        source: ctx.source,
        limit: 100,
      });
      expect(binned.ok, JSON.stringify(binned.error)).toBe(true);
      return binned.data.data.find((item) => item.id === id);
    };
    const before = await binnedRow();
    expect(before, "the deleted row is not in the bin").toBeDefined();
    const entry = {
      type: "core.note",
      properties: { title: "trashed", body: "a re-sync" },
      source_id: sourceId,
    };

    // The single create's answer: the trashed row, acknowledged, and
    // nothing written.
    const single = await client.createItem(entry);
    expect(single.status, JSON.stringify(single.error)).toBe(200);
    expect(single.data.acknowledged).toBe(true);
    expect(single.data.item.id).toBe(id);

    // The same entry through the bulk door, atomic by default: the page
    // lands, and the entry is the trashed row, left as it is.
    const upserted = await client.bulkItems({ items: [entry] });
    expect(
      upserted.status,
      `the bulk door did not find the trashed row by its natural key, so a re-sync of one deleted row rolls the whole page back: ${JSON.stringify(upserted.error)}`,
    ).toBe(200);
    expect(upserted.data.results[0]).toMatchObject({
      outcome: "skipped",
      id,
      reason: "trashed",
    });
    await expectMatchesSchema("POST", "/items/bulk", 200, upserted.data);

    // And under create_only it is a repeated pair like any other.
    const repeated = await client.bulkItems({
      items: [entry],
      mode: "create_only",
    });
    expect(repeated.status, JSON.stringify(repeated.error)).toBe(200);
    expect(repeated.data.results[0]).toMatchObject({
      outcome: "skipped",
      id,
      reason: "duplicate_source",
    });

    // Nothing was written to the row, and it is still in the bin.
    const after = await binnedRow();
    expect(after?.version, "an acknowledgment wrote to the trashed row").toBe(
      before?.version,
    );
    expect((after?.properties as { body?: string } | undefined)?.body).toBe(
      "before the bin",
    );
  });

  it("atomic=false keeps the good entry and errors the unregistered type", async () => {
    const unregistered = `user.bulk-unregistered-${ctx.runId}`;
    const res = await client.bulkItems({
      items: [
        {
          type: "core.note",
          properties: { title: "good", body: "good body" },
          source_id: `mixed-good-${ctx.runId}`,
        },
        {
          type: unregistered,
          properties: { title: "bad" },
          source_id: `mixed-bad-${ctx.runId}`,
        },
      ],
      atomic: false,
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.data.counts.created).toBe(1);
    expect(res.data.counts.errored).toBe(1);
    expect(res.data.results).toHaveLength(2);

    expect(res.data.results[0]!.outcome).toBe("created");
    const goodId = res.data.results[0]!.id!;
    trackItem(ctx, goodId);

    expect(res.data.results[1]!.outcome).toBe("errored");
    expect(res.data.results[1]!.error?.code).toBe("unknown_type");
    expect(res.data.results[1]!.id).toBeUndefined();

    const stored = await client.getItem(goodId);
    expect(stored.ok).toBe(true);
    expect(stored.data.item.source_id).toBe(`mixed-good-${ctx.runId}`);
  });

  it("writes nothing for a best-effort entry whose edge target is missing", async (context) => {
    // The edge step is the last of an entry's writes, and a child syncing
    // before its parent meets it in ordinary use: the entry is reported
    // errored, so its row must not have landed either. The entry after it is
    // the stream's sentinel, and its row is the witness that this page writes.
    const phantom = `bulk-edge-phantom-${ctx.runId}`;
    const sentinel = `bulk-edge-sentinel-${ctx.runId}`;
    await withStream(apiUrl, apiKey, {}, async (stream) => {
      await new Promise((r) => setTimeout(r, 250));
      const res = await client.bulkItems({
        atomic: false,
        items: [
          {
            type: "core.note",
            properties: { body: phantom },
            source: ctx.source,
            source_id: phantom,
            edges: { "parent-of": [generateId()] },
          },
          {
            type: "core.note",
            properties: { body: sentinel },
            source: ctx.source,
            source_id: sentinel,
          },
        ],
      });
      expect(res.status, JSON.stringify(res.error)).toBe(200);
      expect(res.data.results[0]?.outcome).toBe("errored");
      expect(res.data.results[0]?.id).toBeUndefined();
      expect(res.data.results[1]?.outcome).toBe("created");
      const sentinelId = res.data.results[1]!.id!;
      trackItem(ctx, sentinelId);
      const { raw } = await collectUntil(
        stream,
        (events) =>
          events.some(
            (e) =>
              (e.data as { item?: { id?: string } } | undefined)?.item?.id ===
              sentinelId,
          ),
        "the sentinel entry to reach the stream",
        context.signal,
      );
      expect(raw).not.toContain(phantom);
    });
    const found = await client.lookupItems({
      type: "core.note",
      source: ctx.source,
      source_ids: [phantom, sentinel],
    });
    expect(found.status, JSON.stringify(found.error)).toBe(200);
    expect(found.data.data.map((item) => item.source_id)).toEqual([sentinel]);
  });

  it("purge is refused to a key holding no permissions", async () => {
    const label = `bulk-purge-noperms-${ctx.runId}`;
    const keyResp = await client.createKey({
      label,
      source: `${ctx.source}-${label}`,
      type_permissions: { "*": "write" },
      permissions: [],
    });
    expect(keyResp.ok).toBe(true);
    trackKey(ctx, keyResp.data.id);
    const scoped = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    const tag = `ba-purge-noperms-${ctx.runId}`;
    const seeded = await client.createItem(
      createNote({ source: ctx.source, tags: [tag], tier: "library" }),
    );
    expect(seeded.ok).toBe(true);
    trackItem(ctx, seeded.data.item.id);

    const res = await scoped.bulkAction({
      action: "purge",
      confirm: "PURGE",
      filter: { tags: [tag] },
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(res.error?.error.code).toBe("forbidden");
    expect(res.error?.error.details?.required_scope).toBe("items.purge");

    const survivor = await client.getItem(seeded.data.item.id);
    expect(survivor.ok).toBe(true);
  });
});

describe("bulk_action time filters", () => {
  /**
   * Presence of a field in the client type is not the property worth
   * asserting, so this narrows a real match set: two items are seeded, one is
   * bounded out, and the assertion is which ids come back.
   */
  it("narrows a match set by the item's own time", async () => {
    const tag = `ba-time-${ctx.runId}`;
    const old = await client.createItem(
      createNote({
        source: ctx.source,
        tags: [tag],
        tier: "library",
        occurred_at: "2020-01-01T00:00:00.000Z",
      }),
    );
    expect(old.ok).toBe(true);
    trackItem(ctx, old.data.item.id);

    const recent = await client.createItem(
      createNote({
        source: ctx.source,
        tags: [tag],
        tier: "library",
        occurred_at: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(recent.ok).toBe(true);
    trackItem(ctx, recent.data.item.id);

    // The control: unbounded, both rows are in the match set. Without it a
    // bounded run returning one row says nothing about the bound.
    const unbounded = await client.bulkAction({
      action: "update_tags",
      add: [`${tag}-probe`],
      filter: { tags: [tag] },
      dry_run: true,
    });
    expect(unbounded.ok).toBe(true);
    expect((unbounded.data as BulkActionResponse).ids?.sort()).toEqual(
      [old.data.item.id, recent.data.item.id].sort(),
    );

    const bounded = await client.bulkAction({
      action: "update_tags",
      add: [`${tag}-probe`],
      filter: { tags: [tag], occurred_after: "2023-01-01T00:00:00.000Z" },
      dry_run: true,
    });
    expect(bounded.ok).toBe(true);
    const boundedResult = bounded.data as BulkActionResponse;
    expect(boundedResult.ids).toEqual([recent.data.item.id]);
    expect(boundedResult.ids).not.toContain(old.data.item.id);

    const upperBounded = await client.bulkAction({
      action: "update_tags",
      add: [`${tag}-probe`],
      filter: { tags: [tag], occurred_before: "2023-01-01T00:00:00.000Z" },
      dry_run: true,
    });
    expect(upperBounded.ok).toBe(true);
    expect((upperBounded.data as BulkActionResponse).ids).toEqual([
      old.data.item.id,
    ]);
  });

  it("refuses a filter field it does not declare, naming it", async () => {
    const tag = `ba-undeclared-${ctx.runId}`;
    await seedTagged(1, tag);

    // A dropped filter field here is not a narrower match set but every row
    // the credential can see, so the door refuses rather than strips.
    for (const undeclared of ["since", "until", "occurred_at_after"]) {
      const res = await client.bulkAction({
        action: "update_tags",
        add: ["probe"],
        dry_run: true,
        // Deliberately off-type: the client type does not offer these
        // fields, and the point is that the wire refuses them.
        filter: { [undeclared]: "2023-01-01T00:00:00.000Z" } as never,
      });
      expect(res.status).toBe(400);
      expect(res.error?.error.details?.unknown_filter_fields).toEqual([
        undeclared,
      ]);
    }
  });
});

async function seedTagged(count: number, tag: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = await client.createItem(
      createNote({ source: ctx.source, tags: [tag], tier: "library" }),
    );
    expect(r.ok).toBe(true);
    trackItem(ctx, r.data.item.id);
    ids.push(r.data.item.id);
  }
  return ids;
}

/** Queue an action, poll its job to completion, and return the result. */
async function runToCompletion(
  input: BulkActionInput,
): Promise<BulkActionResponse> {
  const res = await client.bulkAction(input);
  expect(res.status).toBe(202);
  const queued = res.data as BulkActionJob;
  expect(queued.status).toBe("queued");
  const final = await client.pollBulkActionToTerminal(queued.id);
  expect(final.status).toBe("completed");
  expect(final.result).toBeDefined();
  return final.result!;
}

describe("bulk_action", () => {
  it("transition archives every match (async job path)", async () => {
    const tag = `ba-trans-${ctx.runId}`;
    const ids = await seedTagged(3, tag);

    const result = await runToCompletion({
      action: "transition",
      state: "archived",
      filter: { tags: [tag] },
    });
    expect(result.succeeded).toBe(3);
    expect(result.errored).toBe(0);

    for (const id of ids) {
      const got = await client.getItem(id);
      expect(got.ok).toBe(true);
      expect(got.data.item.state).toBe("archived");
    }
  });

  it("restores a row and what its trash took in one transition, counting each row once", async () => {
    // Restoring the parent brings the other two back before the job reaches them.
    const tag = `ba-restore-${ctx.runId}`;
    const [grandchild, child, parent] = await seedTagged(3, tag);
    for (const [source_id, target_id] of [
      [parent!, child!],
      [child!, grandchild!],
    ]) {
      const edge = await client.createEdge({
        source_id,
        target_id,
        edge_type: "parent-of",
      });
      expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
      trackEdge(ctx, edge.data.edge.id);
    }
    expect((await client.deleteItem(parent!)).ok).toBe(true);
    // The witnesses: the parent's trash took the other two, and the job
    // reaches the parent before either.
    for (const id of [child!, grandchild!]) {
      expect((await client.getItem(id)).status).toBe(404);
    }
    const planned = await client.bulkAction({
      action: "transition",
      state: "active",
      filter: { tags: [tag], state: "trashed" },
      dry_run: true,
    });
    expect((planned.data as BulkActionResponse).ids?.[0]).toBe(parent);

    const result = await runToCompletion({
      action: "transition",
      state: "active",
      filter: { tags: [tag], state: "trashed" },
    });
    expect(result.matched).toBe(3);
    expect(
      [result.succeeded, result.errored],
      `a row the parent's restore brought back was moved again or counted twice: ${JSON.stringify(result.errors)}`,
    ).toEqual([3, 0]);
    for (const id of [parent!, child!, grandchild!]) {
      const got = await client.getItem(id);
      expect(got.status).toBe(200);
      expect(got.data.item.state).toBe("active");
    }
  });

  it("purge deletes matching items (with confirm)", async () => {
    const tag = `ba-purge-${ctx.runId}`;
    const ids = await seedTagged(3, tag);
    for (const id of ids) {
      expect((await client.deleteItem(id)).ok).toBe(true);
    }

    const result = await runToCompletion({
      action: "purge",
      confirm: "PURGE",
      filter: { tags: [tag], state: "trashed" },
    });
    expect(result.succeeded).toBe(3);
    // Three notes, no blobs: the count is the purge's report of what it
    // would have orphaned, and zero is the answer it has to give.
    expect(result.blob_hashes_referenced).toBe(0);

    const got = await client.getItem(ids[0]!);
    expect(got.status).toBe(404);
  });

  it("purge leaves a match that is not in the trash, and reports it invalid_transition", async () => {
    const tag = `ba-purge-active-${ctx.runId}`;
    const [active] = await seedTagged(1, tag);

    const result = await runToCompletion({
      action: "purge",
      confirm: "PURGE",
      filter: { tags: [tag] },
    });
    // The witness: the filter reached the row.
    expect(result.matched).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.errored).toBe(1);
    expect(result.errors).toEqual([
      expect.objectContaining({ id: active, code: "invalid_transition" }),
    ]);
    const got = await client.getItem(active!);
    expect(got.status).toBe(200);
    expect(got.data.item.state).toBe("active");
  });

  it("reports a refused row in a job's errors and goes on to the next", async () => {
    const tag = `ba-continue-${ctx.runId}`;
    const [first] = await seedTagged(1, tag);
    // A bookmark's `url` must be a string, so the patch below refuses it and
    // takes the notes on either side of it.
    const bookmark = await client.createItem(
      createBookmark({ source: ctx.source, tags: [tag] }),
    );
    expect(bookmark.status).toBe(201);
    trackItem(ctx, bookmark.data.item.id);
    const [last] = await seedTagged(1, tag);

    const result = await runToCompletion({
      action: "update_properties",
      patch: { url: 7 },
      filter: { tags: [tag] },
    });
    expect(result.matched).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.errors).toEqual([
      expect.objectContaining({
        id: bookmark.data.item.id,
        code: "invalid_properties",
      }),
    ]);
    for (const id of [first!, last!]) {
      expect((await client.getItem(id)).data.item.properties.url).toBe(7);
    }
    expect(
      (await client.getItem(bookmark.data.item.id)).data.item.properties.url,
    ).toBe("https://example.com/article");
  });

  it("purge without confirm returns 400 bulk_confirmation_required", async () => {
    const tag = `ba-purge-confirm-${ctx.runId}`;
    await seedTagged(1, tag);

    const res = await client.bulkAction({
      action: "purge",
      filter: { tags: [tag] },
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.error?.error.code).toBe("bulk_confirmation_required");
  });

  it("dry_run stays synchronous and returns matched ids without mutating", async () => {
    const tag = `ba-dry-${ctx.runId}`;
    const ids = await seedTagged(2, tag);

    const res = await client.bulkAction({
      action: "transition",
      state: "archived",
      filter: { tags: [tag] },
      dry_run: true,
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    const result = res.data as BulkActionResponse;
    expect(result.dry_run).toBe(true);
    expect(result.matched).toBe(2);
    expect(result.succeeded).toBe(0);
    expect(result.ids?.sort()).toEqual(ids.slice().sort());

    const got = await client.getItem(ids[0]!);
    expect(got.ok).toBe(true);
    expect(got.data.item.state).toBe("active");
  });

  it("update_tags adds and removes", async () => {
    const tag = `ba-tags-${ctx.runId}`;
    const ids = await seedTagged(2, tag);

    const result = await runToCompletion({
      action: "update_tags",
      add: [`${tag}-added`],
      remove: [tag],
      filter: { tags: [tag] },
    });
    expect(result.succeeded).toBe(2);

    const got = await client.getItem(ids[0]!);
    expect(got.ok).toBe(true);
    expect(got.data.metadata.tags).toContain(`${tag}-added`);
    expect(got.data.metadata.tags).not.toContain(tag);
  });

  it("update_tier and update_properties both land", async () => {
    // Combined: both actions are one item update each.
    const tag = `ba-tier-${ctx.runId}`;
    const ids = await seedTagged(1, tag);

    const tier = await runToCompletion({
      action: "update_tier",
      tier: "feed",
      filter: { tags: [tag] },
    });
    expect(tier.succeeded).toBe(1);

    const props = await runToCompletion({
      action: "update_properties",
      patch: { extra_bulk_field: "patched" },
      filter: { tags: [tag] },
    });
    expect(props.succeeded).toBe(1);

    const got = await client.getItem(ids[0]!);
    expect(got.ok).toBe(true);
    expect(got.data.item.tier).toBe("feed");
    expect(
      (got.data.item.properties as { extra_bulk_field?: string })
        .extra_bulk_field,
    ).toBe("patched");
  });

  it("update_occurred_at overrides the item's own time", async () => {
    const tag = `ba-ts-${ctx.runId}`;
    const ids = await seedTagged(1, tag);
    const newTs = "2001-09-11T08:46:00.000Z";

    const result = await runToCompletion({
      action: "update_occurred_at",
      occurred_at: newTs,
      filter: { tags: [tag] },
    });
    expect(result.succeeded).toBe(1);

    const got = await client.getItem(ids[0]!);
    expect(got.ok).toBe(true);
    expect(got.data.item.occurred_at).toBe(newTs);
  });
});

describe("bulk_action async-job lifecycle", () => {
  it("POST returns 202 with a queued envelope; status terminates completed", async () => {
    const tag = `ba-lifecycle-${ctx.runId}`;
    await seedTagged(2, tag);

    const post = await client.bulkAction({
      action: "transition",
      state: "archived",
      filter: { tags: [tag] },
    });
    expect(post.ok).toBe(true);
    expect(post.status).toBe(202);
    await expectMatchesSchema("POST", "/items/bulk-actions", 202, post.data);
    const queued = post.data as BulkActionJob;
    expect(queued.id).toBeTruthy();
    expect(queued.status).toBe("queued");
    expect(queued.matched).toBe(2);

    const final = await client.pollBulkActionToTerminal(queued.id);
    expect(final.status).toBe("completed");
    expect(final.matched).toBe(2);
    expect(final.succeeded).toBe(2);
    expect(final.result?.action).toBe("transition");

    const status = await client.bulkActionStatus(queued.id);
    expect(status.ok).toBe(true);
    await expectMatchesSchema(
      "GET",
      "/items/bulk-actions/jobs/{id}",
      200,
      status.data,
    );
    expect(status.data.id).toBe(queued.id);
  });

  it("GET on an unknown id returns 404 bulk_job_not_found", async () => {
    const res = await client.bulkActionStatus(`baj-doesnt-exist-${ctx.runId}`);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.error?.error.code).toBe("bulk_job_not_found");
  });

  it("cancel on a terminal job answers 200 with its final state unchanged", async () => {
    // The worker takes a job the moment it is queued and a local run of a
    // few hundred rows completes before a second request can land, so the
    // queued and in-flight cancellations are not reachable over the wire.
    // What is reachable is the door's answer once the job is terminal.
    const tag = `ba-cancel-${ctx.runId}`;
    await seedTagged(5, tag);
    const post = await client.bulkAction({
      action: "transition",
      state: "archived",
      filter: { tags: [tag] },
    });
    expect(post.status).toBe(202);
    const queued = post.data as BulkActionJob;
    const final = await client.pollBulkActionToTerminal(queued.id);
    expect(final.status).toBe("completed");

    const del = await client.bulkActionCancel(queued.id);
    expect(del.status).toBe(200);
    await expectMatchesSchema(
      "POST",
      "/items/bulk-actions/jobs/{id}/cancel",
      200,
      del.data,
    );
    expect(del.data.status).toBe("completed");
    expect(del.data.finished_at).toBe(final.finished_at);
    expect(del.data.succeeded).toBe(final.succeeded);
  });

  it("refuses another credential reading or canceling the job, 403 forbidden", async () => {
    const tag = `ba-owner-${ctx.runId}`;
    await seedTagged(1, tag);
    const post = await client.bulkAction({
      action: "transition",
      state: "archived",
      filter: { tags: [tag] },
    });
    expect(post.status).toBe(202);
    const queued = post.data as BulkActionJob;
    await client.pollBulkActionToTerminal(queued.id);

    const other = await createSecondClient(ctx, "bulk-other");
    const read = await other.bulkActionStatus(queued.id);
    expect(read.status).toBe(403);
    expect(read.error?.error.code).toBe("forbidden");
    await expectMatchesSchema(
      "GET",
      "/items/bulk-actions/jobs/{id}",
      403,
      read.error,
    );
    const cancel = await other.bulkActionCancel(queued.id);
    expect(cancel.status).toBe(403);
    expect(cancel.error?.error.code).toBe("forbidden");
    await expectMatchesSchema(
      "POST",
      "/items/bulk-actions/jobs/{id}/cancel",
      403,
      cancel.error,
    );
  });

  it("cancel on an unknown id returns 404 bulk_job_not_found", async () => {
    const res = await client.bulkActionCancel(`baj-doesnt-exist-${ctx.runId}`);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.error?.error.code).toBe("bulk_job_not_found");
  });

  it("Idempotency-Key returns the same job id on replay", async () => {
    const tag = `ba-idem-${ctx.runId}`;
    await seedTagged(2, tag);
    const key = `idem-${ctx.runId}-${Math.random().toString(36).slice(2, 8)}`;

    const first = await client.bulkAction(
      {
        action: "transition",
        state: "archived",
        filter: { tags: [tag] },
      },
      { idempotencyKey: key },
    );
    expect(first.ok).toBe(true);
    expect(first.status).toBe(202);
    const firstJobId = (first.data as BulkActionJob).id;

    const replay = await client.bulkAction(
      {
        action: "transition",
        state: "archived",
        filter: { tags: [tag] },
      },
      { idempotencyKey: key },
    );
    expect(replay.ok).toBe(true);
    expect((replay.data as BulkActionJob).id).toBe(firstJobId);
    expect(first.headers.get("Idempotency-Replayed")).toBeNull();
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  });

  it("refuses a different request under a key already used", async () => {
    const tag = `ba-idem-reuse-${ctx.runId}`;
    await seedTagged(1, tag);
    const key = `idem-reuse-${ctx.runId}-${Math.random().toString(36).slice(2, 8)}`;

    const first = await client.bulkAction(
      { action: "update_tags", add: [`${tag}-once`], filter: { tags: [tag] } },
      { idempotencyKey: key },
    );
    expect(first.status).toBe(202);

    const different = await client.bulkAction(
      { action: "update_tags", add: [`${tag}-twice`], filter: { tags: [tag] } },
      { idempotencyKey: key },
    );
    expect(different.status).toBe(422);
    expect(different.error?.error.code).toBe("idempotency_key_reused");
  });

  it("runs another credential's own job under a key this one used, and never hands it this job", async () => {
    // The first credential's job matches tasks the second may not read; the
    // second, reusing the key for its own notes, is answered about its own
    // request.
    const key = `idem-cross-${ctx.runId}-${Math.random().toString(36).slice(2, 8)}`;
    const taskTag = `ba-idem-cross-task-${ctx.runId}`;
    const task = await client.createItem(
      createTask({ source: ctx.source, tags: [taskTag], tier: "library" }),
    );
    expect(task.ok).toBe(true);
    trackItem(ctx, task.data.item.id);
    const theirs = await client.bulkAction(
      {
        action: "update_tags",
        add: [`${taskTag}-done`],
        filter: { tags: [taskTag] },
      },
      { idempotencyKey: key },
    );
    expect(theirs.status).toBe(202);
    const theirJob = theirs.data as BulkActionJob;

    const noteOnly = await createScopedClient(`idem-cross-${ctx.runId}`, {
      "core.note": "write",
    });
    const noteTag = `ba-idem-cross-note-${ctx.runId}`;
    const note = await noteOnly.createItem(
      createNote({
        source: `${ctx.source}-idem-cross-${ctx.runId}`,
        tags: [noteTag],
        tier: "library",
      }),
    );
    expect(note.ok).toBe(true);
    trackItem(ctx, note.data.item.id);

    const mine = await noteOnly.bulkAction(
      {
        action: "update_tags",
        add: [`${noteTag}-done`],
        filter: { tags: [noteTag] },
      },
      { idempotencyKey: key },
    );
    expect(mine.status).toBe(202);
    expect(mine.headers.get("Idempotency-Replayed")).toBeNull();
    const myJob = mine.data as BulkActionJob;
    expect(myJob.id).not.toBe(theirJob.id);
    expect(myJob.matched).toBe(1);

    const final = await noteOnly.pollBulkActionToTerminal(myJob.id);
    expect(final.status).toBe("completed");
    const metadata = await noteOnly.getMetadata(note.data.item.id);
    expect(metadata.data.metadata.tags).toContain(`${noteTag}-done`);
  });

  it("tells a reused id from a mistaken declaration, as the single-item doors do", async () => {
    // The code a batched write gets must not depend on its being batched.
    // An entry whose own `id` resolves a row of another type is the
    // reused-id mistake and answers `id_reused`; one whose natural key
    // resolves a row of another type is the declaration mistake and
    // answers `type_mismatch`. Both travel in `details.code` here,
    // because the page rolls back under the default `atomic`.
    const byId = await client.createItem(createNote({ source: ctx.source }));
    expect(byId.ok).toBe(true);
    trackItem(ctx, byId.data.item.id);

    const reusedId = await client.bulkItems({
      items: [
        {
          id: byId.data.item.id,
          type: "core.task",
          properties: { title: "landed on a note by id" },
        },
      ],
    });
    expect(reusedId.status).toBe(409);
    expect(reusedId.error?.error.code).toBe("bulk_atomic_rollback");
    expect(reusedId.error?.error.details?.code).toBe("id_reused");

    const sourceId = `bulk-retype-${ctx.runId}`;
    const byKey = await client.createItem(
      createNote({ source: ctx.source, source_id: sourceId }),
    );
    expect(byKey.ok).toBe(true);
    trackItem(ctx, byKey.data.item.id);

    const mistakenDeclaration = await client.bulkItems({
      items: [
        {
          type: "core.task",
          source_id: sourceId,
          properties: { title: "landed on a note by natural key" },
        },
      ],
    });
    expect(mistakenDeclaration.status).toBe(409);
    expect(mistakenDeclaration.error?.error.details?.code).toBe(
      "type_mismatch",
    );

    // The witness for both: the same two entries declaring the rows' own
    // type land, so each refusal is the type rather than the door.
    const accepted = await client.bulkItems({
      items: [
        {
          id: byId.data.item.id,
          type: "core.note",
          properties: { body: "by id" },
        },
        {
          type: "core.note",
          source_id: sourceId,
          properties: { body: "by natural key" },
        },
      ],
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.data.counts.updated).toBe(2);
  });
});
