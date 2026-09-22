import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackEdge,
  trackEdgeType,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { createBookmark, createNote } from "../../generators/items.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "edge-permissions",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function makeKey(
  label: string,
  opts: {
    type_permissions: Record<string, string>;
    edge_permissions?: Record<string, string>;
    permissions?: readonly string[];
  },
): Promise<{ key: string; id: string }> {
  const resp = await client.createKey({
    label,
    source: `${ctx.source}-${label}`,
    type_permissions: opts.type_permissions,
    edge_permissions: opts.edge_permissions,
    permissions: opts.permissions ?? [],
  });
  expect(resp.ok).toBe(true);
  trackKey(ctx, resp.data.id);
  return { key: resp.data.key, id: resp.data.id };
}

async function scopedItem(c: MarfaClient, label: string): Promise<string> {
  const r = await c.createItem(
    createNote({ properties: { body: `ep-${label}` } }),
  );
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  return r.data.item.id;
}

describe("per-edge-type permissions", () => {
  it("dual-gate: source-type write + edge-type write required", async () => {
    const noEdgeScope = await makeKey("no-edge-scope", {
      type_permissions: { "*": "write" },
    });
    const noEdgeClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: noEdgeScope.key,
    });

    const a = await scopedItem(noEdgeClient, "a");
    const b = await scopedItem(noEdgeClient, "b");

    const r1 = await noEdgeClient.createEdge({
      source_id: a,
      target_id: b,
      edge_type: "about",
    });
    expect(r1.ok).toBe(false);
    expect(r1.status).toBe(403);
    expect(r1.error?.error.code).toBe("edge_permission_denied");

    const noTypeScope = await makeKey("no-type-scope", {
      type_permissions: { "core.note": "read" },
      edge_permissions: { about: "write" },
    });
    const noTypeClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: noTypeScope.key,
    });

    const r2 = await noTypeClient.createEdge({
      source_id: a,
      target_id: b,
      edge_type: "about",
    });
    expect(r2.ok).toBe(false);
    expect(r2.status).toBe(403);
    expect(r2.error?.error.code).toBe("type_not_permitted");

    const bothScopes = await makeKey("both-scopes", {
      type_permissions: { "*": "write" },
      edge_permissions: { about: "write" },
    });
    const bothClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: bothScopes.key,
    });
    const a2 = await scopedItem(bothClient, "a2");
    const b2 = await scopedItem(bothClient, "b2");
    const r3 = await bothClient.createEdge({
      source_id: a2,
      target_id: b2,
      edge_type: "about",
    });
    expect(r3.ok).toBe(true);
    trackEdge(ctx, r3.data.edge.id);
  });

  it("a key holding every edge type creates any edge", async () => {
    const a = await scopedItem(client, "adm-a");
    const b = await scopedItem(client, "adm-b");

    const r = await client.createEdge({
      source_id: a,
      target_id: b,
      edge_type: "parent-of",
    });
    expect(r.ok).toBe(true);
    trackEdge(ctx, r.data.edge.id);
  });

  it("narrow scope: key with edge.about:write cannot create parent-of edges", async () => {
    const narrow = await makeKey("narrow-about-only", {
      type_permissions: { "*": "write" },
      edge_permissions: { about: "write" },
    });
    const narrowClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: narrow.key,
    });

    const a = await scopedItem(narrowClient, "narrow-a");
    const b = await scopedItem(narrowClient, "narrow-b");

    const about = await narrowClient.createEdge({
      source_id: a,
      target_id: b,
      edge_type: "about",
    });
    expect(about.ok).toBe(true);
    trackEdge(ctx, about.data.edge.id);

    const po = await narrowClient.createEdge({
      source_id: a,
      target_id: b,
      edge_type: "parent-of",
    });
    expect(po.ok).toBe(false);
    expect(po.status).toBe(403);
    expect(po.error?.error.code).toBe("edge_permission_denied");
  });

  it("wildcard edge_permissions: edge.*:write creates any edge type", async () => {
    const wild = await makeKey("wildcard", {
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
    });
    const wildClient = new MarfaClient({ baseUrl: apiUrl, apiKey: wild.key });

    const a = await scopedItem(wildClient, "w-a");

    for (const edgeType of [
      "about",
      "parent-of",
      "authored-by",
      "attached-to",
    ]) {
      const target = await scopedItem(wildClient, `w-t-${edgeType}`);
      const r = await wildClient.createEdge({
        source_id: a,
        target_id: target,
        edge_type: edgeType,
      });
      expect(r.ok).toBe(true);
      trackEdge(ctx, r.data.edge.id);
    }
  });

  // The type-permission gate on an edge write reads the source item whether
  // it is live or trashed.
  it("trashed source: PATCH/DELETE edge still gated on source type", async () => {
    // Register two custom types so we can gate a key strictly on the target
    // type without granting core.note blanket access through wildcards.
    const sourceType = `user.evaluator-edgesrc-${ctx.runId}`;
    const targetType = `user.evaluator-edgetgt-${ctx.runId}`;
    await client.registerType({
      id: sourceType,
      fields: { title: { type: "string", required: true } },
    });
    await client.registerType({
      id: targetType,
      fields: { title: { type: "string", required: true } },
    });

    const srcResp = await client.createItem({
      type: sourceType,
      properties: { title: "src" },
      source: ctx.source,
    });
    expect(srcResp.ok).toBe(true);
    trackItem(ctx, srcResp.data.item.id);

    const tgtResp = await client.createItem({
      type: targetType,
      properties: { title: "tgt" },
      source: ctx.source,
    });
    expect(tgtResp.ok).toBe(true);
    trackItem(ctx, tgtResp.data.item.id);

    const edge = await client.createEdge({
      source_id: srcResp.data.item.id,
      target_id: tgtResp.data.item.id,
      edge_type: "about",
    });
    expect(edge.ok).toBe(true);
    trackEdge(ctx, edge.data.edge.id);

    const trash = await client.deleteItem(srcResp.data.item.id);
    expect(trash.ok).toBe(true);

    // Key scoped to the TARGET type only (plus edge.about read/write so the
    // dual-gate on edge-type isn't what denies). No access to source type.
    const targetOnly = await makeKey("target-only", {
      type_permissions: { [targetType]: "write" },
      edge_permissions: { about: "write" },
    });
    const targetOnlyClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: targetOnly.key,
    });

    const patch = await targetOnlyClient.updateEdge(edge.data.edge.id, {
      properties: { note: "should not land" },
      version: edge.data.edge.version,
    });
    expect(patch.ok).toBe(false);
    expect(patch.status).toBe(403);
    expect(patch.error?.error.code).toBe("type_not_permitted");

    const del = await targetOnlyClient.deleteEdge(edge.data.edge.id);
    expect(del.ok).toBe(false);
    expect(del.status).toBe(403);
    expect(del.error?.error.code).toBe("type_not_permitted");

    const sourceOnly = await makeKey("source-only", {
      type_permissions: { [sourceType]: "write", [targetType]: "read" },
      edge_permissions: { about: "write" },
    });
    const sourceOnlyClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: sourceOnly.key,
    });

    const patchOk = await sourceOnlyClient.updateEdge(edge.data.edge.id, {
      properties: { note: "ok" },
      version: edge.data.edge.version,
    });
    expect(patchOk.ok).toBe(true);

    const delOk = await sourceOnlyClient.deleteEdge(edge.data.edge.id);
    expect(delOk.ok).toBe(true);
  });

  it("edge read scope: key with edge.about:read can list but not write", async () => {
    const source = await scopedItem(client, "read-src");
    const target = await scopedItem(client, "read-tgt");
    const edge = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: "about",
    });
    expect(edge.ok).toBe(true);
    trackEdge(ctx, edge.data.edge.id);

    // Write on every item type, so the refusal below can only come from the
    // edge map: the source-type gate runs first and would answer instead.
    const readOnly = await makeKey("read-only-edge", {
      type_permissions: { "*": "write" },
      edge_permissions: { about: "read" },
    });
    const readClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: readOnly.key,
    });

    const list = await readClient.listItemEdges(source, { edge_type: "about" });
    expect(list.ok).toBe(true);
    expect(list.data.data.some((e) => e.id === edge.data.edge.id)).toBe(true);

    const write = await readClient.createEdge({
      source_id: source,
      target_id: target,
      edge_type: "about",
    });
    expect(write.ok).toBe(false);
    expect(write.status).toBe(403);
    expect(write.error?.error.code).toBe("edge_permission_denied");
  });
});

