/**
 * D32's one rule at the wire: nothing writes to an item an integration owns.
 * The owning integration re-syncs its mirror (with faithful-mirror null
 * semantics); everyone else, the operator key included, is refused toward
 * promotion, which mints a user-owned copy joined by derived-from. Items
 * outside integration provenance are untouched by the rule, which is also
 * what keeps sync (a client, not an integration) unaffected.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
let memberKey: string;

const MIRROR_SOURCE = "integration:acme.mirror";

beforeAll(async () => {
  ctx = await createTestContext();

  // Minted from the space key, not the operator key: a mint from an operator
  // caller produces another operator key, which is space-less and is not the
  // ordinary member this case is about.
  const memberRes = await request(ctx.app, "POST", "/keys", {
    key: ctx.spaceKey,
    body: {
      label: "mirror-member",
      source: "mirror-member-src",
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
    },
  });
  ({ key: memberKey } = (await memberRes.json()) as { key: string });
});

afterAll(async () => {
  await ctx.cleanup();
});

/**
 * An integration's mirror of an external record, written through the store:
 * nothing this server mints can be the owning integration, so the store is
 * the only writer a mirror has.
 */
async function createMirror(sourceId: string): Promise<string> {
  const row = await ctx.storage.items.create(
    {
      type: "core.bookmark",
      source: MIRROR_SOURCE,
      source_id: sourceId,
      properties: {
        title: "Mirrored",
        url: "https://upstream.example/a",
        body: "as synced",
      },
    },
    ctx.spaceId,
  );
  return row.id;
}

describe("the mirror rule", () => {
  it("refuses a member write to an integration-owned item", async () => {
    const id = await createMirror(`m-${String(Math.random()).slice(2)}`);
    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: memberKey,
      body: { properties: { title: "edited by hand" } },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("integration_owned");
  });

  it("refuses the operator key too — one rule, not two", async () => {
    const id = await createMirror(`m-${String(Math.random()).slice(2)}`);
    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.spaceKey,
      body: { properties: { title: "admin edit" } },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("integration_owned");
  });

  it("promotes to a user-owned copy joined by derived-from, untouched by re-sync", async () => {
    const sourceId = `m-${String(Math.random()).slice(2)}`;
    const id = await createMirror(sourceId);

    const promoted = await request(ctx.app, "POST", `/items/${id}/promote`, {
      key: memberKey,
    });
    expect(promoted.status).toBe(201);
    const promotedBody = (await promoted.json()) as {
      item: { id: string; source: string; properties: Record<string, unknown> };
    };
    expect(promotedBody.item.id).not.toBe(id);
    expect(promotedBody.item.source.startsWith("integration:")).toBe(false);
    expect(promotedBody.item.properties.title).toBe("Mirrored");

    const edges = await request(
      ctx.app,
      "GET",
      `/items/${promotedBody.item.id}/edges`,
      {
        key: ctx.spaceKey,
      },
    );
    const edgesBody = (await edges.json()) as {
      data: { edge_type: string; target_id: string }[];
    };
    expect(
      edgesBody.data.some(
        (e) => e.edge_type === "derived-from" && e.target_id === id,
      ),
    ).toBe(true);

    // The promoted copy is yours to edit; the mirror keeps re-syncing.
    const edit = await request(
      ctx.app,
      "PATCH",
      `/items/${promotedBody.item.id}`,
      { key: memberKey, body: { properties: { title: "My title" } } },
    );
    expect(edit.status).toBe(200);

    // The upstream moves: the owning integration re-syncs its mirror.
    await ctx.storage.items.update(
      id,
      { properties: { title: "Upstream renamed again" } },
      ctx.spaceId,
    );

    const promotedAfter = await request(
      ctx.app,
      "GET",
      `/items/${promotedBody.item.id}`,
      { key: ctx.spaceKey },
    );
    const promotedAfterBody = (await promotedAfter.json()) as {
      item: { properties: Record<string, unknown> };
    };
    expect(promotedAfterBody.item.properties.title).toBe("My title");
  });

  it("refuses to promote an item that is already yours", async () => {
    const own = await request(ctx.app, "POST", "/items", {
      key: memberKey,
      body: { type: "core.note", properties: { body: "mine" } },
    });
    const ownBody = (await own.json()) as { item: { id: string } };
    const res = await request(
      ctx.app,
      "POST",
      `/items/${ownBody.item.id}/promote`,
      { key: memberKey },
    );
    expect(res.status).toBe(400);
  });

  it("leaves items outside integration provenance untouched by the rule", async () => {
    // Sync's items arrive under a client credential with no integration
    // provenance, so this is also the D43 exemption, structurally.
    const own = await request(ctx.app, "POST", "/items", {
      key: memberKey,
      body: { type: "core.note", properties: { body: "client-owned" } },
    });
    const ownBody = (await own.json()) as { item: { id: string } };
    const edit = await request(ctx.app, "PATCH", `/items/${ownBody.item.id}`, {
      key: memberKey,
      body: { properties: { body: "edited freely" } },
    });
    expect(edit.status).toBe(200);
  });

  it("still allows lifecycle transitions on a mirror — trashing is not editing the copy", async () => {
    const id = await createMirror(`m-${String(Math.random()).slice(2)}`);
    const del = await request(ctx.app, "DELETE", `/items/${id}`, {
      key: memberKey,
    });
    expect(del.status).toBe(200);
  });
});
