import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type {
  ApiResponse,
  MarfaItem,
  TestContext,
  Tombstone,
} from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  getOperatorClient,
  trackEdge,
  trackItem,
  trackKey,
} from "../../utils/setup.js";
import { itemsArchive } from "../../utils/archive.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

// A type's link and the tombstones a purge leaves, so a connector finds its
// rows without reading its type and never brings back a row a person purged.

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let linked: string;
/** A second type naming the same field as its link, for moves between the two. */
let other: string;
/** A subtype of `linked`, which does not inherit its link. */
let child: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext("compliance", "links"));
  linked = `user.linked-${ctx.runId}`;
  other = `user.linked-other-${ctx.runId}`;
  child = `user.linked-child-${ctx.runId}`;
  for (const [id, parent] of [
    [linked, undefined],
    [other, undefined],
  ] as const) {
    const registered = await client.registerType({
      id,
      ...(parent === undefined ? {} : { parent }),
      fields: {
        vendor_id: { type: "string" },
        title: { type: "string" },
      },
      link_field: "vendor_id",
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
  }
  const sub = await client.registerType({
    id: child,
    parent: linked,
    fields: { extra: { type: "string" } },
  });
  expect(sub.ok, JSON.stringify(sub.error)).toBe(true);
});

afterAll(async () => {
  await cleanup(ctx);
});

async function create(
  properties: Record<string, unknown>,
  extra: { type?: string; source_id?: string; state?: string } = {},
): Promise<ApiResponse<{ item: MarfaItem }>> {
  const created = await client.createItem({
    type: extra.type ?? linked,
    source: ctx.source,
    properties,
    ...(extra.source_id !== undefined && { source_id: extra.source_id }),
    ...(extra.state !== undefined && { state: extra.state }),
  });
  if (created.ok) trackItem(ctx, created.data.item.id);
  return created;
}

async function row(
  properties: Record<string, unknown>,
  extra: { type?: string; source_id?: string; state?: string } = {},
): Promise<MarfaItem> {
  const created = await create(properties, extra);
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  return created.data.item;
}

/** A value unique to this run, so no other file's rows hold it. */
const v = (name: string): string => `${name}-${ctx.runId}`;

function expectTaken(
  res: ApiResponse<unknown>,
  holder: string,
  value: string,
): void {
  expect(res.status, JSON.stringify(res.error)).toBe(409);
  expect(res.error?.error.code).toBe("link_taken");
  expect(res.error?.error.details).toMatchObject({
    existing_id: holder,
    field: "vendor_id",
    value,
  });
}

async function purge(id: string): Promise<void> {
  expect((await client.deleteItem(id)).ok).toBe(true);
  const purged = await client.purgeItem(id);
  expect(purged.ok, JSON.stringify(purged.error)).toBe(true);
}

async function tombstonesByLink(
  values: string[],
  type = linked,
): Promise<Tombstone[]> {
  const found = await client.lookupItems({ type, links: values });
  expect(found.ok, JSON.stringify(found.error)).toBe(true);
  return found.data.tombstones;
}

