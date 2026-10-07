import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackEdge,
  trackEdgeType,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { createBookmark, createNote } from "../../generators/items.js";
import {
  approvedAppToken,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
} from "../../utils/fresh-server.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "edge-hidden-limits",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

// Graph rules judge the whole graph, hidden edges included: each pins what
// a key is told, which says something hidden exists and never its id or type.
describe("a graph refusal owed to an edge the key cannot see", () => {
  /** Writes notes and every edge type, and holds nothing on bookmarks. */
  let writer: MarfaClient;

  async function note(): Promise<string> {
    const r = await writer.createItem(createNote());
    expect(r.status).toBe(201);
    trackItem(ctx, r.data.item.id);
    return r.data.item.id;
  }

  async function hidden(): Promise<string> {
    const r = await client.createItem(createBookmark({ source: ctx.source }));
    expect(r.status).toBe(201);
    trackItem(ctx, r.data.item.id);
    return r.data.item.id;
  }

  async function parentOf(
    parent: string,
    child: string,
    edgeType = "parent-of",
  ): Promise<string> {
    const r = await client.createEdge({
      source_id: parent,
      target_id: child,
      edge_type: edgeType,
    });
    expect(r.status).toBe(201);
    trackEdge(ctx, r.data.edge.id);
    return r.data.edge.id;
  }

  async function give(parent: string, child: string, edgeType = "parent-of") {
    const r = await writer.createEdge({
      source_id: parent,
      target_id: child,
      edge_type: edgeType,
    });
    if (r.ok) trackEdge(ctx, r.data.edge.id);
    return r;
  }

  beforeAll(async () => {
    const minted = await client.createKey({
      label: "edge-hidden-limits",
      source: `${ctx.source}-edge-hidden-limits`,
      permissions: [],
      type_permissions: { "core.note": "write" },
      edge_permissions: { "*": "write" },
    });
    expect(minted.ok).toBe(true);
    trackKey(ctx, minted.data.id);
    writer = new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
  });

  it("refuses a second parent the key cannot see, naming only the child", async () => {
    const child = await note();
    const secret = await hidden();
    await parentOf(secret, child);
    // The key sees no parent: the edge is its hidden source's statement.
    const seen = await writer.listItemBackrefs(child);
    expect(seen.status).toBe(200);
    expect(seen.data.data).toEqual([]);

    const refused = await give(await note(), child);
    expect(refused.status).toBe(400);
    expect(refused.error?.error).toEqual({
      code: "edge_constraint_violation",
      message:
        'Edge "parent-of" is one-to-many on the target side; target already has an inbound edge of this type',
      details: {
        edge_type: "parent-of",
        target_id: child,
        constraint: "cardinality",
      },
    });
    expect(JSON.stringify(refused.error)).not.toContain(secret);
    expect(JSON.stringify(refused.error)).not.toContain("core.bookmark");

    // The witness: the same write lands where the child has no parent.
    expect((await give(await note(), await note())).status).toBe(201);
  });

  it("refuses an edge that closes a cycle only through an edge the key cannot see, naming only its own ends", async () => {
    // a parent-of b is written over b -> secret -> a, whose second edge
    // has a source the key cannot read.
    const a = await note();
    const b = await note();
    const secret = await hidden();
    await parentOf(b, secret);
    await parentOf(secret, a);
    const seen = await writer.listItemBackrefs(a);
    expect(seen.status).toBe(200);
    expect(seen.data.data).toEqual([]);

    const refused = await give(a, b);
    expect(refused.status).toBe(400);
    expect(refused.error?.error).toEqual({
      code: "edge_cycle",
      message: 'Edge "parent-of" would close a cycle',
      details: { edge_type: "parent-of", source_id: a, target_id: b },
    });
    expect(JSON.stringify(refused.error)).not.toContain(secret);
    expect(JSON.stringify(refused.error)).not.toContain("core.bookmark");

    // The witness: the same write lands where the hidden edge leads nowhere back.
    const c = await note();
    const d = await note();
    await parentOf(d, await hidden());
    expect((await give(c, d)).status).toBe(201);
  });

  it("refuses a successor the key cannot see on a one-to-one type, naming only the target", async () => {
    const older = await note();
    const secret = await hidden();
    await parentOf(secret, older, "supersedes");
    const seen = await writer.listItemBackrefs(older);
    expect(seen.status).toBe(200);
    expect(seen.data.data).toEqual([]);

    const refused = await give(await note(), older, "supersedes");
    expect(refused.status).toBe(400);
    expect(refused.error?.error).toEqual({
      code: "edge_constraint_violation",
      message:
        'Edge "supersedes" is one-to-one; target already has one inbound edge of this type',
      details: {
        edge_type: "supersedes",
        target_id: older,
        constraint: "cardinality",
      },
    });
    expect(JSON.stringify(refused.error)).not.toContain(secret);
    expect(JSON.stringify(refused.error)).not.toContain("core.bookmark");

    // The witness: the same write lands where no successor is hidden.
    expect((await give(await note(), await note(), "supersedes")).status).toBe(
      201,
    );
  });
});