/**
 * What the plural door discloses, against what the singular one does.
 *
 * `GET /edges/{id}` resolves the row's source item and asks two questions
 * before it answers: may this credential read the source's type, and may it
 * read the edge type. A listing that asked neither handed the same
 * credential every edge in the instance — both endpoints, the properties on
 * them and the type of the relationship — for the rows it was refused one
 * at a time. The listing drops what it may not disclose rather than
 * refusing the page, because a page is a page of what the caller may see.
 *
 * Each case names its own edge type and filters on it, so the assertions
 * are about the two rows the case made and not about whatever else the
 * run's shared instance holds.
 */
describe("the edge listing answers only what the credential may read", () => {
  it("drops an edge whose source is a type the credential cannot read", async () => {
    const edgeType = `mock.disclosure.src.${ctx.runId}`;
    const registered = await client.registerEdgeType({
      id: edgeType,
      cardinality: "many-to-many",
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    trackEdgeType(ctx, edgeType);

    const target = await scopedItem(client, "disclosure-target");
    const readableSource = await scopedItem(client, "disclosure-readable");
    const hidden = await client.createItem(
      createBookmark({ properties: { title: "ep-disclosure-hidden" } }),
    );
    expect(hidden.ok, JSON.stringify(hidden.error)).toBe(true);
    trackItem(ctx, hidden.data.item.id);

    const readableEdge = await client.createEdge({
      source_id: readableSource,
      target_id: target,
      edge_type: edgeType,
    });
    expect(readableEdge.ok, JSON.stringify(readableEdge.error)).toBe(true);
    trackEdge(ctx, readableEdge.data.edge.id);
    const hiddenEdge = await client.createEdge({
      source_id: hidden.data.item.id,
      target_id: target,
      edge_type: edgeType,
    });
    expect(hiddenEdge.ok, JSON.stringify(hiddenEdge.error)).toBe(true);
    trackEdge(ctx, hiddenEdge.data.edge.id);

    // Reads notes and not bookmarks, and holds every edge type, so what
    // the listing drops can only be the source item's type.
    const narrow = await makeKey("disclosure-narrow", {
      type_permissions: { "core.note": "read" },
      edge_permissions: { "*": "read" },
    });
    const narrowClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: narrow.key,
    });

    const page = await narrowClient.listEdges({
      edge_type: edgeType,
      limit: 100,
    });
    expect(page.ok, JSON.stringify(page.error)).toBe(true);
    const ids = page.data.data.map((e) => e.id);
    // The witness sits beside the absence rather than after it: the same
    // page carries the edge this credential may read, so the row that is
    // missing is missing because of the gate and not because the filter,
    // the page size or the edge type kept everything out.
    expect(
      ids,
      "the credential could not see an edge whose source it may read, so the listing refused more than the gate asks",
    ).toContain(readableEdge.data.edge.id);
    expect(
      ids,
      "the listing disclosed an edge whose source is a type this credential may not read",
    ).not.toContain(hiddenEdge.data.edge.id);

    // And the row is really there: a credential that may read both types
    // sees both, so what changed is the credential's reach and not the
    // instance's contents.
    const wide = await makeKey("disclosure-wide", {
      type_permissions: { "*": "read" },
      edge_permissions: { "*": "read" },
    });
    const widePage = await new MarfaClient({
      baseUrl: apiUrl,
      apiKey: wide.key,
    }).listEdges({ edge_type: edgeType, limit: 100 });
    expect(widePage.ok).toBe(true);
    expect(widePage.data.data.map((e) => e.id).sort()).toEqual(
      [readableEdge.data.edge.id, hiddenEdge.data.edge.id].sort(),
    );
  });

  it("drops an edge of an edge type the credential cannot read", async () => {
    const edgeType = `mock.disclosure.kind.${ctx.runId}`;
    const registered = await client.registerEdgeType({
      id: edgeType,
      cardinality: "many-to-many",
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    trackEdgeType(ctx, edgeType);

    const source = await scopedItem(client, "kind-src");
    const target = await scopedItem(client, "kind-tgt");
    const edge = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: edgeType,
    });
    expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
    trackEdge(ctx, edge.data.edge.id);

    // Reads every item type, and holds one edge type that is not this one,
    // so what the listing drops can only be the edge type.
    const narrow = await makeKey("kind-narrow", {
      type_permissions: { "*": "read" },
      edge_permissions: { about: "read" },
    });
    const page = await new MarfaClient({
      baseUrl: apiUrl,
      apiKey: narrow.key,
    }).listEdges({ edge_type: edgeType, limit: 100 });
    expect(page.ok, JSON.stringify(page.error)).toBe(true);
    expect(
      page.data.data.map((e) => e.id),
      "the listing disclosed an edge of a kind this credential may not read",
    ).not.toContain(edge.data.edge.id);

    // The same page under a credential holding the edge type carries it,
    // so the row exists and the filter is the credential's.
    const wide = await makeKey("kind-wide", {
      type_permissions: { "*": "read" },
      edge_permissions: { "*": "read" },
    });
    const widePage = await new MarfaClient({
      baseUrl: apiUrl,
      apiKey: wide.key,
    }).listEdges({ edge_type: edgeType, limit: 100 });
    expect(widePage.ok).toBe(true);
    expect(widePage.data.data.map((e) => e.id)).toContain(edge.data.edge.id);
  });

  it("drops it still when the source is trashed, which is when a null source would read as no source at all", async () => {
    // The door resolves the source including trashed rows on purpose. A
    // plain read answers null for a trashed item, and a null source has
    // no type to refuse — so trashing the source item would turn the
    // refusal above into a disclosure, and nothing else here would say
    // so. The single door reads the same way for the same reason.
    const edgeType = `mock.disclosure.trashed.${ctx.runId}`;
    const registered = await client.registerEdgeType({
      id: edgeType,
      cardinality: "many-to-many",
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    trackEdgeType(ctx, edgeType);

    const target = await scopedItem(client, "trashed-target");
    const hidden = await client.createItem(
      createBookmark({ properties: { title: "ep-trashed-hidden" } }),
    );
    expect(hidden.ok, JSON.stringify(hidden.error)).toBe(true);
    trackItem(ctx, hidden.data.item.id);
    const edge = await client.createEdge({
      source_id: hidden.data.item.id,
      target_id: target,
      edge_type: edgeType,
    });
    expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
    trackEdge(ctx, edge.data.edge.id);

    const trashed = await client.deleteItem(hidden.data.item.id);
    expect(trashed.ok, JSON.stringify(trashed.error)).toBe(true);

    const narrow = await makeKey("trashed-narrow", {
      type_permissions: { "core.note": "read" },
      edge_permissions: { "*": "read" },
    });
    const narrowClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: narrow.key,
    });
    expect(
      (await narrowClient.listEdges({ edge_type: edgeType, limit: 100 })).data
        .data,
      "trashing the source item turned the refusal into a disclosure",
    ).toEqual([]);
    // And the door this one is meant to agree with still refuses it, so
    // the two read a trashed source the same way.
    expect((await narrowClient.getEdge(edge.data.edge.id)).status).toBe(403);
  });

  it("pages to the end of the listing though whole pages are dropped", async () => {
    // What "shorter than the limit" turns into at a page boundary: a
    // page of nothing, with `has_more` still true. The cursor and
    // `has_more` are the store's reading of the whole listing rather
    // than of what survived the gate, which is what makes the walk
    // terminate — and a client that stopped on an empty page would
    // truncate its copy silently and never learn it had.
    const edgeType = `mock.disclosure.paged.${ctx.runId}`;
    const registered = await client.registerEdgeType({
      id: edgeType,
      cardinality: "many-to-many",
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    trackEdgeType(ctx, edgeType);

    const target = await scopedItem(client, "paged-target");
    const readable: string[] = [];
    // Readable at both ends and four hidden rows between them, so a walk
    // at two a page meets at least one page with nothing on it.
    for (const [index, kind] of [
      "note",
      "bookmark",
      "bookmark",
      "bookmark",
      "bookmark",
      "note",
    ].entries()) {
      const source =
        kind === "note"
          ? await scopedItem(client, `paged-src-${String(index)}`)
          : await (async () => {
              const r = await client.createItem(
                createBookmark({
                  properties: { title: `ep-paged-${String(index)}` },
                }),
              );
              expect(r.ok, JSON.stringify(r.error)).toBe(true);
              trackItem(ctx, r.data.item.id);
              return r.data.item.id;
            })();
      const edge = await client.createEdge({
        source_id: source,
        target_id: target,
        edge_type: edgeType,
      });
      expect(edge.ok, JSON.stringify(edge.error)).toBe(true);
      trackEdge(ctx, edge.data.edge.id);
      if (kind === "note") readable.push(edge.data.edge.id);
    }

    const narrow = await makeKey("paged-narrow", {
      type_permissions: { "core.note": "read" },
      edge_permissions: { "*": "read" },
    });
    const narrowClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: narrow.key,
    });

    const seen: string[] = [];
    let emptyPages = 0;
    let cursor: string | undefined;
    for (let page = 0; page < 12; page++) {
      const answer = await narrowClient.listEdges({
        edge_type: edgeType,
        limit: 2,
        cursor,
      });
      expect(answer.ok, JSON.stringify(answer.error)).toBe(true);
      seen.push(...answer.data.data.map((e) => e.id));
      if (answer.data.data.length === 0 && answer.data.has_more) emptyPages++;
      if (!answer.data.has_more) {
        cursor = undefined;
        break;
      }
      cursor = answer.data.cursor ?? undefined;
      expect(
        cursor,
        "the listing says there is more and names no cursor",
      ).toBeDefined();
    }
    expect(
      cursor,
      "the walk ran out of pages before the listing ran out of rows",
    ).toBeUndefined();
    expect(
      emptyPages,
      "no page came back empty, so this case is not about the thing it claims",
    ).toBeGreaterThan(0);
    expect(seen.sort()).toEqual([...readable].sort());
  });
});