describe("a type's link", () => {
  it("declares a link and answers it on the type, not on a subtype", async () => {
    const read = await client.getType(linked);
    expect(read.ok).toBe(true);
    expect(read.data.link_field).toBe("vendor_id");
    const sub = await client.getType(child);
    expect(sub.ok).toBe(true);
    // The witness: the subtype inherits the field, and not the link.
    expect(sub.data.fields.vendor_id).toBeDefined();
    expect(sub.data.link_field).toBeUndefined();

    const value = v("inherit");
    const parentRow = await row({ vendor_id: value });
    await row({ vendor_id: value }, { type: child });
    expectTaken(await create({ vendor_id: value }), parentRow.id, value);

    const own = `user.linked-own-${ctx.runId}`;
    const named = await client.registerType({
      id: own,
      parent: linked,
      fields: {},
      link_field: "vendor_id",
    });
    expect(named.ok, JSON.stringify(named.error)).toBe(true);
    expect((await client.getType(own)).data.link_field).toBe("vendor_id");
  });

  it("refuses a link that is not a string field the type declares or inherits", async () => {
    const id = `user.linked-refused-${ctx.runId}`;
    const fields = {
      vendor_id: { type: "string" },
      count: { type: "integer" },
      home: { type: "url" },
    };
    for (const link_field of [42, "missing", "count", "home"]) {
      const refused = await client.rawRequest<unknown>("/types", {
        method: "POST",
        body: { id, fields, link_field },
      });
      expect(refused.status, `link_field ${String(link_field)}`).toBe(400);
      expect(refused.error?.error.code).toBe("invalid_schema");
      const errors = refused.error?.error.details?.errors as
        { field: string }[] | undefined;
      expect(errors?.map((e) => e.field)).toContain("link_field");
    }
    expect((await client.getType(id)).status).toBe(404);
    // The witness: the same body naming the string field registers.
    const registered = await client.registerType({
      id,
      fields: fields as never,
      link_field: "vendor_id",
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
  });

  it("holds the rows a type already has to a link it gains", async () => {
    const id = `user.linked-gains-${ctx.runId}`;
    const schema = {
      fields: { vendor_id: { type: "string" }, title: { type: "string" } },
    };
    expect((await client.registerType({ id, ...schema } as never)).ok).toBe(
      true,
    );
    const value = v("gains");
    const live = await row({ vendor_id: value }, { type: id });
    const binned = await row({ vendor_id: value }, { type: id });
    expect((await client.deleteItem(binned.id)).ok).toBe(true);

    const unbumped = await client.updateType(id, {
      ...schema,
      version: 1,
      link_field: "vendor_id",
    });
    expect(unbumped.status).toBe(422);
    expect(unbumped.error?.error.code).toBe("version_bump_mismatch");

    const shared = await client.updateType(id, {
      ...schema,
      version: 2,
      link_field: "vendor_id",
    });
    expect(shared.status).toBe(409);
    expect(shared.error?.error.code).toBe("link_taken");
    expect(shared.error?.error.details).toEqual({
      type: id,
      field: "vendor_id",
    });
    expect((await client.getType(id)).data.link_field).toBeUndefined();

    const moved = await client.updateItem(live.id, {
      properties: { vendor_id: v("gains-moved") },
      version: live.version,
    });
    expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
    const gained = await client.updateType(id, {
      ...schema,
      version: 2,
      link_field: "vendor_id",
    });
    expect(gained.ok, JSON.stringify(gained.error)).toBe(true);
    expect((await client.getType(id)).data.link_field).toBe("vendor_id");
    // The row in the bin holds the value it had before the link was named.
    expectTaken(
      await create({ vendor_id: value }, { type: id }),
      binned.id,
      value,
    );
  });
});

describe("a link is one row's", () => {
  it("refuses a second row a link another holds, on a create and a natural-key upsert", async () => {
    const value = v("create");
    const holder = await row({ vendor_id: value });
    expectTaken(await create({ vendor_id: value }), holder.id, value);
    // The witness: another value lands.
    await row({ vendor_id: v("create-other") });
    // An empty string is not a link, and neither is its absence.
    await row({ vendor_id: "" });
    await row({ vendor_id: "" });
    await row({ title: "no link" });
    await row({ title: "no link" });

    const keyed = await row(
      { vendor_id: v("upsert") },
      { source_id: v("upsert-key") },
    );
    const refused = await client.createItem({
      type: linked,
      source: ctx.source,
      source_id: v("upsert-key"),
      properties: { vendor_id: value },
    });
    expectTaken(refused, holder.id, value);
    expect(
      (await client.getItem(keyed.id)).data.item.properties.vendor_id,
    ).toBe(v("upsert"));
    const own = await client.createItem({
      type: linked,
      source: ctx.source,
      source_id: v("upsert-key"),
      properties: { vendor_id: v("upsert"), title: "its own link again" },
    });
    expect(own.status, JSON.stringify(own.error)).toBe(200);
  });

  it("holds a trashed row's link against every other row", async () => {
    const trashedValue = v("trashed");
    const trashed = await row({ vendor_id: trashedValue });
    expect((await client.deleteItem(trashed.id)).ok).toBe(true);
    expectTaken(
      await create({ vendor_id: trashedValue }),
      trashed.id,
      trashedValue,
    );

    const archivedValue = v("archived");
    const archived = await row({ vendor_id: archivedValue });
    expect((await client.transitionItem(archived.id, "archived")).ok).toBe(
      true,
    );
    expectTaken(
      await create({ vendor_id: archivedValue }),
      archived.id,
      archivedValue,
    );

    // Restored, it still holds the value, and nothing else claimed it.
    expect((await client.restoreItem(trashed.id)).ok).toBe(true);
    expectTaken(
      await create({ vendor_id: trashedValue }),
      trashed.id,
      trashedValue,
    );
  });

  it("refuses a link on an update, in either mode and at a stale version", async () => {
    const taken = v("update-held");
    const holder = await row({ vendor_id: taken });
    const mine = await row({ vendor_id: v("update-mine"), title: "t" });

    expectTaken(
      await client.updateItem(mine.id, {
        properties: { vendor_id: taken },
        version: 1,
      }),
      holder.id,
      taken,
    );
    expectTaken(
      await client.updateItem(mine.id, {
        properties: { vendor_id: taken, title: "t" },
        properties_mode: "replace",
        version: 1,
      }),
      holder.id,
      taken,
    );
    const untouched = await client.getItem(mine.id);
    expect(untouched.data.item.version).toBe(1);
    expect(untouched.data.item.properties.vendor_id).toBe(v("update-mine"));

    const moved = await client.updateItem(mine.id, {
      properties: { title: "moved on" },
      version: 1,
    });
    expect(moved.ok).toBe(true);
    // Stale: the write names version 1 and merges onto version 2.
    expectTaken(
      await client.updateItem(mine.id, {
        properties: { vendor_id: taken },
        version: 1,
      }),
      holder.id,
      taken,
    );
    const merged = await client.updateItem(mine.id, {
      properties: { vendor_id: v("update-free") },
      version: 1,
    });
    expect(merged.ok, JSON.stringify(merged.error)).toBe(true);
    expect(merged.data.item.properties).toMatchObject({
      vendor_id: v("update-free"),
      title: "moved on",
    });
  });

  it("frees a link its row clears or changes", async () => {
    const first = v("free-first");
    const holder = await row({ vendor_id: first, title: "t" });
    expectTaken(await create({ vendor_id: first }), holder.id, first);

    const second = v("free-second");
    const changed = await client.updateItem(holder.id, {
      properties: { vendor_id: second },
      version: 1,
    });
    expect(changed.ok).toBe(true);
    await row({ vendor_id: first });
    expectTaken(await create({ vendor_id: second }), holder.id, second);

    const cleared = await client.updateItem(holder.id, {
      properties: { title: "t" },
      properties_mode: "replace",
      version: 2,
    });
    expect(cleared.ok).toBe(true);
    await row({ vendor_id: second });
  });

  it("holds a retype to the type's links and frees the link a row takes away", async () => {
    const value = v("retype");
    const holder = await row({ vendor_id: value });
    const elsewhere = await row({ vendor_id: value }, { type: other });
    expectTaken(
      await client.updateItem(elsewhere.id, {
        type: linked,
        retype: true,
        version: 1,
      }),
      holder.id,
      value,
    );
    expect((await client.getItem(elsewhere.id)).data.item.type).toBe(other);

    const leaving = v("retype-leaving");
    const mover = await row({ vendor_id: leaving });
    const moved = await client.updateItem(mover.id, {
      type: other,
      retype: true,
      version: 1,
    });
    expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
    await row({ vendor_id: leaving });
    expectTaken(
      await create({ vendor_id: leaving }, { type: other }),
      mover.id,
      leaving,
    );
  });

  it("refuses a bulk entry a link another row holds, on both halves", async () => {
    const taken = v("bulk-held");
    const holder = await row({ vendor_id: taken });
    const page = await client.bulkItems({
      atomic: false,
      items: [
        {
          type: linked,
          source: ctx.source,
          source_id: v("bulk-a"),
          properties: { vendor_id: taken },
        },
        {
          type: linked,
          source: ctx.source,
          source_id: v("bulk-b"),
          properties: { vendor_id: v("bulk-b") },
        },
      ],
    });
    expect(page.ok, JSON.stringify(page.error)).toBe(true);
    const [refused, landed] = page.data.results;
    expect(refused?.outcome).toBe("errored");
    expect(refused?.error?.code).toBe("link_taken");
    expect(refused?.error?.details?.existing_id).toBe(holder.id);
    expect(landed?.outcome).toBe("created");
    if (landed?.id) trackItem(ctx, landed.id);

    const update = await client.bulkItems({
      atomic: false,
      items: [
        {
          type: linked,
          source: ctx.source,
          source_id: v("bulk-b"),
          properties: { vendor_id: taken },
        },
      ],
    });
    expect(update.ok).toBe(true);
    const [entry] = update.data.results;
    expect(entry?.outcome).toBe("errored");
    expect(entry?.id).toBe(landed?.id);
    expect(entry?.error?.code).toBe("link_taken");

    const atomic = await client.bulkItems({
      items: [
        {
          type: linked,
          source: ctx.source,
          source_id: v("bulk-c"),
          properties: { vendor_id: v("bulk-c") },
        },
        {
          type: linked,
          source: ctx.source,
          source_id: v("bulk-d"),
          properties: { vendor_id: taken },
        },
      ],
    });
    expect(atomic.status).toBe(400);
    expect(atomic.error?.error.code).toBe("bulk_atomic_rollback");
    expect(atomic.error?.error.details?.code).toBe("link_taken");
    const none = await client.lookupItems({
      type: linked,
      links: [v("bulk-c")],
    });
    expect(none.data.data).toEqual([]);
  });

  it("leaves the link off a keep-both copy of a row", async () => {
    const id = `user.linked-copies-${ctx.runId}`;
    const registered = await client.registerType({
      id,
      fields: { vendor_id: { type: "string" }, notes: { type: "string" } },
      link_field: "vendor_id",
      merge_policy: { fields: { notes: "keep_both_copies" } },
    } as never);
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    const value = v("copied");
    const original = await row(
      { vendor_id: value, notes: "as written" },
      { type: id },
    );
    expect(
      (
        await client.updateItem(original.id, {
          properties: { notes: "changed here" },
          version: 1,
        })
      ).ok,
    ).toBe(true);
    const resolved = await client.rawRequest<{
      conflict_resolution?: { conflicted_copy_id?: string };
    }>(`/items/${original.id}?conflict=auto`, {
      method: "PATCH",
      body: { properties: { notes: "changed there" }, version: 1 },
    });
    expect(resolved.ok, JSON.stringify(resolved.error)).toBe(true);
    const copyId = resolved.data.conflict_resolution?.conflicted_copy_id ?? "";
    trackItem(ctx, copyId);
    const copy = await client.getItem(copyId);
    // The witness: the copy carries the losing value, and not the link.
    expect(copy.data.item.properties.notes).toBe("changed there");
    expect(copy.data.item.properties).not.toHaveProperty("vendor_id");
    const held = await client.lookupItems({ type: id, links: [value] });
    expect(held.data.data.map((i) => i.id)).toEqual([original.id]);
  });

  it("counts an archived row whose link another row holds as a duplicate", async () => {
    const operator = getOperatorClient();
    const taken = v("archive-held");
    const holder = await row({ vendor_id: taken, title: "the live row" });
    const duplicate = uuidv7();
    const refused = await operator.restoreArchive(
      itemsArchive([
        {
          id: duplicate,
          type: linked,
          source: ctx.source,
          properties: { vendor_id: taken, title: "the archived row" },
        },
      ]),
    );
    expect(refused.ok, JSON.stringify(refused.error)).toBe(true);
    expect(refused.data).toMatchObject({ imported: 0, duplicates: 1 });
    expect((await client.getItem(duplicate)).status).toBe(404);
    expect((await client.getItem(holder.id)).data.item.properties.title).toBe(
      "the live row",
    );

    // The witness: the same row under a value nothing holds is restored.
    const fresh = uuidv7();
    const restored = await operator.restoreArchive(
      itemsArchive([
        {
          id: fresh,
          type: linked,
          source: ctx.source,
          properties: { vendor_id: v("archive-free") },
        },
      ]),
    );
    expect(restored.ok, JSON.stringify(restored.error)).toBe(true);
    trackItem(ctx, fresh);
    expect(restored.data).toMatchObject({ imported: 1, duplicates: 0 });
  });
});

describe("a purge's tombstones", () => {
  it("leaves a tombstone for a purged row's link and natural key", async () => {
    const link = v("purged");
    const key = v("purged-key");
    const target = await row({ vendor_id: link }, { source_id: key });
    const before = new Date().toISOString();
    expect((await client.deleteItem(target.id)).ok).toBe(true);
    // The witness: a trashed row still holds its link, and leaves nothing.
    const binned = await client.lookupItems({ type: linked, links: [link] });
    expect(binned.data.data.map((i) => i.state)).toEqual(["trashed"]);
    expect(binned.data.tombstones).toEqual([]);

    const purged = await client.purgeItem(target.id);
    expect(purged.ok).toBe(true);
    const after = new Date().toISOString();

    const byLink = await client.lookupItems({ type: linked, links: [link] });
    expect(byLink.data.data).toEqual([]);
    expect(byLink.data.tombstones).toHaveLength(1);
    const [tombstone] = byLink.data.tombstones;
    expect(tombstone?.key).toBe(link);
    const purgedAt = tombstone?.purged_at ?? "";
    expect(purgedAt >= before && purgedAt <= after, purgedAt).toBe(true);
    expect(tombstone?.remembered_until).toBe(purgedAt);

    const byKey = await client.lookupItems({
      type: linked,
      source: ctx.source,
      source_ids: [key],
    });
    expect(byKey.data.data).toEqual([]);
    expect(byKey.data.tombstones).toEqual([
      { key, purged_at: purgedAt, remembered_until: purgedAt },
    ]);
  });

  it("leaves tombstones from the bulk purge action", async () => {
    const link = v("bulk-purged");
    const target = await row({ vendor_id: link });
    const tag = v("bulk-purge-tag");
    expect((await client.addTags(target.id, [tag])).ok).toBe(true);
    expect((await client.deleteItem(target.id)).ok).toBe(true);
    expect(await tombstonesByLink([link])).toEqual([]);

    const queued = await client.bulkAction({
      action: "purge",
      confirm: "PURGE",
      filter: { tags: [tag], state: "trashed" },
    });
    expect(queued.status, JSON.stringify(queued.error)).toBe(202);
    const job = await client.pollBulkActionToTerminal(
      (queued.data as { id: string }).id,
    );
    expect(job.status).toBe("completed");
    expect((await tombstonesByLink([link])).map((t) => t.key)).toEqual([link]);
  });

  it("removes a tombstone when a row holds its key again", async () => {
    const link = v("reclaimed");
    const key = v("reclaimed-key");
    const target = await row({ vendor_id: link }, { source_id: key });
    await purge(target.id);
    expect(await tombstonesByLink([link])).toHaveLength(1);
    const byKey = { type: linked, source: ctx.source, source_ids: [key] };
    expect((await client.lookupItems(byKey)).data.tombstones).toHaveLength(1);

    const again = await row({ vendor_id: link });
    const found = await client.lookupItems({ type: linked, links: [link] });
    expect(found.data.data.map((i) => i.id)).toEqual([again.id]);
    expect(found.data.tombstones).toEqual([]);

    // A natural key held again by a row of another type is held all the same.
    const note = await row(
      { body: "holds the key now" },
      { type: "core.note", source_id: key },
    );
    const held = await client.lookupItems(byKey);
    expect(held.data.data.map((i) => i.id)).toEqual([note.id]);
    expect(held.data.tombstones).toEqual([]);
  });

  it("takes a type's tombstones with it when the type is deleted", async () => {
    const id = `user.linked-gone-${ctx.runId}`;
    const schema = {
      id,
      fields: { vendor_id: { type: "string" } },
      link_field: "vendor_id",
    };
    expect((await client.registerType(schema as never)).ok).toBe(true);
    const link = v("gone");
    const key = v("gone-key");
    const target = await row({ vendor_id: link }, { type: id, source_id: key });
    await purge(target.id);
    expect(await tombstonesByLink([link], id)).toHaveLength(1);

    expect((await client.deleteType(id)).ok).toBe(true);
    const again = await client.registerType(schema as never);
    expect(again.ok, JSON.stringify(again.error)).toBe(true);
    expect(await tombstonesByLink([link], id)).toEqual([]);
    const byKey = await client.lookupItems({
      type: id,
      source: ctx.source,
      source_ids: [key],
    });
    expect(byKey.data.tombstones).toEqual([]);
  });
});

describe("POST /items/tombstones", () => {
  it("moves remembered_until later, never earlier", async () => {
    const link = v("remembered");
    const key = v("remembered-key");
    const target = await row({ vendor_id: link }, { source_id: key });
    await purge(target.id);
    const [tombstone] = await tombstonesByLink([link]);
    const purgedAt = Date.parse(tombstone?.purged_at ?? "");
    const at = (hours: number) =>
      new Date(purgedAt + hours * 3_600_000).toISOString();

    const later = await client.extendTombstones({
      type: linked,
      links: [link, v("remembered-none")],
      remembered_until: at(2),
    });
    expect(later.ok, JSON.stringify(later.error)).toBe(true);
    await expectMatchesSchema("POST", "/items/tombstones", 200, later.data);
    expect(later.data.tombstones).toEqual([
      { key: link, purged_at: tombstone?.purged_at, remembered_until: at(2) },
    ]);

    for (const earlier of [at(1), at(-1)]) {
      const kept = await client.extendTombstones({
        type: linked,
        links: [link],
        remembered_until: earlier,
      });
      expect(kept.ok).toBe(true);
      expect(kept.data.tombstones[0]?.remembered_until).toBe(at(2));
    }
    // An offset is the same instant, answered in the stored spelling.
    const offset = await client.extendTombstones({
      type: linked,
      links: [link],
      remembered_until: at(3).replace("Z", "+00:00"),
    });
    expect(offset.data.tombstones[0]?.remembered_until).toBe(at(3));
    expect((await tombstonesByLink([link]))[0]?.remembered_until).toBe(at(3));

    const byKey = await client.extendTombstones({
      type: linked,
      source: ctx.source,
      source_ids: [key],
      remembered_until: at(4),
    });
    expect(byKey.data.tombstones).toEqual([
      { key, purged_at: tombstone?.purged_at, remembered_until: at(4) },
    ]);
  });

  it("refuses to move a tombstone to a key that may only read the type", async () => {
    const link = v("read-only");
    const target = await row({ vendor_id: link });
    await purge(target.id);
    const [tombstone] = await tombstonesByLink([link]);
    const later = new Date(
      Date.parse(tombstone?.purged_at ?? "") + 3_600_000,
    ).toISOString();

    const minted = await client.createKey({
      label: `links-reader-${ctx.runId}`,
      source: `${ctx.source}-reader`,
      type_permissions: { [linked]: "read" },
    });
    expect(minted.ok).toBe(true);
    trackKey(ctx, minted.data.id);
    const reader = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });

    const refused = await reader.extendTombstones({
      type: linked,
      links: [link],
      remembered_until: later,
    });
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("type_not_permitted");
    // The reader reads the tombstone, and it has not moved.
    const read = await reader.lookupItems({ type: linked, links: [link] });
    expect(read.data.tombstones).toEqual([tombstone]);

    // The witness: the writer moves it.
    const moved = await client.extendTombstones({
      type: linked,
      links: [link],
      remembered_until: later,
    });
    expect(moved.data.tombstones[0]?.remembered_until).toBe(later);
  });

  it("refuses a malformed tombstone request", async () => {
    const when = new Date().toISOString();
    const post = (body: Record<string, unknown>) =>
      client.rawRequest<unknown>("/items/tombstones", { method: "POST", body });
    const refusals: [Record<string, unknown>, number, string][] = [
      [{ links: ["x"], remembered_until: when }, 400, "missing_required_field"],
      [{ type: linked, links: ["x"] }, 400, "missing_required_field"],
      [{ type: linked, remembered_until: when }, 400, "validation_error"],
      [
        {
          type: linked,
          links: ["x"],
          source: ctx.source,
          source_ids: ["x"],
          remembered_until: when,
        },
        400,
        "validation_error",
      ],
      [
        { type: linked, source: ctx.source, remembered_until: when },
        400,
        "validation_error",
      ],
      [
        { type: linked, links: ["x"], remembered_until: "tomorrow" },
        400,
        "validation_error",
      ],
      [
        { type: linked, ids: [uuidv7()], remembered_until: when },
        400,
        "validation_error",
      ],
      [
        { type: "core.note", links: ["x"], remembered_until: when },
        400,
        "validation_error",
      ],
      [
        {
          type: `user.nothing-${ctx.runId}`,
          links: ["x"],
          remembered_until: when,
        },
        400,
        "unknown_type",
      ],
      [
        {
          type: linked,
          links: Array.from({ length: 501 }, (_, i) => `x${String(i)}`),
          remembered_until: when,
        },
        400,
        "validation_error",
      ],
    ];
    for (const [body, status, code] of refusals) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body).slice(0, 200)).toBe(status);
      expect(res.error?.error.code, JSON.stringify(body).slice(0, 200)).toBe(
        code,
      );
    }
    // The witness: a well-formed request naming 500 values is answered.
    const full = await post({
      type: linked,
      links: Array.from({ length: 500 }, (_, i) => `x${String(i)}`),
      remembered_until: when,
    });
    expect(full.status).toBe(200);
  });
});