describe("what a key is told of an item it cannot read through a readable one", () => {
  let writer: MarfaClient;

  beforeAll(async () => {
    const minted = await client.createKey({
      label: "edge-hidden-reach",
      source: `${ctx.source}-edge-hidden-reach`,
      permissions: [],
      type_permissions: { "core.note": "write" },
      edge_permissions: { "*": "write" },
    });
    expect(minted.ok).toBe(true);
    trackKey(ctx, minted.data.id);
    writer = new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
  });

  async function pair(edgeType: string): Promise<{
    note: string;
    secret: string;
    edge: string;
  }> {
    const n = await writer.createItem(createNote());
    expect(n.status).toBe(201);
    trackItem(ctx, n.data.item.id);
    const b = await client.createItem(createBookmark({ source: ctx.source }));
    expect(b.status).toBe(201);
    trackItem(ctx, b.data.item.id);
    const e = await client.createEdge({
      source_id: n.data.item.id,
      target_id: b.data.item.id,
      edge_type: edgeType,
    });
    expect(e.status).toBe(201);
    trackEdge(ctx, e.data.edge.id);
    // The witness that the key cannot read the target: its map, and the read.
    expect((await writer.getCurrentKey()).data.type_permissions).toEqual({
      "core.note": "write",
    });
    expect((await writer.getItem(b.data.item.id)).ok).toBe(false);
    return {
      note: n.data.item.id,
      secret: b.data.item.id,
      edge: e.data.edge.id,
    };
  }

  it("names a hidden target's id on an edge the key may read", async () => {
    const { note, secret, edge } = await pair("about");
    const listed = await writer.listItemEdges(note);
    expect(listed.status).toBe(200);
    expect(listed.data.data.map((e) => e.target_id)).toEqual([secret]);
    const byId = await writer.getEdge(edge);
    expect(byId.status).toBe(200);
    expect(byId.data.edge.target_id).toBe(secret);
  });

  it("trashes a hidden child with the parent the key deletes", async () => {
    const { note, secret } = await pair("parent-of");
    expect((await client.getItem(secret)).data.item.state).toBe("active");
    expect((await writer.deleteItem(note)).status).toBe(200);
    expect((await client.getItem(secret)).status).toBe(404);
    const listed = await client.listItems({
      state: "trashed",
      source: ctx.source,
      limit: 200,
    });
    expect(listed.data.data.map((i) => i.id)).toContain(secret);
  });

  it("refuses a delete held by a blocking edge it cannot see, naming no hidden id", async () => {
    const edgeType = `mock.block.${ctx.runId}`;
    const registered = await client.registerEdgeType({
      id: edgeType,
      cardinality: "many-to-many",
      cascade_on_delete: "block",
    });
    expect(registered.status).toBe(201);
    trackEdgeType(ctx, edgeType);
    const held = await writer.createItem(createNote());
    expect(held.status).toBe(201);
    trackItem(ctx, held.data.item.id);
    const secret = await client.createItem(
      createBookmark({ source: ctx.source }),
    );
    expect(secret.status).toBe(201);
    trackItem(ctx, secret.data.item.id);
    const hiddenEdge = await client.createEdge({
      source_id: secret.data.item.id,
      target_id: held.data.item.id,
      edge_type: edgeType,
    });
    expect(hiddenEdge.status).toBe(201);
    trackEdge(ctx, hiddenEdge.data.edge.id);
    // And one the key could read, but whose far end it cannot.
    const beyond = await client.createItem(
      createBookmark({ source: ctx.source }),
    );
    expect(beyond.status).toBe(201);
    trackItem(ctx, beyond.data.item.id);
    const outward = await client.createEdge({
      source_id: held.data.item.id,
      target_id: beyond.data.item.id,
      edge_type: edgeType,
    });
    expect(outward.status).toBe(201);
    trackEdge(ctx, outward.data.edge.id);

    const refused = await writer.deleteItem(held.data.item.id);
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("edge_constraint_violation");
    expect(refused.error?.error.details?.blocking_edges).toEqual([]);
    const body = JSON.stringify(refused.error);
    for (const id of [
      secret.data.item.id,
      hiddenEdge.data.edge.id,
      beyond.data.item.id,
      outward.data.edge.id,
    ]) {
      expect(body).not.toContain(id);
    }
    expect(refused.error?.error.message).not.toMatch(/\d+ edge/);
    expect((await writer.getItem(held.data.item.id)).status).toBe(200);

    // The witness: a blocking edge the key may read is named.
    const own = await writer.createItem(createNote());
    expect(own.status).toBe(201);
    trackItem(ctx, own.data.item.id);
    const seen = await writer.createEdge({
      source_id: own.data.item.id,
      target_id: held.data.item.id,
      edge_type: edgeType,
    });
    expect(seen.status).toBe(201);
    trackEdge(ctx, seen.data.edge.id);
    const named = await writer.deleteItem(held.data.item.id);
    expect(
      (named.error?.error.details?.blocking_edges as Array<{ id: string }>).map(
        (e) => e.id,
      ),
    ).toEqual([seen.data.edge.id]);
    expect(named.error?.error.message).toContain("blocked by 1 edge(s)");
  });
});

