import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
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
      trackEdge(ctx, r.data.edge.id);
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

    // The writer may write notes and the edges below, only read bookmarks,
    // and not read tasks at all.
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
    const link = async (
      source_id: string,
      target_id: string,
      edge_type: string,
    ) => {
      const r = await client.createEdge({ source_id, target_id, edge_type });
      expect(r.ok, edge_type).toBe(true);
      trackEdge(ctx, r.data.edge.id);
    };
    const conflict = async (item: { id: string; version: number }) => {
      expect(
        (
          await client.updateItem(item.id, {
            properties: { body: "narrow body from the winner" },
            version: item.version,
          })
        ).ok,
      ).toBe(true);
      const resolved = await narrow.rawRequest<{
        conflict_resolution?: { conflicted_copy_id?: string };
      }>(`/items/${item.id}?conflict=auto`, {
        method: "PATCH",
        body: {
          properties: { body: "narrow body from the loser" },
          version: item.version,
        },
      });
      expect(resolved.ok, JSON.stringify(resolved.error)).toBe(true);
      await trackSourceScopedItems({ client, ctx });
      const copy = resolved.data.conflict_resolution?.conflicted_copy_id;
      expect(copy).toBeTruthy();
      const back = await client.listItemBackrefs(copy!);
      const out = await client.listItemEdges(copy!);
      return {
        inbound: back.data.data.map((e) => `${e.source_id}>${e.edge_type}`),
        outbound: out.data.data.map((e) => `${e.edge_type}>${e.target_id}`),
      };
    };

    // A child's place is written at the child, so the copy takes it, but
    // only from a parent whose type the writer may write.
    const original = await make("core.note", "narrow original");
    const noteParent = await make("core.note", "note parent");
    await link(noteParent.id, original.id, "parent-of");
    const orphan = await make("core.note", "narrow orphan");
    const bookmarkParent = await make("core.bookmark", "bookmark parent");
    await link(bookmarkParent.id, orphan.id, "parent-of");

    // What it is about is written at its source, so the copy takes it, but
    // only to a target the writer may read.
    const readable = await make("core.bookmark", "readable topic");
    await link(original.id, readable.id, "about");
    const unreadable = await make("core.task", "unreadable topic");
    await link(original.id, unreadable.id, "about");
    const binned = await make("core.note", "binned topic");
    await link(original.id, binned.id, "about");
    const lacked = await make("core.note", "lacked target");
    await link(original.id, lacked.id, "references");
    expect((await client.deleteItem(binned.id)).ok).toBe(true);

    const copied = await conflict(original);
    // The witnesses: an edge this writer could have made comes with the
    // copy, from a parent it may write and to a target it may only read.
    expect(copied.inbound).toContain(`${noteParent.id}>parent-of`);
    expect(copied.outbound).toContain(`about>${readable.id}`);
    expect(copied.outbound).not.toContain(`about>${unreadable.id}`);
    expect(copied.outbound).not.toContain(`about>${binned.id}`);
    // `references` is an edge type the writer's key does not reach.
    expect(copied.outbound).not.toContain(`references>${lacked.id}`);

    const orphaned = await conflict(orphan);
    expect(orphaned.inbound).not.toContain(`${bookmarkParent.id}>parent-of`);
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
      trackEdge(ctx, r.data.edge.id);
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

  /** The rows under this file's source whose `body` or `notes` is `marker`. */
  const holding = async (marker: string): Promise<string[]> => {
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listItems({
        source: ctx.source,
        limit: 200,
        ...(cursor !== undefined && { cursor }),
      });
      expect(page.ok).toBe(true);
      for (const item of page.data.data) {
        if (item.properties.body === marker || item.properties.notes === marker)
          found.push(item.id);
      }
      cursor = page.data.next_cursor ?? undefined;
    } while (cursor !== undefined);
    return found;
  };

  it("writes the conflicted copy under the original's source and without its natural key", async () => {
    requireRule(caps, "serverSideMerge");

    const writerSource = `${ctx.source}-writer`;
    const minted = await client.createKey({
      label: "conflict-copy-source",
      source: writerSource,
      permissions: [],
      type_permissions: { "core.note": "write" },
    });
    expect(minted.ok, JSON.stringify(minted.error)).toBe(true);
    trackKey(ctx, minted.data.id);
    const writer = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });

    // The witness that the two sources differ: a row the writer creates
    // carries the writer's.
    const own = await writer.createItem({
      type: "core.note",
      properties: { body: "written by the writer" },
    });
    expect(own.ok, JSON.stringify(own.error)).toBe(true);
    trackItem(ctx, own.data.item.id);
    expect(own.data.item.source).toBe(writerSource);

    const sourceId = `copy-key-${ctx.runId}`;
    const seed = await client.createItem({
      type: "core.note",
      source: ctx.source,
      source_id: sourceId,
      properties: { body: "original body" },
    });
    expect(seed.ok).toBe(true);
    const id = seed.data.item.id;
    trackItem(ctx, id);
    expect(
      (
        await client.updateItem(id, {
          properties: { body: "body from the winner" },
          version: 1,
        })
      ).ok,
    ).toBe(true);

    const resolved = await writer.rawRequest<{
      conflict_resolution?: { conflicted_copy_id?: string };
    }>(`/items/${id}?conflict=auto`, {
      method: "PATCH",
      body: { properties: { body: "body from the writer" }, version: 1 },
    });
    expect(resolved.ok, JSON.stringify(resolved.error)).toBe(true);
    await trackSourceScopedItems({ client, ctx });
    const copyId = resolved.data.conflict_resolution?.conflicted_copy_id;
    expect(copyId).toBeTruthy();

    const copy = await client.getItem(copyId!);
    expect(copy.data.item.properties.body).toBe("body from the writer");
    expect(copy.data.item.source).toBe(ctx.source);
    expect(copy.data.item.source_id ?? null).toBeNull();
    // The original keeps both, so the natural key still names one row.
    const original = await client.getItem(id);
    expect(original.data.item.source).toBe(ctx.source);
    expect(original.data.item.source_id).toBe(sourceId);
  });

  it("resolves a colliding tier or source_id to the later writer", async () => {
    requireRule(caps, "serverSideMerge");

    const cases = [
      {
        field: "tier",
        seed: { tier: "library" as const },
        winner: { tier: "feed" as const },
        loser: { tier: "feed" as const },
      },
      {
        field: "source_id",
        seed: { source_id: `resolve-seed-${ctx.runId}` },
        winner: { source_id: `resolve-winner-${ctx.runId}` },
        loser: { source_id: `resolve-loser-${ctx.runId}` },
      },
    ];
    for (const { field, seed, winner, loser } of cases) {
      const made = await client.createItem(
        createNote({
          source: ctx.source,
          properties: { title: `Resolve ${field}`, body: "original" },
          ...seed,
        }),
      );
      expect(made.ok, field).toBe(true);
      const id = made.data.item.id;
      trackItem(ctx, id);
      expect(
        (await client.updateItem(id, { ...winner, version: 1 })).ok,
        field,
      ).toBe(true);

      // The control: without the flag the same write collides on the field.
      const refused = await client.updateItem(id, { ...loser, version: 1 });
      expect(refused.status, field).toBe(409);
      expect(
        (refused.error as unknown as { conflicting_fields?: string[] })
          .conflicting_fields,
        field,
      ).toEqual([field]);

      const resolved = await client.rawRequest<{
        item: Record<string, unknown>;
        conflict_resolution?: {
          fields?: string[];
          strategy?: Record<string, string>;
          conflicted_copy_id?: string;
        };
      }>(`/items/${id}?conflict=auto`, {
        method: "PATCH",
        body: { ...loser, version: 1 },
      });
      expect(
        resolved.status,
        `${field}: ${JSON.stringify(resolved.error)}`,
      ).toBe(200);
      expect(resolved.data.conflict_resolution?.fields, field).toEqual([field]);
      expect(resolved.data.conflict_resolution?.strategy?.[field], field).toBe(
        "last_writer_wins",
      );
      expect(
        resolved.data.conflict_resolution?.conflicted_copy_id,
        `${field} has no keep-both strategy, so nothing is copied`,
      ).toBeUndefined();
      expect(resolved.data.item[field], field).toBe(
        (loser as Record<string, unknown>)[field],
      );
      const after = await client.getItem(id);
      expect(after.data.item.version, field).toBe(3);
    }
  });

  it("resolves a property both writers set to one value as a collision", async () => {
    requireRule(caps, "serverSideMerge");

    const made = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { title: "Agreed", body: "original" },
      }),
    );
    expect(made.ok).toBe(true);
    const id = made.data.item.id;
    trackItem(ctx, id);
    expect(
      (
        await client.updateItem(id, {
          properties: { title: "The same new title" },
          version: 1,
        })
      ).ok,
    ).toBe(true);

    const resolved = await client.rawRequest<{
      item: { version: number; properties: Record<string, unknown> };
      conflict_resolution?: {
        fields?: string[];
        strategy?: Record<string, string>;
      };
    }>(`/items/${id}?conflict=auto`, {
      method: "PATCH",
      body: { properties: { title: "The same new title" }, version: 1 },
    });
    expect(resolved.status, JSON.stringify(resolved.error)).toBe(200);
    expect(resolved.data.conflict_resolution?.fields).toEqual(["title"]);
    expect(resolved.data.conflict_resolution?.strategy?.title).toBe(
      "last_writer_wins",
    );
    expect(resolved.data.item.properties.title).toBe("The same new title");
    expect(resolved.data.item.version).toBe(3);
  });

  it("records the row the resolution moved on from, and gives the copy a history of its own", async () => {
    requireRule(caps, "serverSideMerge");

    const made = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { title: "Resolved history", body: "original body" },
      }),
    );
    expect(made.ok).toBe(true);
    const id = made.data.item.id;
    trackItem(ctx, id);
    expect(
      (
        await client.updateItem(id, {
          properties: {
            title: "title from the winner",
            body: "body from the winner",
          },
          version: 1,
        })
      ).ok,
    ).toBe(true);

    const resolved = await client.rawRequest<{
      item: { version: number };
      conflict_resolution?: { conflicted_copy_id?: string };
    }>(`/items/${id}?conflict=auto`, {
      method: "PATCH",
      body: {
        properties: {
          title: "title from the loser",
          body: "body from the loser",
        },
        version: 1,
      },
    });
    expect(resolved.status, JSON.stringify(resolved.error)).toBe(200);
    await trackSourceScopedItems({ client, ctx });
    const copyId = resolved.data.conflict_resolution?.conflicted_copy_id;
    expect(copyId).toBeTruthy();
    expect(resolved.data.item.version).toBe(3);

    const history = await client.getVersions(id);
    expect(history.data.data.map((v) => v.version)).toEqual([1, 2]);
    // Version 2 is the row the resolution left, the winner's.
    expect(history.data.data[1]?.properties).toEqual({
      title: "title from the winner",
      body: "body from the winner",
    });

    const copy = await client.getItem(copyId!);
    expect(copy.data.item.version).toBe(1);
    expect((await client.getVersions(copyId!)).data.data).toHaveLength(0);
  });

  it("writes no copy where the resolution is refused after it, and writes it where the same write is not", async () => {
    requireRule(caps, "serverSideMerge");

    const type = `user.resolve-refused-${ctx.runId}`;
    const registered = await client.registerType({
      id: type,
      fields: {
        title: { type: "string", required: true },
        notes: { type: "string" },
      },
      merge_policy: { fields: { notes: "keep_both_copies" } },
    } as never);
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    const made = await client.createItem({
      type,
      source: ctx.source,
      properties: { title: "original title", notes: "original notes" },
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    const id = made.data.item.id;
    trackItem(ctx, id);
    expect(
      (
        await client.updateItem(id, {
          properties: {
            title: "title from the winner",
            notes: "notes from the winner",
          },
          version: 1,
        })
      ).ok,
    ).toBe(true);

    // The replace carries a losing value for the keep-both field, which the
    // resolution copies, and leaves out the required title, whose clear
    // takes the later writer and so leaves the row short of its type.
    const replace = (properties: Record<string, unknown>) =>
      client.rawRequest<{
        conflict_resolution?: { conflicted_copy_id?: string };
      }>(`/items/${id}?conflict=auto`, {
        method: "PATCH",
        body: { properties, properties_mode: "replace", version: 1 },
      });
    const loserNotes = `notes from the loser ${ctx.runId}`;
    const refused = await replace({ notes: loserNotes });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    const errors = refused.error?.error.details?.errors as
      Array<{ field: string }> | undefined;
    expect(errors?.map((e) => e.field)).toContain("title");
    expect(await holding(loserNotes)).toEqual([]);
    const unmoved = await client.getItem(id);
    expect(unmoved.data.item.version).toBe(2);
    expect(unmoved.data.item.properties.notes).toBe("notes from the winner");

    // The witness: carrying the title, the same write is resolved and the
    // copy holds the losing notes, so the refusal above left none behind.
    const resolved = await replace({
      title: "title from the loser",
      notes: loserNotes,
    });
    expect(resolved.status, JSON.stringify(resolved.error)).toBe(200);
    await trackSourceScopedItems({ client, ctx });
    const copyId = resolved.data.conflict_resolution?.conflicted_copy_id;
    expect(copyId).toBeTruthy();
    expect(await holding(loserNotes)).toEqual([copyId]);
  });

  it("never resolves a write naming a version no snapshot covers, whatever conflict asks", async () => {
    requireRule(caps, "serverSideMerge");

    const made = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { title: "Never read", body: "original body" },
      }),
    );
    expect(made.ok).toBe(true);
    const id = made.data.item.id;
    trackItem(ctx, id);
    expect(
      (
        await client.updateItem(id, {
          properties: { body: "body from the winner" },
          version: 1,
        })
      ).ok,
    ).toBe(true);

    const loserBody = `body from the loser ${ctx.runId}`;
    for (const version of [0, 999]) {
      for (const properties of [{ body: loserBody }, { notes: loserBody }]) {
        const name = `${JSON.stringify(properties)} naming version ${String(version)}`;
        const refused = await client.rawRequest(`/items/${id}?conflict=auto`, {
          method: "PATCH",
          body: { properties, version },
        });
        expect(refused.status, name).toBe(409);
        expect(refused.error?.error.code, name).toBe("ancestor_unavailable");
      }
    }
    expect(await holding(loserBody)).toEqual([]);
    const unmoved = await client.getItem(id);
    expect(unmoved.data.item.version).toBe(2);
    expect(unmoved.data.item.properties.body).toBe("body from the winner");

    // The witness: naming the retained version, the same write is resolved
    // into a copy.
    const resolved = await client.rawRequest<{
      conflict_resolution?: { conflicted_copy_id?: string };
    }>(`/items/${id}?conflict=auto`, {
      method: "PATCH",
      body: { properties: { body: loserBody }, version: 1 },
    });
    expect(resolved.status, JSON.stringify(resolved.error)).toBe(200);
    await trackSourceScopedItems({ client, ctx });
    expect(await holding(loserBody)).toEqual([
      resolved.data.conflict_resolution?.conflicted_copy_id,
    ]);
  });

  it("refuses to resolve a stale move onto a row another writer moved since", async () => {
    requireRule(caps, "serverSideMerge");

    const made = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { title: "Moved twice", body: "original body" },
      }),
    );
    expect(made.ok).toBe(true);
    const id = made.data.item.id;
    trackItem(ctx, id);
    const moved = await client.updateItem(id, {
      type: "core.bookmark",
      retype: true,
      version: 1,
    });
    expect(moved.status, JSON.stringify(moved.error)).toBe(200);

    const refused = await client.rawRequest(`/items/${id}?conflict=auto`, {
      method: "PATCH",
      body: {
        type: "core.task",
        retype: true,
        properties: { title: "Moved twice" },
        version: 1,
      },
    });
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("version_conflict");
    expect(
      (refused.error as unknown as { conflicting_fields?: string[] })
        .conflicting_fields,
    ).toContain("type");
    const after = await client.getItem(id);
    expect(after.data.item.type).toBe("core.bookmark");
    expect(after.data.item.version).toBe(2);
  });

  it("takes conflict=manual and conflict=callback as absent, and refuses any other value", async () => {
    requireRule(caps, "serverSideMerge");

    const made = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { title: "Modes", body: "original body" },
      }),
    );
    expect(made.ok).toBe(true);
    const id = made.data.item.id;
    trackItem(ctx, id);
    expect(
      (
        await client.updateItem(id, {
          properties: { title: "title from the winner" },
          version: 1,
        })
      ).ok,
    ).toBe(true);
    const stale = (mode: string) =>
      client.rawRequest(`/items/${id}?conflict=${encodeURIComponent(mode)}`, {
        method: "PATCH",
        body: { properties: { title: "title from the loser" }, version: 1 },
      });

    for (const mode of ["manual", "callback"]) {
      const refused = await stale(mode);
      expect(refused.status, mode).toBe(409);
      expect(refused.error?.error.code, mode).toBe("version_conflict");
    }
    for (const mode of ["bogus", "AUTO", "merge", ""]) {
      const refused = await stale(mode);
      expect(refused.status, JSON.stringify(mode)).toBe(400);
      expect(refused.error?.error.code, JSON.stringify(mode)).toBe(
        "validation_error",
      );
    }
    const unmoved = await client.getItem(id);
    expect(unmoved.data.item.version).toBe(2);
    expect(unmoved.data.item.properties.title).toBe("title from the winner");

    // The witness: auto resolves the same write.
    const resolved = await stale("auto");
    expect(resolved.status, JSON.stringify(resolved.error)).toBe(200);
  });

  it("resolves two stale writes arriving together, each into a copy of its own", async () => {
    requireRule(caps, "serverSideMerge");

    for (let round = 0; round < 3; round++) {
      const made = await client.createItem(
        createNote({
          source: ctx.source,
          properties: { title: "Raced", body: "original body" },
        }),
      );
      expect(made.ok).toBe(true);
      const id = made.data.item.id;
      trackItem(ctx, id);
      expect(
        (
          await client.updateItem(id, {
            properties: {
              title: "title from the winner",
              body: "body from the winner",
            },
            version: 1,
          })
        ).ok,
      ).toBe(true);

      const writers = ["first", "second"].map((name) => ({
        title: `title from the ${name} loser ${ctx.runId} ${String(round)}`,
        body: `body from the ${name} loser ${ctx.runId} ${String(round)}`,
      }));
      const answers = await Promise.all(
        writers.map((properties) =>
          client.rawRequest<{
            item: { version: number };
            conflict_resolution?: { conflicted_copy_id?: string };
          }>(`/items/${id}?conflict=auto`, {
            method: "PATCH",
            body: { properties, version: 1 },
          }),
        ),
      );
      await trackSourceScopedItems({ client, ctx });
      expect(
        answers.map((answer) => answer.status),
        JSON.stringify(answers.map((a) => a.error ?? a.data)),
      ).toEqual([200, 200]);
      const copies = answers.map(
        (answer) => answer.data.conflict_resolution?.conflicted_copy_id,
      );
      expect(copies[0]).toBeTruthy();
      expect(copies[1]).toBeTruthy();
      expect(copies[0]).not.toBe(copies[1]);
      expect(answers.map((a) => a.data.item.version).sort()).toEqual([3, 4]);

      // Whichever was ordered last took the title, and the row keeps the
      // winner's body, which is a keep-both field.
      const row = await client.getItem(id);
      expect(row.data.item.version).toBe(4);
      expect(writers.map((w) => w.title)).toContain(
        row.data.item.properties.title,
      );
      expect(row.data.item.properties.body).toBe("body from the winner");
      expect(
        (await client.getVersions(id)).data.data.map((v) => v.version),
      ).toEqual([1, 2, 3]);
      for (const [index, copy] of copies.entries()) {
        const held = await client.getItem(copy!);
        expect(held.data.item.properties.body).toBe(writers[index]?.body);
      }
    }
  });
});

