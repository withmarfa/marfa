import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  trackEdgeType,
  cleanup,
} from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import {
  detectSyncCapabilities,
  requireRule,
  trackSourceScopedItems,
} from "./capabilities.js";
import type { SyncCapabilities } from "./capabilities.js";

/**
 * "Fields that do not collide merge on their own": a conflict is resolved by
 * the server, in the server's transaction, by the type's policy.
 *
 * The half this rule turns on is `keep_both_copies`. Two clients editing
 * different fields already merge, and the correctness suite covers that along
 * with the 409 envelope a `manual` resolution needs — none of which is
 * repeated here. What changes under this rule is who creates the sibling. A
 * client that has to create it makes two writes where the server makes one,
 * and there is no arrangement of two writes that is atomic: a queue that dies
 * between them leaves the conflicted copy unwritten and the original already
 * moved on, so the losing edit is gone with nothing recording that it existed.
 * Every engine then needs its own resolution code, and the two drift.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let caps: SyncCapabilities;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "sync",
    "conflict",
  ));
  caps = await detectSyncCapabilities({ client, ctx, apiUrl, apiKey });
});

afterAll(async () => {
  await cleanup(ctx);
});

describe("the server resolves a conflict", () => {
  it("gives the conflicted copy the original's tags and every edge a second copy may hold", async () => {
    requireRule(caps, "serverSideMerge");

    const make = async (title: string, tags?: string[]) => {
      const r = await client.createItem(
        createNote({
          source: ctx.source,
          properties: { title, body: `${title} body` },
          ...(tags !== undefined && { tags }),
        }),
      );
      expect(r.ok).toBe(true);
      trackItem(ctx, r.data.item.id);
      return r.data.item;
    };
    const tag = `kept-${ctx.runId}`;
    const original = await make("original", [tag]);
    const parent = await make("parent");
    const child = await make("child");
    const topic = await make("topic");
    const successor = await make("successor");
    const older = await make("older");
    const link = async (
      source_id: string,
      target_id: string,
      edge_type: string,
    ) => {
      const r = await client.createEdge({ source_id, target_id, edge_type });
      expect(r.ok, edge_type).toBe(true);
    };
    await link(parent.id, original.id, "parent-of");
    await link(original.id, child.id, "parent-of");
    await link(original.id, topic.id, "about");
    await link(successor.id, original.id, "supersedes");
    await link(original.id, older.id, "supersedes");

    const base = original.version;
    expect(
      (
        await client.updateItem(original.id, {
          properties: { body: "linked body from the winner" },
          version: base,
        })
      ).ok,
    ).toBe(true);
    const resolved = await client.rawRequest<{
      conflict_resolution?: { conflicted_copy_id?: string };
    }>(`/items/${original.id}?conflict=auto`, {
      method: "PATCH",
      body: {
        properties: { body: "linked body from the loser" },
        version: base,
      },
    });
    expect(resolved.ok).toBe(true);
    await trackSourceScopedItems({ client, ctx });
    const copy = resolved.data.conflict_resolution?.conflicted_copy_id;
    expect(copy, "no conflicted copy was written").toBeTruthy();

    const meta = await client.getMetadata(copy!);
    expect(meta.ok).toBe(true);
    expect(meta.data.metadata.tags.sort()).toEqual(
      [tag, "conflicted-copy"].sort(),
    );

    const out = await client.listItemEdges(copy!);
    const back = await client.listItemBackrefs(copy!);
    expect(out.ok && back.ok).toBe(true);
    const outbound = out.data.data.map((e) => `${e.edge_type}>${e.target_id}`);
    const inbound = back.data.data.map((e) => `${e.source_id}>${e.edge_type}`);
    // Its place under the same parent, and what it is about.
    expect(inbound).toContain(`${parent.id}>parent-of`);
    expect(outbound).toContain(`about>${topic.id}`);
    // Not the original's children, each of which has one parent, and not a
    // supersedes, which is one-to-one at both ends. The witness: the
    // original still holds both.
    expect(outbound).not.toContain(`parent-of>${child.id}`);
    expect(inbound).not.toContain(`${successor.id}>supersedes`);
    // Its own file writes the supersedes it draws, and the type's
    // cardinality still keeps it off the copy.
    expect(outbound).not.toContain(`supersedes>${older.id}`);
    const originalOut = await client.listItemEdges(original.id);
    const originalBack = await client.listItemBackrefs(original.id);
    expect(originalOut.data.data.map((e) => e.target_id)).toContain(child.id);
    expect(originalOut.data.data.map((e) => e.target_id)).toContain(older.id);
    expect(originalBack.data.data.map((e) => e.source_id)).toContain(
      successor.id,
    );
  });

  it("gives the conflicted copy no edge its writer could not have made, and none to a row in the bin", async () => {
    requireRule(caps, "serverSideMerge");

    // The writer may write notes and the edges below, and only read
    // bookmarks: a bookmark's edge is one it could not have made itself.
    const keyResp = await client.createKey({
      label: "conflict-copy-narrow",
      source: `${ctx.source}-narrow`,
      permissions: [],
      type_permissions: { "core.note": "write", "core.bookmark": "read" },
      edge_permissions: { "parent-of": "write", about: "write" },
    });
    expect(keyResp.ok, JSON.stringify(keyResp.error)).toBe(true);
    trackKey(ctx, keyResp.data.id);
    const narrow = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    const make = async (type: string, title: string) => {
      const r = await client.createItem({
        type,
        source: ctx.source,
        properties:
          type === "core.bookmark"
            ? { title, url: "https://example.com/" }
            : { title, body: `${title} body` },
      });
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
      trackItem(ctx, r.data.item.id);
      return r.data.item;
    };
    const original = await make("core.note", "narrow original");
    const noteParent = await make("core.note", "note parent");
    const bookmarkRow = await make("core.bookmark", "bookmark");
    const binned = await make("core.note", "binned topic");
    const link = async (
      source_id: string,
      target_id: string,
      edge_type: string,
    ) => {
      const r = await client.createEdge({ source_id, target_id, edge_type });
      expect(r.ok, edge_type).toBe(true);
    };
    await link(noteParent.id, original.id, "parent-of");
    await link(bookmarkRow.id, original.id, "about");
    await link(original.id, binned.id, "about");
    const lacked = await make("core.note", "lacked target");
    await link(original.id, lacked.id, "references");
    expect((await client.deleteItem(binned.id)).ok).toBe(true);

    const base = original.version;
    expect(
      (
        await client.updateItem(original.id, {
          properties: { body: "narrow body from the winner" },
          version: base,
        })
      ).ok,
    ).toBe(true);
    const resolved = await narrow.rawRequest<{
      conflict_resolution?: { conflicted_copy_id?: string };
    }>(`/items/${original.id}?conflict=auto`, {
      method: "PATCH",
      body: {
        properties: { body: "narrow body from the loser" },
        version: base,
      },
    });
    expect(resolved.ok, JSON.stringify(resolved.error)).toBe(true);
    await trackSourceScopedItems({ client, ctx });
    const copy = resolved.data.conflict_resolution?.conflicted_copy_id;
    expect(copy).toBeTruthy();

    const back = await client.listItemBackrefs(copy!);
    const out = await client.listItemEdges(copy!);
    const inbound = back.data.data.map((e) => `${e.source_id}>${e.edge_type}`);
    const outbound = out.data.data.map((e) => `${e.edge_type}>${e.target_id}`);
    // The witness: an edge this writer could have made comes with the copy.
    expect(inbound).toContain(`${noteParent.id}>parent-of`);
    expect(inbound).not.toContain(`${bookmarkRow.id}>about`);
    expect(outbound).not.toContain(`about>${binned.id}`);
    // `references` is an edge type the writer's key does not reach.
    expect(outbound).not.toContain(`references>${lacked.id}`);
  });

  it("gives the conflicted copy only the edges the original's own file writes, none that cascade or block", async () => {
    requireRule(caps, "serverSideMerge");

    const make = async (type: string, title: string) => {
      const r = await client.createItem({
        type,
        source: ctx.source,
        properties: { title, body: `${title} body` },
      });
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
      trackItem(ctx, r.data.item.id);
      return r.data.item;
    };
    const cascading = `mock.copy-cascades.${ctx.runId}`;
    const blocking = `mock.copy-blocks.${ctx.runId}`;
    const under = `mock.copy-under.${ctx.runId}`;
    const registeredUnder = await client.registerEdgeType({
      id: under,
      cardinality: "many-to-many",
      reverse_name: `mock.copy-over.${ctx.runId}`,
      written_at: "target",
    });
    expect(registeredUnder.ok, JSON.stringify(registeredUnder.error)).toBe(
      true,
    );
    trackEdgeType(ctx, under);
    for (const [id, cascade_on_delete] of [
      [cascading, "cascade"],
      [blocking, "block"],
    ] as const) {
      const r = await client.registerEdgeType({
        id,
        cardinality: "many-to-many",
        cascade_on_delete,
      });
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
      trackEdgeType(ctx, id);
    }
    // An album is a container with a keep-both body: the case where copying
    // every edge the cardinality allows made its tracks the copy's too.
    const album = await make("core.media.album", "album");
    const track = await make("core.note", "track");
    const topic = await make("core.note", "topic");
    const part = await make("core.note", "part");
    const held = await make("core.note", "held");
    const link = async (
      source_id: string,
      target_id: string,
      edge_type: string,
    ) => {
      const r = await client.createEdge({ source_id, target_id, edge_type });
      expect(r.ok, edge_type).toBe(true);
    };
    await link(track.id, album.id, "in-collection");
    await link(album.id, topic.id, "about");
    await link(album.id, part.id, cascading);
    await link(album.id, held.id, blocking);
    const over = await make("core.note", "over");
    const binnedOver = await make("core.note", "binned over");
    await link(over.id, album.id, under);
    await link(binnedOver.id, album.id, under);
    expect((await client.deleteItem(binnedOver.id)).ok).toBe(true);

    const base = album.version;
    expect(
      (
        await client.updateItem(album.id, {
          properties: { body: "album body from the winner" },
          version: base,
        })
      ).ok,
    ).toBe(true);
    const resolved = await client.rawRequest<{
      conflict_resolution?: { conflicted_copy_id?: string };
    }>(`/items/${album.id}?conflict=auto`, {
      method: "PATCH",
      body: {
        properties: { body: "album body from the loser" },
        version: base,
      },
    });
    expect(resolved.ok, JSON.stringify(resolved.error)).toBe(true);
    await trackSourceScopedItems({ client, ctx });
    const copy = resolved.data.conflict_resolution?.conflicted_copy_id;
    expect(copy).toBeTruthy();

    const out = await client.listItemEdges(copy!);
    const back = await client.listItemBackrefs(copy!);
    const outbound = out.data.data.map((e) => `${e.edge_type}>${e.target_id}`);
    const inbound = back.data.data.map((e) => `${e.source_id}>${e.edge_type}`);
    // The witness: an edge the album's own file writes comes with the copy.
    expect(outbound).toContain(`about>${topic.id}`);
    // An inbound edge the album's own file writes comes with it, and not
    // one from a row in the bin.
    expect(inbound).toContain(`${over.id}>${under}`);
    expect(inbound).not.toContain(`${binnedOver.id}>${under}`);
    // A track names its album; the copy is not made its album too.
    expect(inbound).not.toContain(`${track.id}>in-collection`);
    // Discarding the copy must not take what the album points at to the bin,
    // nor be refused for it.
    expect(outbound).not.toContain(`${cascading}>${part.id}`);
    expect(outbound).not.toContain(`${blocking}>${held.id}`);
    expect((await client.deleteItem(copy!)).ok).toBe(true);
    expect((await client.getItem(part.id)).status).toBe(200);
  });

  it("keeps both copies in one write where the type says to", async () => {
    requireRule(caps, "serverSideMerge");

    const seed = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { title: "shared title", body: "shared body" },
    });
    expect(seed.ok).toBe(true);
    const id = seed.data.item.id;
    trackItem(ctx, id);
    const base = seed.data.item.version;

    // `body` on core.note is a keep-both field and `title` is
    // last-writer-wins, so one request exercises both arms of the policy.
    const winner = await client.updateItem(id, {
      properties: {
        title: "title from the winner",
        body: "body from the winner",
      },
      version: base,
    });
    expect(winner.ok).toBe(true);

    // The control. Without it a server that never refuses this write at all
    // would satisfy everything below, and the flag would be resolving a
    // collision that was never there.
    const refused = await client.rawRequest(`/items/${id}`, {
      method: "PATCH",
      body: {
        properties: {
          title: "title from the loser",
          body: "body from the loser",
        },
        version: base,
      },
    });
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("version_conflict");

    const resolved = await client.rawRequest<{
      item: { id: string; properties: Record<string, unknown> };
      conflict_resolution?: {
        strategy?: Record<string, string>;
        conflicted_copy_id?: string;
      };
    }>(`/items/${id}?conflict=auto`, {
      method: "PATCH",
      body: {
        properties: {
          title: "title from the loser",
          body: "body from the loser",
        },
        version: base,
      },
    });
    expect(
      resolved.ok,
      `a colliding update sent with conflict=auto was not resolved: ${resolved.status} ${JSON.stringify(resolved.error)}`,
    ).toBe(true);
    // Every row this write may have spawned, before any assertion can throw:
    // a server that resolved differently may have written one the envelope
    // does not name, and a listing scoped to this file's credential owns it.
    await trackSourceScopedItems({ client, ctx });

    // The envelope reports the resolution, and the document says this is the
    // only place the sibling's id appears.
    const resolution = resolved.data.conflict_resolution;
    expect(
      resolution?.strategy?.body,
      "the resolution did not report the type's policy for the keep-both field",
    ).toBe("keep_both_copies");
    expect(
      resolution?.strategy?.title,
      "the resolution did not report the type's policy for the last-writer-wins field",
    ).toBe("last_writer_wins");
    expect(
      typeof resolution?.conflicted_copy_id,
      "the resolution named no conflicted copy, so the sibling it wrote is unreachable to the client that caused it",
    ).toBe("string");

    const original = await client.getItem(id);
    expect(original.ok).toBe(true);

    // The last-writer-wins arm. Without it the test would pass against a
    // server that answered 200 by discarding the losing write entirely.
    expect(
      original.data.item.properties.title,
      "a last-writer-wins field did not take the later writer, so the type's policy was not applied",
    ).toBe("title from the loser");

    // The keep-both arm on the original: the server's value stands.
    expect(
      original.data.item.properties.body,
      "a keep-both field took the losing write on the original row, which is last-writer-wins under another name",
    ).toBe("body from the winner");

    // And the losing text survives somewhere the person can find it. This is
    // the assertion the rule exists for: a resolution that keeps only one
    // copy has lost an edit the writer was never told about.
    const siblings = await client.rawRequest<{
      data?: Array<{ id: string; properties: Record<string, unknown> }>;
    }>(`/items?source=${encodeURIComponent(ctx.source)}&limit=200`);
    expect(siblings.ok).toBe(true);
    const kept = (siblings.data.data ?? []).filter(
      (i) => i.id !== id && i.properties.body === "body from the loser",
    );
    expect(
      kept.map((i) => i.id),
      "the row carrying the losing text is not the one the envelope named",
    ).toEqual([resolution?.conflicted_copy_id]);
    expect(
      kept,
      "the losing copy of a keep-both field was not written anywhere, so an edit the client had accepted is gone with nothing recording it",
    ).toHaveLength(1);

    // The sibling has to be findable as a conflicted copy of the same type,
    // or a person meets an unexplained second row rather than a copy they can
    // reconcile.
    const sibling = await client.getItem(kept[0].id);
    expect(sibling.ok).toBe(true);
    expect(sibling.data.item.type).toBe("core.note");
    expect(sibling.data.metadata.tags).toContain("conflicted-copy");
  });

  it("resolves a field a stale replace cleared by the policy: cleared under last-writer-wins, kept and left off the copy under keep-both", async () => {
    requireRule(caps, "serverSideMerge");

    const seed = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: {
        title: "shared title",
        body: "shared body",
        notes: "shared notes",
      },
    });
    expect(seed.ok).toBe(true);
    const id = seed.data.item.id;
    trackItem(ctx, id);
    const base = seed.data.item.version;

    // `title` is last-writer-wins on core.note and `notes` keeps both, so
    // one replace that leaves both out meets both arms of the policy.
    const winner = await client.updateItem(id, {
      properties: {
        title: "title from the winner",
        notes: "notes from the winner",
      },
      version: base,
    });
    expect(winner.ok).toBe(true);

    // The control: the same clear without the flag is refused, naming both.
    const refused = await client.rawRequest(`/items/${id}`, {
      method: "PATCH",
      body: {
        properties: { body: "shared body" },
        properties_mode: "replace",
        version: base,
      },
    });
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("version_conflict");
    expect(
      (refused.error as unknown as { conflicting_fields?: string[] })
        .conflicting_fields,
    ).toEqual(["notes", "title"]);

    const resolved = await client.rawRequest<{
      item: { id: string; properties: Record<string, unknown> };
      conflict_resolution?: {
        strategy?: Record<string, string>;
        conflicted_copy_id?: string;
      };
    }>(`/items/${id}?conflict=auto`, {
      method: "PATCH",
      body: {
        properties: { body: "shared body" },
        properties_mode: "replace",
        version: base,
      },
    });
    expect(
      resolved.ok,
      `a colliding replace sent with conflict=auto was not resolved: ${resolved.status} ${JSON.stringify(resolved.error)}`,
    ).toBe(true);
    await trackSourceScopedItems({ client, ctx });

    const resolution = resolved.data.conflict_resolution;
    expect(resolution?.strategy?.title).toBe("last_writer_wins");
    expect(resolution?.strategy?.notes).toBe("keep_both_copies");
    // The later writer's clear takes the last-writer-wins field; the
    // keep-both field keeps the server's value on the row.
    expect(resolved.data.item.properties).not.toHaveProperty("title");
    expect(resolved.data.item.properties.notes).toBe("notes from the winner");
    expect(resolved.data.item.properties.body).toBe("shared body");

    const copyId = resolution?.conflicted_copy_id;
    expect(typeof copyId).toBe("string");
    const sibling = await client.getItem(copyId!);
    expect(sibling.ok).toBe(true);
    // The losing value of a keep-both field was "absent", so the copy
    // carries the row without it.
    expect(sibling.data.item.properties).not.toHaveProperty("notes");
    expect(sibling.data.item.properties.title).toBe("title from the winner");
    expect(sibling.data.item.properties.body).toBe("shared body");
    expect(sibling.data.metadata.tags).toContain("conflicted-copy");
  });

  it("applies a clear nobody collided with under conflict=auto, and resolves nothing", async () => {
    requireRule(caps, "serverSideMerge");

    const seed = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: {
        title: "shared title",
        body: "shared body",
        notes: "to clear",
      },
    });
    expect(seed.ok).toBe(true);
    const id = seed.data.item.id;
    trackItem(ctx, id);
    const base = seed.data.item.version;

    const other = await client.updateItem(id, {
      properties: { title: "title from the other writer" },
      version: base,
    });
    expect(other.ok).toBe(true);

    // The replace echoes the title at the value it read and leaves the
    // notes out: the clear is a genuine change nobody else touched, so it
    // lands as a merge would land it, and the flag has nothing to resolve.
    const cleared = await client.rawRequest<{
      item: { version: number; properties: Record<string, unknown> };
      conflict_resolution?: unknown;
    }>(`/items/${id}?conflict=auto`, {
      method: "PATCH",
      body: {
        properties: { title: "shared title", body: "shared body" },
        properties_mode: "replace",
        version: base,
      },
    });
    expect(cleared.status, JSON.stringify(cleared.error)).toBe(200);
    expect(cleared.data.item.version).toBe(base + 2);
    expect(cleared.data.item.properties).toEqual({
      title: "title from the other writer",
      body: "shared body",
    });
    expect(cleared.data.conflict_resolution).toBeUndefined();
  });

  it("refuses to resolve a colliding write that also moves the type", async () => {
    requireRule(caps, "serverSideMerge");

    const seed = await client.createItem({
      type: "core.note",
      source: ctx.source,
      properties: { title: "moving title", body: "moving body" },
    });
    expect(seed.ok).toBe(true);
    const id = seed.data.item.id;
    trackItem(ctx, id);
    const base = seed.data.item.version;

    const winner = await client.updateItem(id, {
      properties: { body: "body from the winner" },
      version: base,
    });
    expect(winner.ok).toBe(true);

    // A stale replace that clears the body the winner changed, and moves
    // the row to a bookmark: the collision is real, and the copy a
    // resolution would write would be a note without a body.
    const refused = await client.rawRequest(`/items/${id}?conflict=auto`, {
      method: "PATCH",
      body: {
        type: "core.bookmark",
        retype: true,
        properties: { url: "https://example.com/moved", title: "moving title" },
        properties_mode: "replace",
        version: base,
      },
    });
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("version_conflict");

    const fetched = await client.getItem(id);
    expect(fetched.ok).toBe(true);
    expect(fetched.data.item.type).toBe("core.note");
    expect(fetched.data.item.version).toBe(base + 1);
    expect(fetched.data.item.properties.body).toBe("body from the winner");
  });

  it("resolves a colliding item field to the later writer, and leaves an echoed one alone", async () => {
    // `tier`, `occurred_at` and `source_id` are the item's own fields
    // rather than properties, so the type declares no strategy for them
    // and `keep_both_copies` has nothing to mean: a sibling is a copy of
    // the row's properties, and a tier on it would be the sibling's own.
    // They take the later writer, and the resolution says so rather than
    // naming a field in `fields` with no strategy beside it.
    const seed = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { title: "item fields", body: "original" },
      }),
    );
    expect(seed.ok).toBe(true);
    const id = seed.data.item.id;
    trackItem(ctx, id);
    const base = seed.data.item.version;

    const winner = await client.updateItem(id, {
      occurred_at: "2026-05-01T00:00:00.000Z",
      tier: "feed",
      version: base,
    });
    expect(winner.ok).toBe(true);

    // The control, as above: without it a server that never refused this
    // write would satisfy everything below.
    const refused = await client.updateItem(id, {
      occurred_at: "2026-04-01T00:00:00.000Z",
      version: base,
    });
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("version_conflict");

    // The same write asking the server to resolve, and carrying the tier
    // this caller read alongside the time it genuinely changed. The tier is
    // an echo, so resolving must not use it to undo the tier written since.
    const resolved = await client.rawRequest<{
      item: { tier: string; occurred_at: string };
      conflict_resolution?: {
        fields?: string[];
        strategy?: Record<string, string>;
      };
    }>(`/items/${id}?conflict=auto`, {
      method: "PATCH",
      body: {
        occurred_at: "2026-04-01T00:00:00.000Z",
        tier: "library",
        version: base,
      },
    });
    expect(
      resolved.ok,
      `a colliding item-field update sent with conflict=auto was not resolved: ${resolved.status} ${JSON.stringify(resolved.error)}`,
    ).toBe(true);
    await trackSourceScopedItems({ client, ctx });

    expect(resolved.data.conflict_resolution?.fields).toEqual(["occurred_at"]);
    expect(
      resolved.data.conflict_resolution?.strategy?.occurred_at,
      "the resolution named the field without naming the strategy it applied",
    ).toBe("last_writer_wins");

    const after = await client.getItem(id);
    expect(after.ok).toBe(true);
    expect(
      after.data.item.occurred_at,
      "the colliding field did not take the later writer",
    ).toBe("2026-04-01T00:00:00.000Z");
    expect(
      after.data.item.tier,
      "an echoed item field reverted a value written since, which is the clobber the version check exists to stop",
    ).toBe("feed");
  });
});
