/**
 * D32's one rule at the wire: nothing writes to an item an integration
 * owns. The owning integration re-syncs its mirror (with faithful-mirror
 * null semantics); everyone else — member and platform admin alike — is
 * refused toward promotion, which mints a user-owned copy joined by
 * derived-from. Items outside integration provenance are untouched by
 * the rule, which is also what keeps sync (a client, not an integration)
 * unaffected.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;
let ownerKey: string;
let memberKey: string;

const MIRROR_SOURCE = "integration:acme.mirror";

beforeAll(async () => {
  ctx = await createTestContext();

  ownerKey = `marfa_k1_mirror_owner_${String(Math.random()).slice(2)}`;
  await ctx.storage.keys.createRuntimeCredential(
    {
      label: "mirror-owner",
      source: `mirror-owner-${String(Math.random()).slice(2)}`,
      type_permissions: { "core.bookmark": "write" },
      connection_id: "conn_mirror_rule",
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      item_source: MIRROR_SOURCE,
    },
    hashApiKey(ownerKey, "test-salt"),
    undefined,
  );

  const memberRes = await request(ctx.app, "POST", "/keys", {
    key: ctx.adminKey,
    body: {
      label: "mirror-member",
      source: "mirror-member-src",
      role: "member",
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
    },
  });
  ({ key: memberKey } = (await memberRes.json()) as { key: string });
});

afterAll(async () => {
  await ctx.cleanup();
});

async function createMirror(sourceId: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ownerKey,
    body: {
      type: "core.bookmark",
      source_id: sourceId,
      properties: {
        title: "Mirrored",
        url: "https://upstream.example/a",
        body: "as synced",
      },
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
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

  it("refuses a platform admin too — one rule, not two", async () => {
    const id = await createMirror(`m-${String(Math.random()).slice(2)}`);
    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.adminKey,
      body: { properties: { title: "admin edit" } },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("integration_owned");
  });

  it("lets the owning integration re-sync, with nulls clearing keys", async () => {
    const sourceId = `m-${String(Math.random()).slice(2)}`;
    const id = await createMirror(sourceId);

    const resync = await request(ctx.app, "POST", "/items", {
      key: ownerKey,
      body: {
        type: "core.bookmark",
        source_id: sourceId,
        properties: { title: "Renamed upstream", body: null },
      },
    });
    expect(resync.status).toBe(200);

    const after = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.adminKey,
    });
    const afterBody = (await after.json()) as {
      item: { properties: Record<string, unknown> };
    };
    expect(afterBody.item.properties.title).toBe("Renamed upstream");
    // The upstream cleared the field; the faithful mirror clears it too.
    expect("body" in afterBody.item.properties).toBe(false);
    expect(afterBody.item.properties.url).toBe("https://upstream.example/a");
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
        key: ctx.adminKey,
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

    const resync = await request(ctx.app, "POST", "/items", {
      key: ownerKey,
      body: {
        type: "core.bookmark",
        source_id: sourceId,
        properties: { title: "Upstream renamed again" },
      },
    });
    expect(resync.status).toBe(200);

    const promotedAfter = await request(
      ctx.app,
      "GET",
      `/items/${promotedBody.item.id}`,
      { key: ctx.adminKey },
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
