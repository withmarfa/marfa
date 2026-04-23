import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  ctx.cleanup();
});

async function seed(
  type: string,
  count: number,
  extras?: Record<string, unknown>,
): Promise<string[]> {
  const ids: string[] = [];
  const suffix = Math.random().toString(36).slice(2, 8);
  for (let i = 0; i < count; i++) {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type,
        properties: {
          body: `seed-${suffix}-${String(i)}`,
          ...(extras?.properties as object),
        },
        source_id: `seed-${suffix}-${String(i)}`,
        ...(extras?.tags !== undefined && { tags: extras.tags }),
        ...(extras?.library !== undefined && { library: extras.library }),
      },
    });
    const body = (await res.json()) as { item: { id: string } };
    ids.push(body.item.id);
  }
  return ids;
}

describe("POST /items/bulk_action", () => {
  it("dry_run returns matched ids without mutating", async () => {
    const tag = `dryrun-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await seed("core.note", 3, { tags: [tag] });

    const res = await request(ctx.app, "POST", "/items/bulk_action", {
      key: ctx.adminKey,
      body: {
        action: "transition",
        state: "archived",
        filter: { type: "core.note", tags: [tag] },
        dry_run: true,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      matched: number;
      succeeded: number;
      dry_run: boolean;
      ids?: string[];
    };
    expect(body.dry_run).toBe(true);
    expect(body.matched).toBe(3);
    expect(body.succeeded).toBe(0);
    expect(body.ids?.sort()).toEqual(ids.slice().sort());

    // Confirm no state change happened
    const getRes = await request(ctx.app, "GET", `/items/${ids[0]!}`, {
      key: ctx.adminKey,
    });
    const item = (await getRes.json()) as { item: { state: string } };
    expect(item.item.state).toBe("active");
  });

  it("transition action archives every match", async () => {
    const tag = `trans-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await seed("core.note", 3, { tags: [tag] });

    const res = await request(ctx.app, "POST", "/items/bulk_action", {
      key: ctx.adminKey,
      body: {
        action: "transition",
        state: "archived",
        filter: { tags: [tag] },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      succeeded: number;
      errored: number;
    };
    expect(body.succeeded).toBe(3);
    expect(body.errored).toBe(0);

    const getRes = await request(ctx.app, "GET", `/items/${ids[0]!}`, {
      key: ctx.adminKey,
    });
    const item = (await getRes.json()) as { item: { state: string } };
    expect(item.item.state).toBe("archived");
  });

  it("purge action requires confirm=PURGE", async () => {
    const tag = `purge-confirm-${Math.random().toString(36).slice(2, 8)}`;
    await seed("core.note", 1, { tags: [tag] });

    const res = await request(ctx.app, "POST", "/items/bulk_action", {
      key: ctx.adminKey,
      body: {
        action: "purge",
        filter: { tags: [tag] },
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bulk_confirmation_required");
  });

  it("purge action deletes matching items (with confirm)", async () => {
    const tag = `purge-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await seed("core.note", 3, { tags: [tag] });

    const res = await request(ctx.app, "POST", "/items/bulk_action", {
      key: ctx.adminKey,
      body: {
        action: "purge",
        confirm: "PURGE",
        filter: { tags: [tag] },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      succeeded: number;
      blob_hashes_referenced?: number;
    };
    expect(body.succeeded).toBe(3);
    expect(body.blob_hashes_referenced).toBeDefined();

    const getRes = await request(ctx.app, "GET", `/items/${ids[0]!}`, {
      key: ctx.adminKey,
    });
    expect(getRes.status).toBe(404);
  });

  it("purge action refuses non-admin (hard 403)", async () => {
    const rawKey = `myme_k1_member_${Math.random().toString(36).slice(2)}`;
    const keyHash = hashApiKey(rawKey, "test-salt");
    await ctx.storage.keys.create(
      {
        label: "purge-member",
        source: `purge-member-${rawKey.slice(-6)}`,
        role: "member",
        type_permissions: { "*": "write" },
      },
      keyHash,
    );

    const res = await request(ctx.app, "POST", "/items/bulk_action", {
      key: rawKey,
      body: {
        action: "purge",
        confirm: "PURGE",
        filter: { type: "core.note" },
      },
    });
    expect(res.status).toBe(403);
  });

  it("update_tags adds and removes", async () => {
    const tag = `tags-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await seed("core.note", 2, { tags: [tag] });

    const res = await request(ctx.app, "POST", "/items/bulk_action", {
      key: ctx.adminKey,
      body: {
        action: "update_tags",
        add: ["added-tag"],
        remove: [tag],
        filter: { tags: [tag] },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { succeeded: number };
    expect(body.succeeded).toBe(2);

    const mdRes = await request(ctx.app, "GET", `/items/${ids[0]!}/metadata`, {
      key: ctx.adminKey,
    });
    const mdBody = (await mdRes.json()) as {
      metadata: { tags: string[] };
    };
    expect(mdBody.metadata.tags).toContain("added-tag");
    expect(mdBody.metadata.tags).not.toContain(tag);
  });

  it("update_tags rejects empty add AND remove", async () => {
    const res = await request(ctx.app, "POST", "/items/bulk_action", {
      key: ctx.adminKey,
      body: {
        action: "update_tags",
        filter: { type: "core.note" },
      },
    });
    expect(res.status).toBe(400);
  });

  it("update_library flips the library flag", async () => {
    const tag = `lib-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await seed("core.note", 2, { tags: [tag], library: false });

    const res = await request(ctx.app, "POST", "/items/bulk_action", {
      key: ctx.adminKey,
      body: {
        action: "update_library",
        library: true,
        filter: { tags: [tag] },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { succeeded: number };
    expect(body.succeeded).toBe(2);

    const getRes = await request(ctx.app, "GET", `/items/${ids[0]!}`, {
      key: ctx.adminKey,
    });
    const item = (await getRes.json()) as { item: { library: boolean } };
    expect(item.item.library).toBe(true);
  });

  it("update_properties shallow-merges", async () => {
    const tag = `props-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await seed("core.note", 2, { tags: [tag] });

    const res = await request(ctx.app, "POST", "/items/bulk_action", {
      key: ctx.adminKey,
      body: {
        action: "update_properties",
        patch: { extra_field: "patched" },
        filter: { tags: [tag] },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { succeeded: number };
    expect(body.succeeded).toBe(2);

    const getRes = await request(ctx.app, "GET", `/items/${ids[0]!}`, {
      key: ctx.adminKey,
    });
    const item = (await getRes.json()) as {
      item: { properties: Record<string, unknown> };
    };
    expect(item.item.properties.extra_field).toBe("patched");
    // Original field still present (shallow merge)
    expect(item.item.properties.body).toBeDefined();
  });

  it("update_timestamp changes the user-meaningful timestamp", async () => {
    const tag = `ts-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await seed("core.note", 1, { tags: [tag] });
    const newTs = "2020-01-01T00:00:00.000Z";

    const res = await request(ctx.app, "POST", "/items/bulk_action", {
      key: ctx.adminKey,
      body: {
        action: "update_timestamp",
        timestamp: newTs,
        filter: { tags: [tag] },
      },
    });
    expect(res.status).toBe(200);

    const getRes = await request(ctx.app, "GET", `/items/${ids[0]!}`, {
      key: ctx.adminKey,
    });
    const item = (await getRes.json()) as { item: { timestamp: string } };
    expect(item.item.timestamp).toBe(newTs);
  });

  it("update_timestamp rejects non-ISO strings", async () => {
    const res = await request(ctx.app, "POST", "/items/bulk_action", {
      key: ctx.adminKey,
      body: {
        action: "update_timestamp",
        timestamp: "not a date",
        filter: { type: "core.note" },
      },
    });
    expect(res.status).toBe(400);
  });

  it("max_items cap exceeded returns 400 bulk_cap_exceeded", async () => {
    const tag = `cap-${Math.random().toString(36).slice(2, 8)}`;
    await seed("core.note", 5, { tags: [tag] });

    const res = await request(ctx.app, "POST", "/items/bulk_action", {
      key: ctx.adminKey,
      body: {
        action: "transition",
        state: "archived",
        filter: { tags: [tag] },
        max_items: 2,
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { matched: number; cap: number } };
    };
    expect(body.error.code).toBe("bulk_cap_exceeded");
    expect(body.error.details?.cap).toBe(2);
  });

  it("filter grammar reuses the full DSL", async () => {
    // Exercise a moderately rich filter: type + tag + filter-DSL expression
    const tag = `dsl-${Math.random().toString(36).slice(2, 8)}`;
    const ids = await seed("core.note", 3, {
      tags: [tag],
      properties: { body: "dsl-body" },
    });

    const res = await request(ctx.app, "POST", "/items/bulk_action", {
      key: ctx.adminKey,
      body: {
        action: "transition",
        state: "archived",
        filter: {
          type: "core.note",
          tags: [tag],
          filter: 'properties.body eq "dsl-body"',
        },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { succeeded: number };
    expect(body.succeeded).toBe(3);

    // Verify
    const getRes = await request(ctx.app, "GET", `/items/${ids[0]!}`, {
      key: ctx.adminKey,
    });
    const item = (await getRes.json()) as { item: { state: string } };
    expect(item.item.state).toBe("archived");
  });

  it("writes one aggregate audit entry", async () => {
    const tag = `audit-${Math.random().toString(36).slice(2, 8)}`;
    await seed("core.note", 3, { tags: [tag] });

    await request(ctx.app, "POST", "/items/bulk_action", {
      key: ctx.adminKey,
      body: {
        action: "transition",
        state: "archived",
        filter: { tags: [tag] },
      },
    });

    const auditRes = await request(
      ctx.app,
      "GET",
      "/audit?action=items.bulk_action&limit=50",
      { key: ctx.adminKey },
    );
    const auditBody = (await auditRes.json()) as {
      data: {
        action: string;
        resource_type: string;
        details?: Record<string, unknown>;
      }[];
    };
    const mine = auditBody.data.find(
      (e) =>
        (e.details as { sub_action?: string } | undefined)?.sub_action ===
          "transition" &&
        (e.details as { matched?: number } | undefined)?.matched === 3,
    );
    expect(mine).toBeDefined();
    expect(mine?.resource_type).toBe("items.bulk_action");
  });
});
