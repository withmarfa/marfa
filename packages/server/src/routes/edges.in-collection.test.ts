import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * `in-collection` ships in core but its target type does not: a collection is
 * a user-space concept, so a deployment registers `user.collection` itself,
 * declaring the `container` role so the edge will admit it. These tests
 * register it the way a user would and then exercise the membership relation
 * end to end.
 *
 * The subtype declares no role of its own: a container's descendants are
 * containers, the same way a subtype already satisfies an ancestor's name
 * constraint.
 */

let ctx: TestContext;

const COLLECTION_TYPE = "user.collection";
const SMART_COLLECTION_TYPE = "user.collection.smart";

interface ItemResponse {
  item: { id: string };
}

interface ErrorResponse {
  error: { code: string; details?: { constraint?: string } };
}

async function registerType(body: Record<string, unknown>): Promise<void> {
  const res = await request(ctx.app, "POST", "/types", {
    key: ctx.adminKey,
    body,
  });
  // The type registry is a process-level singleton, so a sibling suite that
  // registered the same identifier first is not a failure here.
  if (res.status === 201) return;
  const data = (await res.clone().json()) as ErrorResponse;
  expect(
    data.error.code,
    `POST /types ${String(body.id)} -> ${String(res.status)}: ${await res.text()}`,
  ).toBe("type_already_exists");
}

async function createItem(type: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body:
      type === "core.note"
        ? { type, properties: { body: `note-${String(Math.random())}` } }
        : { type, properties: { name: `collection-${String(Math.random())}` } },
  });
  expect(
    res.status,
    `POST /items ${type} -> ${String(res.status)}: ${await res.clone().text()}`,
  ).toBe(201);
  const data = (await res.json()) as ItemResponse;
  return data.item.id;
}

/** Media types carry `title`, unlike the note/collection shapes above. */
async function createMedia(type: string, title: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: { type, properties: { title } },
  });
  expect(
    res.status,
    `POST /items ${type} -> ${String(res.status)}: ${await res.clone().text()}`,
  ).toBe(201);
  const data = (await res.json()) as ItemResponse;
  return data.item.id;
}