describe("POST /items/lookup", () => {
  it("looks rows up by link in every state, and refuses links for a type naming none", async () => {
    const active = await row({ vendor_id: v("look-active") });
    const archived = await row({ vendor_id: v("look-archived") });
    expect((await client.transitionItem(archived.id, "archived")).ok).toBe(
      true,
    );
    const trashed = await row({ vendor_id: v("look-trashed") });
    expect((await client.deleteItem(trashed.id)).ok).toBe(true);
    // A subtype's row holding a value is not a row of the type.
    await row({ vendor_id: v("look-active") }, { type: child });

    const found = await client.lookupItems({
      type: linked,
      links: [
        v("look-trashed"),
        v("look-active"),
        v("look-archived"),
        v("look-active"),
        v("look-nothing"),
      ],
    });
    expect(found.ok, JSON.stringify(found.error)).toBe(true);
    await expectMatchesSchema("POST", "/items/lookup", 200, found.data);
    expect(Object.keys(found.data).sort()).toEqual(["data", "tombstones"]);
    expect(found.data.data.map((i) => [i.id, i.state])).toEqual([
      [trashed.id, "trashed"],
      [active.id, "active"],
      [archived.id, "archived"],
    ]);
    expect(found.data.tombstones).toEqual([]);

    const refused = await client.lookupItems({
      type: "core.note",
      links: [v("look-active")],
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
  });

  it("looks rows up by natural key whatever their type", async () => {
    const kept = await row(
      { vendor_id: v("nk-kept") },
      { source_id: v("nk-1") },
    );
    const note = await row(
      { body: "a note under the same source" },
      { type: "core.note", source_id: v("nk-2") },
    );
    const moved = await row(
      { vendor_id: v("nk-moved") },
      { source_id: v("nk-3") },
    );
    expect(
      (
        await client.updateItem(moved.id, {
          type: other,
          retype: true,
          version: 1,
        })
      ).ok,
    ).toBe(true);
    expect((await client.deleteItem(kept.id)).ok).toBe(true);

    const found = await client.lookupItems({
      type: linked,
      source: ctx.source,
      source_ids: [v("nk-2"), v("nk-1"), v("nk-3"), v("nk-none")],
    });
    expect(found.ok, JSON.stringify(found.error)).toBe(true);
    expect(found.data.data.map((i) => [i.id, i.type, i.state])).toEqual([
      [note.id, "core.note", "active"],
      [kept.id, linked, "trashed"],
      [moved.id, other, "active"],
    ]);
    expect(found.data.tombstones).toEqual([]);
  });

  it("looks rows up by id in every state, where bulk-get leaves the bin out", async () => {
    const live = await row({ vendor_id: v("id-live") });
    const binned = await row({ body: "in the bin" }, { type: "core.note" });
    expect((await client.deleteItem(binned.id)).ok).toBe(true);

    const found = await client.lookupItems({
      type: linked,
      ids: [binned.id, live.id, binned.id, uuidv7()],
    });
    expect(found.ok, JSON.stringify(found.error)).toBe(true);
    expect(found.data.data.map((i) => [i.id, i.state])).toEqual([
      [binned.id, "trashed"],
      [live.id, "active"],
    ]);
    expect(found.data.tombstones).toEqual([]);
    const got = await client.bulkGet([binned.id, live.id]);
    expect(got.data.items.map((i) => i.id)).toEqual([live.id]);

    const malformed = await client.lookupItems({
      type: linked,
      ids: ["not-an-id"],
    });
    expect(malformed.status).toBe(400);
    expect(malformed.error?.error.code).toBe("invalid_id");
  });

  it("hydrates edges on a lookup as the listing does", async () => {
    const value = v("edges");
    const from = await row({ vendor_id: value });
    const to = await row({ body: "the edge's target" }, { type: "core.note" });
    const edge = await client.createEdge({
      source_id: from.id,
      target_id: to.id,
      edge_type: "about",
    });
    expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
    trackEdge(ctx, edge.data.edge.id);

    const bare = await client.lookupItems({ type: linked, links: [value] });
    expect(bare.data.data[0]).not.toHaveProperty("edges");
    const hydrated = await client.lookupItems({
      type: linked,
      links: [value],
      include: ["edges"],
    });
    expect(hydrated.ok).toBe(true);
    await expectMatchesSchema("POST", "/items/lookup", 200, hydrated.data);
    const listed = await client.listItems({
      type: linked,
      source: ctx.source,
      include: "edges",
      limit: 200,
    });
    const listedRow = listed.data.data.find((i) => i.id === from.id);
    expect(listedRow?.edges?.about?.data.map((e) => e.target_id)).toEqual([
      to.id,
    ]);
    expect(hydrated.data.data[0]?.edges).toEqual(listedRow?.edges);
  });

  it("leaves out a row the key may not read, and answers tombstones only to a key that may read the type", async () => {
    const link = v("unread");
    const key = v("unread-key");
    const kept = await row({ vendor_id: link }, { source_id: key });
    const note = await row(
      { body: "readable" },
      { type: "core.note", source_id: v("unread-note") },
    );
    const gone = v("unread-gone");
    const purged = await row(
      { vendor_id: gone },
      { source_id: v("unread-gone-key") },
    );
    await purge(purged.id);

    const minted = await client.createKey({
      label: `links-notes-${ctx.runId}`,
      source: `${ctx.source}-notes`,
      type_permissions: { "core.note": "read" },
    });
    expect(minted.ok).toBe(true);
    trackKey(ctx, minted.data.id);
    const notes = new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });

    const selector = {
      type: linked,
      source: ctx.source,
      source_ids: [key, v("unread-note"), v("unread-gone-key")],
    };
    const mine = await client.lookupItems(selector);
    expect(mine.data.data.map((i) => i.id)).toEqual([kept.id, note.id]);
    expect(mine.data.tombstones.map((t) => t.key)).toEqual([
      v("unread-gone-key"),
    ]);
    const theirs = await notes.lookupItems(selector);
    expect(theirs.ok, JSON.stringify(theirs.error)).toBe(true);
    expect(theirs.data.data.map((i) => i.id)).toEqual([note.id]);
    expect(theirs.data.tombstones).toEqual([]);

    const byLink = { type: linked, links: [link, gone] };
    expect((await client.lookupItems(byLink)).data.tombstones).toHaveLength(1);
    expect(await notes.lookupItems(byLink)).toMatchObject({
      status: 200,
      data: { data: [], tombstones: [] },
    });

    // A key whose map reaches no type is refused rather than answered empty.
    const operator = getOperatorClient();
    const none = await operator.lookupItems(byLink);
    expect(none.status).toBe(403);
    expect(none.error?.error.code).toBe("type_not_permitted");
  });

  it("refuses a lookup naming no selector, two, or more than 500 values", async () => {
    const post = (body: Record<string, unknown>) =>
      client.rawRequest<unknown>("/items/lookup", { method: "POST", body });
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => `v${String(i)}`);
    const refusals: [Record<string, unknown>, string][] = [
      [{ links: ["x"] }, "missing_required_field"],
      [{ type: linked }, "validation_error"],
      [{ type: linked, links: ["x"], ids: [uuidv7()] }, "validation_error"],
      [{ type: linked, source: ctx.source }, "validation_error"],
      [{ type: linked, source_ids: ["x"] }, "validation_error"],
      [{ type: linked, links: [""] }, "validation_error"],
      [{ type: linked, links: many(501) }, "validation_error"],
      [{ type: linked, links: ["x"], lnks: ["x"] }, "validation_error"],
      [
        { type: linked, links: ["x"], include: ["metadata"] },
        "validation_error",
      ],
      [{ type: "Not A Type", links: ["x"] }, "validation_error"],
      [{ type: `user.nothing-${ctx.runId}`, links: ["x"] }, "unknown_type"],
    ];
    for (const [body, code] of refusals) {
      const res = await post(body);
      const label = JSON.stringify(body).slice(0, 200);
      expect(res.status, label).toBe(400);
      expect(res.error?.error.code, label).toBe(code);
    }
    const capped = await post({ type: linked, links: many(501) });
    expect(capped.error?.error.details).toMatchObject({
      cap: 500,
      provided: 501,
    });
    // The witness: 500 values are answered.
    const full = await post({ type: linked, links: many(500) });
    expect(full.status).toBe(200);
  });
});