/**
 * The doors under an item, against the same single read.
 *
 * Each checked the anchor item's type and stopped. On the outbound side
 * that settles the source — the anchor is every row's source — and leaves
 * the edge type unasked, so a credential holding read on one kind of
 * relationship was handed every kind the item has. On the inbound side it
 * settles neither: the anchor is the **target**, and an edge's
 * readability is its source item's, a row the door never read.
 *
 * Every case names its own edge types and filters on them, so what it
 * asserts is about the rows it made rather than about whatever else the
 * run's shared instance holds. And every case carries its witness in the
 * same answer: a row the credential does see, so an absence is the gate
 * rather than an empty fixture.
 */
describe("the doors under an item answer only what the credential may read", () => {
  /** A registered edge type of this run's own, many-to-many so a case can
   *  hang several edges off one item. */
  async function kind(label: string): Promise<string> {
    const id = `mock.underitem.${label}.${ctx.runId}`;
    const registered = await client.registerEdgeType({
      id,
      cardinality: "many-to-many",
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    trackEdgeType(ctx, id);
    return id;
  }

  /** A bookmark, which the narrow credentials below cannot read. */
  async function hiddenItem(label: string): Promise<string> {
    const r = await client.createItem(
      createBookmark({ properties: { title: `ep-${label}` } }),
    );
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    trackItem(ctx, r.data.item.id);
    return r.data.item.id;
  }

  async function edge(
    source: string,
    target: string,
    edgeType: string,
  ): Promise<string> {
    const r = await client.createEdge({
      source_id: source,
      target_id: target,
      edge_type: edgeType,
    });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    trackEdge(ctx, r.data.edge.id);
    return r.data.edge.id;
  }

  it("leaves an edge of an unreadable kind out of GET /items/{id}/edges", async () => {
    const seen = await kind("out-seen");
    const unseen = await kind("out-unseen");
    const anchor = await scopedItem(client, "outbound-anchor");
    const target = await scopedItem(client, "outbound-target");
    const visibleEdge = await edge(anchor, target, seen);
    const hiddenEdge = await edge(anchor, target, unseen);

    // Reads the anchor's type, so the door's own gate passes, and holds
    // one of the two edge types. What it cannot see can only be the kind
    // of relationship.
    const narrow = await makeKey("underitem-out-narrow", {
      type_permissions: { "core.note": "read" },
      edge_permissions: { [seen]: "read" },
    });
    const narrowClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: narrow.key,
    });

    const page = await narrowClient.listItemEdges(anchor, { limit: 100 });
    expect(page.ok, JSON.stringify(page.error)).toBe(true);
    const ids = page.data.data.map((e) => e.id);
    expect(
      ids,
      "the credential could not see an edge of a kind it holds, so the door refuses more than the gate asks",
    ).toContain(visibleEdge);
    expect(
      ids,
      "the door disclosed an edge of a kind this credential may not read",
    ).not.toContain(hiddenEdge);

    // And the row is really there, so what changed is the credential's
    // reach and not the item's edges.
    const wide = await makeKey("underitem-out-wide", {
      type_permissions: { "*": "read" },
      edge_permissions: { "*": "read" },
    });
    const widePage = await new MarfaClient({
      baseUrl: apiUrl,
      apiKey: wide.key,
    }).listItemEdges(anchor, { limit: 100 });
    expect(widePage.ok, JSON.stringify(widePage.error)).toBe(true);
    expect(widePage.data.data.map((e) => e.id).sort()).toEqual(
      [visibleEdge, hiddenEdge].sort(),
    );
  });

  it("leaves an edge with an unreadable source out of GET /items/{id}/backrefs", async () => {
    const edgeType = await kind("back");
    const anchor = await scopedItem(client, "backref-anchor");
    const readableSource = await scopedItem(client, "backref-readable");
    const hiddenSource = await hiddenItem("backref-hidden");
    const visibleEdge = await edge(readableSource, anchor, edgeType);
    const hiddenEdge = await edge(hiddenSource, anchor, edgeType);

    // Holds every edge type, so what the door leaves out can only be the
    // source item's type — which this door never looked at, because its
    // anchor is the target.
    const narrow = await makeKey("underitem-back-narrow", {
      type_permissions: { "core.note": "read" },
      edge_permissions: { "*": "read" },
    });
    const narrowClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: narrow.key,
    });

    const page = await narrowClient.listItemBackrefs(anchor, { limit: 100 });
    expect(page.ok, JSON.stringify(page.error)).toBe(true);
    const ids = page.data.data.map((e) => e.id);
    expect(
      ids,
      "the credential could not see a backref whose source it may read, so the door refuses more than the gate asks",
    ).toContain(visibleEdge);
    expect(
      ids,
      "the door disclosed a relationship whose source is a type this credential may not read",
    ).not.toContain(hiddenEdge);

    const wide = await makeKey("underitem-back-wide", {
      type_permissions: { "*": "read" },
      edge_permissions: { "*": "read" },
    });
    const widePage = await new MarfaClient({
      baseUrl: apiUrl,
      apiKey: wide.key,
    }).listItemBackrefs(anchor, { limit: 100 });
    expect(widePage.ok, JSON.stringify(widePage.error)).toBe(true);
    expect(widePage.data.data.map((e) => e.id).sort()).toEqual(
      [visibleEdge, hiddenEdge].sort(),
    );
  });

  it("narrows the edges carried on an item read and on a bulk read", async () => {
    const seen = await kind("hydrate-seen");
    const unseen = await kind("hydrate-unseen");
    const anchor = await scopedItem(client, "hydrate-anchor");
    const target = await scopedItem(client, "hydrate-target");
    const hiddenSource = await hiddenItem("hydrate-hidden-source");
    const readableSource = await scopedItem(client, "hydrate-readable-source");
    const visibleEdge = await edge(anchor, target, seen);
    const hiddenKindEdge = await edge(anchor, target, unseen);
    const hiddenSourceEdge = await edge(hiddenSource, anchor, seen);
    // The inbound witness. Without a backref the narrow credential may
    // read, the block below is empty whatever the gate decides and the
    // absence asserted against it is an absence from nothing.
    const visibleBackref = await edge(readableSource, anchor, seen);

    const narrow = await makeKey("underitem-hydrate-narrow", {
      type_permissions: { "core.note": "read" },
      edge_permissions: { [seen]: "read" },
    });
    const narrowClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: narrow.key,
    });

    // The blocks are keyed by edge type, so a block that emptied has to
    // go rather than stand empty: an `unseen` key on the response says
    // this item has edges of that kind, which is the disclosure in the
    // shape of a map key.
    const read = await narrowClient.getItem(anchor);
    expect(read.ok, JSON.stringify(read.error)).toBe(true);
    const blocks = read.data.item.edges ?? {};
    expect(
      blocks[seen]?.edges.map((e) => e.id),
      "the item read dropped an edge of a kind the credential holds",
    ).toContain(visibleEdge);
    expect(
      Object.keys(blocks),
      "the item read named an edge type this credential may not read",
    ).not.toContain(unseen);

    // The inbound half of the same read, whose anchor is the target and
    // whose rows are therefore readable only through their sources.
    const withBackrefs = await narrowClient.getItemWithBackrefs(anchor);
    expect(withBackrefs.ok, JSON.stringify(withBackrefs.error)).toBe(true);
    const backIds = Object.values(withBackrefs.data.backrefs ?? {}).flatMap(
      (b) => b.edges.map((e) => e.id),
    );
    expect(
      backIds,
      "the item read dropped a backref whose source the credential may read",
    ).toContain(visibleBackref);
    expect(
      backIds,
      "the item read disclosed a backref whose source is a type this credential may not read",
    ).not.toContain(hiddenSourceEdge);

    // The item listing, through the same hydration the bulk read uses.
    // Requested rather than argued for: two doors reading one function is
    // not a reason to assert only one of them.
    // Narrowed to this file's own rows, because the page is capped and
    // the run's instance is shared: a listing of every note would put the
    // anchor's presence at the mercy of what else the run wrote.
    const listed = await narrowClient.listItems({
      source: ctx.source,
      type: "core.note",
      include: "edges",
      limit: 200,
    });
    expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
    const listedBlocks =
      listed.data.data.find((i) => i.id === anchor)?.edges ?? {};
    expect(
      listedBlocks[seen]?.edges.map((e) => e.id),
      "the item listing dropped an edge of a kind the credential holds",
    ).toContain(visibleEdge);
    expect(
      Object.keys(listedBlocks),
      "the item listing named an edge type this credential may not read",
    ).not.toContain(unseen);

    // The batched door through the same hydration.
    const bulk = await narrowClient.bulkGet([anchor], ["edges"]);
    expect(bulk.ok, JSON.stringify(bulk.error)).toBe(true);
    const bulkBlocks = bulk.data.items[0]?.edges ?? {};
    expect(
      bulkBlocks[seen]?.edges.map((e) => e.id),
      "the bulk read dropped an edge of a kind the credential holds",
    ).toContain(visibleEdge);
    expect(
      Object.keys(bulkBlocks),
      "the bulk read named an edge type this credential may not read",
    ).not.toContain(unseen);

    // The witness for all three: a credential that may read both types
    // and both kinds sees every row, so the absences above are the gate.
    const wide = await makeKey("underitem-hydrate-wide", {
      type_permissions: { "*": "read" },
      edge_permissions: { "*": "read" },
    });
    const wideClient = new MarfaClient({ baseUrl: apiUrl, apiKey: wide.key });
    const wideRead = await wideClient.getItemWithBackrefs(anchor);
    expect(wideRead.ok, JSON.stringify(wideRead.error)).toBe(true);
    const wideOut = Object.values(wideRead.data.item.edges ?? {}).flatMap((b) =>
      b.edges.map((e) => e.id),
    );
    expect(wideOut.sort()).toEqual([visibleEdge, hiddenKindEdge].sort());
    expect(
      Object.values(wideRead.data.backrefs ?? {})
        .flatMap((b) => b.edges.map((e) => e.id))
        .sort(),
    ).toEqual([hiddenSourceEdge, visibleBackref].sort());
  });
  it("pages a per-item door to the end though whole pages are dropped", async () => {
    // The two per-item doors publish the same paging rule the edge
    // listing does — short pages, an empty page while `has_more` is true,
    // and a cursor that still reaches the end — so one of them asserts
    // it. The backref door, because it is the one whose rows are dropped
    // by the source's type rather than by their own kind, so a page can
    // empty without the filter naming anything.
    const edgeType = await kind("paged");
    const target = await scopedItem(client, "paged-target");
    const readable: string[] = [];
    // Six inbound edges, mostly from items the narrow credential cannot
    // read, so a walk two at a time meets a page with nothing on it.
    // The readable rows sit at the ends and four unreadable ones run
    // between them, so a page of two lands entirely inside that run
    // whichever direction the door walks.
    for (const kindOfSource of [
      "note",
      "hidden",
      "hidden",
      "hidden",
      "hidden",
      "note",
    ] as const) {
      const source =
        kindOfSource === "note"
          ? await scopedItem(client, "paged-src")
          : await hiddenItem("paged-src");
      const id = await edge(source, target, edgeType);
      if (kindOfSource === "note") readable.push(id);
    }

    const narrow = await makeKey("underitem-paged-narrow", {
      type_permissions: { "core.note": "read" },
      edge_permissions: { "*": "read" },
    });
    const narrowClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: narrow.key,
    });

    const seen: string[] = [];
    let emptyPages = 0;
    let cursor: string | undefined;
    for (let page = 0; page < 12; page++) {
      const answer = await narrowClient.listItemBackrefs(target, {
        edge_type: edgeType,
        limit: 2,
        cursor,
      });
      expect(answer.ok, JSON.stringify(answer.error)).toBe(true);
      seen.push(...answer.data.data.map((e) => e.id));
      if (answer.data.data.length === 0 && answer.data.has_more) emptyPages++;
      if (!answer.data.has_more) {
        cursor = undefined;
        break;
      }
      cursor = answer.data.cursor ?? undefined;
      expect(
        cursor,
        "the door says there is more and names no cursor",
      ).toBeDefined();
    }
    expect(
      cursor,
      "the walk ran out of pages before the door ran out of rows",
    ).toBeUndefined();
    expect(
      emptyPages,
      "no page came back empty, so this case is not about the thing it claims",
    ).toBeGreaterThan(0);
    expect(seen.sort()).toEqual([...readable].sort());
  });

  it("refuses a filter term naming a relationship the credential may not read", async () => {
    const seen = await kind("filter-seen");
    const unseen = await kind("filter-unseen");
    const source = await scopedItem(client, "filter-source");
    const target = await scopedItem(client, "filter-target");
    const hiddenSource = await hiddenItem("filter-hidden-source");
    await edge(source, target, seen);
    await edge(source, target, unseen);
    await edge(hiddenSource, target, seen);

    const narrow = await makeKey("underitem-filter-narrow", {
      type_permissions: { "core.note": "read" },
      edge_permissions: { [seen]: "read" },
    });
    const narrowClient = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: narrow.key,
    });

    // The witness, and it comes first: a term naming a kind this
    // credential holds is answered, so the refusals below are about the
    // credential's reach and not about the shorthand being refused
    // outright.
    const allowed = await narrowClient.listItems({
      edge: { [seen]: target },
      limit: 100,
    });
    expect(allowed.ok, JSON.stringify(allowed.error)).toBe(true);
    expect(allowed.data.data.map((i) => i.id)).toContain(source);

    // `edge[X]=<target>` answers with the items that point at the target,
    // so honoring it would say an edge of that kind exists between two
    // items the caller named and the page named — the fact
    // `GET /edges/{id}` refuses this credential one edge at a time.
    const refusedKind = await narrowClient.listItems({
      edge: { [unseen]: target },
      limit: 100,
    });
    expect(
      refusedKind.status,
      `a filter naming an unreadable edge type was answered: ${JSON.stringify(refusedKind.data)}`,
    ).toBe(403);
    expect(refusedKind.error?.error.code).toBe("edge_permission_denied");

    // The full form of the same term, which is the shorthand's twin and
    // would otherwise be the way around it.
    const refusedFullForm = await narrowClient.listItems({
      filter: `edge[${unseen}] eq "${target}"`,
      limit: 100,
    });
    expect(
      refusedFullForm.status,
      `the full filter form was answered where the shorthand was refused: ${JSON.stringify(refusedFullForm.data)}`,
    ).toBe(403);
    expect(refusedFullForm.error?.error.code).toBe("edge_permission_denied");

    // The inbound direction, where the caller names the source and an
    // edge's readability is the source's. The edge type here is one this
    // credential holds, so what refuses it can only be the anchor's type.
    const refusedSource = await narrowClient.listItems({
      backref: { [seen]: hiddenSource },
      limit: 100,
    });
    expect(
      refusedSource.status,
      `a backref filter anchored on an unreadable item was answered: ${JSON.stringify(refusedSource.data)}`,
    ).toBe(403);
    expect(refusedSource.error?.error.code).toBe("type_not_permitted");

    // And its witness: the same direction anchored on an item this
    // credential may read is answered.
    const allowedSource = await narrowClient.listItems({
      backref: { [seen]: source },
      limit: 100,
    });
    expect(allowedSource.ok, JSON.stringify(allowedSource.error)).toBe(true);
    expect(allowedSource.data.data.map((i) => i.id)).toContain(target);

    // `GET /search` takes the same grammar and compiles the same term, so
    // it answers the same way. A door that refused the term while its
    // sibling answered it would be the disclosure moved rather than
    // closed, which is how the listing and the point check came to
    // disagree in the first place.
    const searchWitness = await narrowClient.search("ep-filter-source", {
      filter: `edge[${seen}] eq "${target}"`,
    });
    expect(searchWitness.ok, JSON.stringify(searchWitness.error)).toBe(true);
    expect(
      searchWitness.data.results.map((r) => r.item.id),
      "search dropped a row matching a term the credential may read",
    ).toContain(source);

    const searchRefused = await narrowClient.search("ep-filter-source", {
      filter: `edge[${unseen}] eq "${target}"`,
    });
    expect(
      searchRefused.status,
      `search answered a filter naming an unreadable edge type: ${JSON.stringify(searchRefused.data)}`,
    ).toBe(403);
    expect(searchRefused.error?.error.code).toBe("edge_permission_denied");
  });
});