async function joinCollection(
  memberId: string,
  collectionId: string,
  properties?: Record<string, unknown>,
): Promise<Response> {
  return await request(ctx.app, "POST", "/edges", {
    key: ctx.adminKey,
    body: {
      source_id: memberId,
      target_id: collectionId,
      edge_type: "in-collection",
      ...(properties ? { properties } : {}),
    },
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
  await registerType({
    id: COLLECTION_TYPE,
    name: "Collection",
    description: "A named set of items.",
    version: 1,
    roles: ["container"],
    fields: {
      name: { type: "string", required: true, description: "Display name." },
    },
  });
  await registerType({
    id: SMART_COLLECTION_TYPE,
    name: "Smart collection",
    description: "A collection whose membership is computed.",
    parent: COLLECTION_TYPE,
    version: 1,
    fields: {
      name: { type: "string", required: true, description: "Display name." },
    },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("in-collection membership", () => {
  it("puts an item in a collection", async () => {
    const member = await createItem("core.note");
    const collection = await createItem(COLLECTION_TYPE);
    const res = await joinCollection(member, collection, { position: 1 });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      edge: { edge_type: string; properties?: { position?: number } };
    };
    expect(data.edge.edge_type).toBe("in-collection");
    expect(data.edge.properties?.position).toBe(1);
  });

  it("lets one item belong to several collections", async () => {
    const member = await createItem("core.note");
    const first = await createItem(COLLECTION_TYPE);
    const second = await createItem(COLLECTION_TYPE);
    expect((await joinCollection(member, first)).status).toBe(201);
    expect((await joinCollection(member, second)).status).toBe(201);

    const edges = await request(ctx.app, "GET", `/items/${member}/edges`, {
      key: ctx.adminKey,
    });
    const data = (await edges.json()) as {
      data: { edge_type: string; target_id: string }[];
    };
    const targets = data.data
      .filter((e) => e.edge_type === "in-collection")
      .map((e) => e.target_id)
      .sort();
    expect(targets).toEqual([first, second].sort());
  });

  it("lets one collection hold several items", async () => {
    const collection = await createItem(COLLECTION_TYPE);
    const one = await createItem("core.note");
    const two = await createItem("core.note");
    expect((await joinCollection(one, collection)).status).toBe(201);
    expect((await joinCollection(two, collection)).status).toBe(201);

    const back = await request(
      ctx.app,
      "GET",
      `/items/${collection}/backrefs`,
      { key: ctx.adminKey },
    );
    const data = (await back.json()) as {
      data: { edge_type: string; source_id: string }[];
    };
    const sources = data.data
      .filter((e) => e.edge_type === "in-collection")
      .map((e) => e.source_id)
      .sort();
    expect(sources).toEqual([one, two].sort());
  });

  it("still refuses the same membership twice", async () => {
    const member = await createItem("core.note");
    const collection = await createItem(COLLECTION_TYPE);
    expect((await joinCollection(member, collection)).status).toBe(201);
    const again = await joinCollection(member, collection);
    expect(again.status).toBe(400);
    const data = (await again.json()) as ErrorResponse;
    expect(data.error.details?.constraint).toBe("duplicate");
  });
});

describe("in-collection refusals", () => {
  it("refuses a collection as a member of another collection", async () => {
    const inner = await createItem(COLLECTION_TYPE);
    const outer = await createItem(COLLECTION_TYPE);
    const res = await joinCollection(inner, outer);
    expect(res.status).toBe(400);
    const data = (await res.json()) as ErrorResponse;
    expect(data.error.code).toBe("edge_constraint_violation");
    expect(data.error.details?.constraint).toBe("nesting");
  });

  it("refuses a subtype of collection as a member too", async () => {
    const inner = await createItem(SMART_COLLECTION_TYPE);
    const outer = await createItem(COLLECTION_TYPE);
    const res = await joinCollection(inner, outer);
    expect(res.status).toBe(400);
    const data = (await res.json()) as ErrorResponse;
    expect(data.error.details?.constraint).toBe("nesting");
  });

  it("refuses a target that is not a collection", async () => {
    const member = await createItem("core.note");
    const notACollection = await createItem("core.note");
    const res = await joinCollection(member, notACollection);
    expect(res.status).toBe(400);
    const data = (await res.json()) as ErrorResponse;
    expect(data.error.code).toBe("edge_constraint_violation");
    // The declarative target constraint catches this one, not the nesting rule.
    expect(data.error.details?.constraint).toBeUndefined();
  });

  it("refuses every container type as a member, not just user.collection", async () => {
    // The membership edge accepts every type declaring the container role.
    // The nesting refusal must track that same rule: a guard covering one
    // container lets the others nest, which is how two series once held
    // each other.
    const series = await createMedia("core.media.series", "Signal Hill");
    const album = await createMedia("core.media.album", "Low Tide");
    const collection = await createItem(COLLECTION_TYPE);

    for (const [source, target, label] of [
      [series, collection, "series in collection"],
      [album, collection, "album in collection"],
      [collection, series, "collection in series"],
      [album, series, "album in series"],
      [series, album, "series in album"],
    ] as const) {
      const res = await joinCollection(source, target);
      expect(res.status, label).toBe(400);
      const data = (await res.json()) as ErrorResponse;
      expect(data.error.details?.constraint, label).toBe("nesting");
    }
  });

  it("cannot close a two-node containment cycle", async () => {
    // The exact shape driven against a live server while the guard was
    // narrow: series A in series B landed, then series B in series A landed,
    // and the two answered "where does this sit" with each other. With the
    // refusal derived from the target list, neither direction can start.
    const a = await createMedia("core.media.series", "Ouroboros A");
    const b = await createMedia("core.media.series", "Ouroboros B");
    expect((await joinCollection(a, b)).status).toBe(400);
    expect((await joinCollection(b, a)).status).toBe(400);
  });
});

describe("in-collection deletion", () => {
  // A single-item GET answers 200 for a trashed item too, so "still responds"
  // proves nothing about cascade. The discriminating fact is the member's
  // state: orphan semantics mean deleting the container must not move the
  // member out of `active`.
  async function stateOf(id: string): Promise<string> {
    const res = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { item: { state: string } };
    return data.item.state;
  }

  it("leaves members active when the collection is deleted", async () => {
    const member = await createItem("core.note");
    const collection = await createItem(COLLECTION_TYPE);
    expect((await joinCollection(member, collection)).status).toBe(201);

    const del = await request(ctx.app, "DELETE", `/items/${collection}`, {
      key: ctx.adminKey,
    });
    expect(del.status).toBe(200);

    expect(await stateOf(member)).toBe("active");
  });

  it("leaves members active when the collection is purged outright", async () => {
    // The hard-delete path is the one that actually removes edge rows, so it
    // is where a wrongly-cascading implementation would take the member too.
    const member = await createItem("core.note");
    const collection = await createItem(COLLECTION_TYPE);
    expect((await joinCollection(member, collection)).status).toBe(201);

    await request(ctx.app, "DELETE", `/items/${collection}`, {
      key: ctx.adminKey,
    });
    const purge = await request(
      ctx.app,
      "DELETE",
      `/items/${collection}/purge`,
      { key: ctx.adminKey },
    );
    expect(purge.status).toBe(200);

    expect(await stateOf(member)).toBe("active");

    // The membership edge went with its container; the member did not.
    const edges = await request(ctx.app, "GET", `/items/${member}/edges`, {
      key: ctx.adminKey,
    });
    const data = (await edges.json()) as { data: { edge_type: string }[] };
    expect(data.data.filter((e) => e.edge_type === "in-collection")).toEqual(
      [],
    );
  });
});

describe("in-collection media membership", () => {
  it("joins an episode to its series", async () => {
    const series = await createMedia("core.media.series", "Signal Hill");
    const episode = await createMedia("core.media.episode", "Pilot");
    const res = await joinCollection(episode, series, { position: 1 });
    expect(res.status).toBe(201);
  });

  it("lets a crossover special sit in two series", async () => {
    const one = await createMedia("core.media.series", "Signal Hill");
    const two = await createMedia("core.media.series", "Harbour Lights");
    const special = await createMedia("core.media.episode", "The Crossing");
    expect((await joinCollection(special, one)).status).toBe(201);
    expect((await joinCollection(special, two)).status).toBe(201);
  });

  it("joins a song to its album the same way", async () => {
    const album = await createMedia("core.media.album", "Low Tide");
    const song = await createMedia("core.media.song", "Undertow");
    const res = await joinCollection(song, album, { position: 3 });
    expect(res.status).toBe(201);
  });

  it("orphans, never deletes, episodes when their series is purged", async () => {
    // State-checked, not just "GET answers": a trashed episode also answers
    // 200, so the old shape passed even under a cascading delete. Purge is
    // the path that removes edge rows, so it is where a wrong cascade would
    // take the episode with the series.
    const series = await createMedia("core.media.series", "Signal Hill");
    const episode = await createMedia("core.media.episode", "Finale");
    expect((await joinCollection(episode, series)).status).toBe(201);

    await request(ctx.app, "DELETE", `/items/${series}`, {
      key: ctx.adminKey,
    });
    const purge = await request(ctx.app, "DELETE", `/items/${series}/purge`, {
      key: ctx.adminKey,
    });
    expect(purge.status).toBe(200);

    const survivor = await request(ctx.app, "GET", `/items/${episode}`, {
      key: ctx.adminKey,
    });
    expect(survivor.status).toBe(200);
    const data = (await survivor.json()) as { item: { state: string } };
    expect(data.item.state).toBe("active");
  });
});