describe("a delete refused by a blocking edge whose type the key cannot read", () => {
  it("counts the edge without naming it, where a key that reads the type is told which", async () => {
    const edgeType = `mock.blockkind.${ctx.runId}`;
    const registered = await client.registerEdgeType({
      id: edgeType,
      cardinality: "many-to-many",
      cascade_on_delete: "block",
    });
    expect(registered.status).toBe(201);
    trackEdgeType(ctx, edgeType);

    async function keyWith(
      name: string,
      edgePermissions: Record<string, "read" | "write">,
    ): Promise<MarfaClient> {
      const minted = await client.createKey({
        label: `edge-hidden-kind-${name}`,
        source: `${ctx.source}-edge-hidden-kind-${name}`,
        permissions: [],
        type_permissions: { "core.note": "write" },
        edge_permissions: edgePermissions,
      });
      expect(minted.ok).toBe(true);
      trackKey(ctx, minted.data.id);
      return new MarfaClient({ baseUrl: apiUrl, apiKey: minted.data.key });
    }
    const blind = await keyWith("blind", { about: "write" });
    const sighted = await keyWith("sighted", {
      about: "write",
      [edgeType]: "read",
    });

    async function note(): Promise<string> {
      const r = await client.createItem(createNote({ source: ctx.source }));
      expect(r.status).toBe(201);
      trackItem(ctx, r.data.item.id);
      return r.data.item.id;
    }
    const held = await note();
    const holder = await note();
    const inbound = await client.createEdge({
      source_id: holder,
      target_id: held,
      edge_type: edgeType,
    });
    expect(inbound.status).toBe(201);
    trackEdge(ctx, inbound.data.edge.id);
    const heldOutward = await note();
    const outbound = await client.createEdge({
      source_id: held,
      target_id: heldOutward,
      edge_type: edgeType,
    });
    expect(outbound.status).toBe(201);
    trackEdge(ctx, outbound.data.edge.id);

    // Both ends of both items are readable to either key: the type is what
    // the blind key cannot read.
    expect((await blind.getItem(held)).status).toBe(200);
    expect((await blind.getEdge(inbound.data.edge.id)).status).toBe(404);

    const refused = await blind.deleteItem(held);
    expect(refused.status).toBe(400);
    expect(refused.error?.error).toEqual({
      code: "edge_constraint_violation",
      message: `Cannot delete item ${held}: blocked by an edge with cascade_on_delete=block`,
      details: { root_item_id: held, blocking_edges: [] },
    });
    const body = JSON.stringify(refused.error);
    for (const hiddenId of [
      holder,
      heldOutward,
      inbound.data.edge.id,
      outbound.data.edge.id,
      edgeType,
    ]) {
      expect(body).not.toContain(hiddenId);
    }
    expect((await client.getItem(held)).data.item.state).toBe("active");

    // The witness: a key that reads the type is told the blocking edges.
    const named = await sighted.deleteItem(held);
    expect(named.status).toBe(400);
    expect(named.error?.error.code).toBe("edge_constraint_violation");
    const listed = named.error?.error.details?.blocking_edges as
      { id: string; edge_type: string }[] | undefined;
    expect(listed?.map((e) => e.id).sort()).toEqual(
      [inbound.data.edge.id, outbound.data.edge.id].sort(),
    );
    expect(listed?.every((e) => e.edge_type === edgeType)).toBe(true);
    expect(named.error?.error.message).toContain("blocked by 2 edge(s)");
  });
});