describe("a conflicted copy names its original", () => {
  /** A note whose next write at `version` collides on `body`. */
  const collidingNote = async (title: string) => {
    const made = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { title, body: `${title} body` },
      }),
    );
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    trackItem(ctx, made.data.item.id);
    const { id, version } = made.data.item;
    const winner = await client.updateItem(id, {
      properties: { body: `${title} body from the winner` },
      version,
    });
    expect(winner.ok).toBe(true);
    return { id, version };
  };
  const derivedFrom = async (id: string) => {
    const out = await client.listItemEdges(id, { edge_type: "derived-from" });
    expect(out.ok, JSON.stringify(out.error)).toBe(true);
    return out.data.data;
  };
  const copiesOf = async (id: string) => {
    const back = await client.listItemBackrefs(id, {
      edge_type: "derived-from",
    });
    expect(back.ok, JSON.stringify(back.error)).toBe(true);
    return back.data.data.map((edge) => edge.source_id);
  };

  it("links the conflicted copy to its original with one derived-from edge, whatever edge grants the writer holds", async () => {
    requireRule(caps, "serverSideMerge");

    // The writer may write notes and no edge type at all.
    const keyResp = await client.createKey({
      label: "conflict-copy-no-edges",
      source: `${ctx.source}-no-edges`,
      permissions: [],
      type_permissions: { "core.note": "write" },
      edge_permissions: {},
    });
    expect(keyResp.ok, JSON.stringify(keyResp.error)).toBe(true);
    trackKey(ctx, keyResp.data.id);
    const writer = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: keyResp.data.key,
    });

    // The original was itself made from something. The copy is made from
    // the original, so it takes none of the original's own derived-from
    // edges, and its one edge of that type names the original.
    const origin = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { title: "origin", body: "origin body" },
      }),
    );
    expect(origin.ok).toBe(true);
    trackItem(ctx, origin.data.item.id);
    const original = await collidingNote("derived original");
    const provenance = await client.createEdge({
      source_id: original.id,
      target_id: origin.data.item.id,
      edge_type: "derived-from",
    });
    expect(provenance.ok).toBe(true);
    trackEdge(ctx, provenance.data.edge.id);

    // The control: the writer may not draw the edge itself.
    const drawn = await writer.createEdge({
      source_id: original.id,
      target_id: origin.data.item.id,
      edge_type: "derived-from",
    });
    expect(drawn.status).toBe(403);

    const key = `copy-link-${ctx.runId}`;
    const send = () =>
      writer.rawRequest<{
        conflict_resolution?: { conflicted_copy_id?: string };
      }>(`/items/${original.id}?conflict=auto`, {
        method: "PATCH",
        headers: { "Idempotency-Key": key },
        body: {
          properties: { body: "derived body from the loser" },
          version: original.version,
        },
      });
    const resolved = await send();
    expect(resolved.ok, JSON.stringify(resolved.error)).toBe(true);
    await trackSourceScopedItems({ client, ctx });
    const copy = resolved.data.conflict_resolution?.conflicted_copy_id;
    expect(copy, "no conflicted copy was written").toBeTruthy();

    const links = await derivedFrom(copy!);
    expect(
      links.map((edge) => edge.target_id),
      "the conflicted copy does not name its original, so nothing finds one from the other once the verdict is gone",
    ).toEqual([original.id]);
    expect(links[0]?.properties).toEqual({});
    expect(links[0]?.version).toBe(1);
    expect(await copiesOf(original.id)).toEqual([copy]);
    // The witness that a derived-from edge on the original is one the copy
    // could have taken: the original still holds it.
    expect(
      (await derivedFrom(original.id)).map((edge) => edge.target_id),
    ).toEqual([origin.data.item.id]);

    // The same write again under the same key is its first answer, and
    // writes neither a second copy nor a second link.
    const replayed = await send();
    expect(replayed.ok, JSON.stringify(replayed.error)).toBe(true);
    expect(replayed.data.conflict_resolution?.conflicted_copy_id).toBe(copy);
    expect(await derivedFrom(copy!)).toHaveLength(1);
    expect(await copiesOf(original.id)).toEqual([copy]);
  });

  it("gives the conflicted copy none of the original's own derived-from edges, though its writer could have made them", async () => {
    requireRule(caps, "serverSideMerge");

    const origin = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { title: "made-from", body: "made-from body" },
      }),
    );
    expect(origin.ok).toBe(true);
    trackItem(ctx, origin.data.item.id);
    const original = await collidingNote("provenance original");
    const provenance = await client.createEdge({
      source_id: original.id,
      target_id: origin.data.item.id,
      edge_type: "derived-from",
    });
    expect(provenance.ok).toBe(true);
    trackEdge(ctx, provenance.data.edge.id);
    // The witness: an outbound edge of a type the original's own file
    // writes, many-to-many, orphaning, to a live row and drawn by a writer
    // who holds every grant, is one the copy takes.
    const topic = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { title: "topic", body: "topic body" },
      }),
    );
    expect(topic.ok).toBe(true);
    trackItem(ctx, topic.data.item.id);
    const mention = await client.createEdge({
      source_id: original.id,
      target_id: topic.data.item.id,
      edge_type: "references",
    });
    expect(mention.ok).toBe(true);
    trackEdge(ctx, mention.data.edge.id);

    const resolved = await client.rawRequest<{
      conflict_resolution?: { conflicted_copy_id?: string };
    }>(`/items/${original.id}?conflict=auto`, {
      method: "PATCH",
      body: {
        properties: { body: "provenance body from the loser" },
        version: original.version,
      },
    });
    expect(resolved.ok, JSON.stringify(resolved.error)).toBe(true);
    await trackSourceScopedItems({ client, ctx });
    const copy = resolved.data.conflict_resolution?.conflicted_copy_id;
    expect(copy).toBeTruthy();

    const out = await client.listItemEdges(copy!);
    expect(out.ok).toBe(true);
    expect(out.data.data.map((e) => `${e.edge_type}>${e.target_id}`)).toContain(
      `references>${topic.data.item.id}`,
    );
    expect(
      (await derivedFrom(copy!)).map((edge) => edge.target_id),
      "the copy took the original's own derived-from edge, so its derived-from edges no longer name its original alone",
    ).toEqual([original.id]);
  });

  it("keeps the link while the original is in the bin, and a purge of the original takes the link and leaves the copy", async () => {
    requireRule(caps, "serverSideMerge");

    const original = await collidingNote("purged original");
    const resolved = await client.rawRequest<{
      conflict_resolution?: { conflicted_copy_id?: string };
    }>(`/items/${original.id}?conflict=auto`, {
      method: "PATCH",
      body: {
        properties: { body: "the text the person lost" },
        version: original.version,
      },
    });
    expect(resolved.ok, JSON.stringify(resolved.error)).toBe(true);
    await trackSourceScopedItems({ client, ctx });
    const copy = resolved.data.conflict_resolution?.conflicted_copy_id;
    expect(copy).toBeTruthy();

    expect((await client.deleteItem(original.id)).ok).toBe(true);
    expect(
      (await derivedFrom(copy!)).map((edge) => edge.target_id),
      "trashing the original took the link, so restoring it would not bring its copy back beside it",
    ).toEqual([original.id]);

    expect((await client.purgeItem(original.id)).ok).toBe(true);
    expect(await derivedFrom(copy!)).toEqual([]);
    const kept = await client.getItem(copy!);
    expect(
      kept.status,
      "purging the original took its conflicted copy, which holds the text the person lost",
    ).toBe(200);
    expect(kept.data.item.state).toBe("active");
    expect(kept.data.item.properties.body).toBe("the text the person lost");
  });
});