describe("a delete refused for a live grant it would take with it", () => {
  it(
    "names nothing of a grant the key cannot read",
    async () => {
      // Its own server: approving an app creates the one owner an instance has.
      const server = await bootFreshServer("hidden-grant");
      try {
        await approvedAppToken(server);
        const as = (
          key: string,
          method: string,
          path: string,
          body?: unknown,
        ) =>
          fetch(`${server.apiUrl}${path}`, {
            method,
            headers: {
              Authorization: `Bearer ${key}`,
              ...(body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        const grants = (await (
          await as(
            server.workingKey,
            "GET",
            "/items?type=system.connection&include=system",
          )
        ).json()) as { data: { id: string; properties: { status: string } }[] };
        const grant = grants.data.find(
          (row) => row.properties.status === "active",
        );
        expect(grant, "the approval projected no live grant").toBeDefined();
        const note = (await (
          await as(server.workingKey, "POST", "/items", {
            type: "core.note",
            properties: { body: "holds a grant" },
          })
        ).json()) as { item: { id: string } };
        const placed = await as(server.workingKey, "POST", "/edges", {
          source_id: note.item.id,
          target_id: grant!.id,
          edge_type: "parent-of",
        });
        expect(placed.status).toBe(201);
        const minted = (await (
          await as(server.workingKey, "POST", "/keys", {
            label: "hidden-grant-narrow",
            source: "hidden-grant-narrow",
            permissions: [],
            type_permissions: { "core.note": "write" },
          })
        ).json()) as { key: string };

        const refused = await as(
          minted.key,
          "DELETE",
          `/items/${note.item.id}`,
        );
        const text = await refused.text();
        expect(refused.status, text).toBe(400);
        expect(JSON.parse(text)).toMatchObject({
          error: { code: "validation_error" },
        });
        expect(text).not.toContain(grant!.id);
        expect(text).not.toMatch(/Grant|Connection|grants/);

        // The witness: a key that reads the grant is told which one.
        const named = await as(
          server.workingKey,
          "DELETE",
          `/items/${note.item.id}`,
        );
        expect(named.status).toBe(400);
        expect(await named.text()).toContain(grant!.id);
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS * 2,
  );
});
